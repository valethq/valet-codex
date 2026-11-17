import { tmpdir } from "node:os";
import type { AgentProvider, AgentSession, PluginContext } from "@valethq/sdk";
import { type CodexConfig, DEFAULT_IDLE_CLOSE_MS } from "./config";
import { createGate, GATE_TOKEN_ENV } from "./gate";
import { createCatalog } from "./models";
import { CodexServer } from "./server";
import { CodexSession } from "./session";
import { approvalPolicy, hideBuiltinTools, minRateLimitNoticePercent, sandbox } from "./settings";
import { findCodex, type Spawner, spawnCodex } from "./spawn";
import { createRateNotices, createUsage, type UsageService } from "./usage";
import { createUtility } from "./utility";

export const PROVIDER_KEY = "codex";

export interface Provider {
  provider: AgentProvider;
  usage: UsageService;
  dispose(): Promise<void>;
}

export function createProvider(ctx: PluginContext<CodexConfig>, spawn: Spawner = spawnCodex): Provider {
  const cfg = () => ctx.config ?? {};
  const sessions = new Set<CodexSession>();
  const gate = createGate(ctx.http);
  const notices = createRateNotices(() => minRateLimitNoticePercent(ctx));
  let usage: UsageService | undefined;
  const server = new CodexServer({
    spawn,
    gate,
    log: ctx.log,
    version: ctx.plugin.version,
    launch: () => ({
      command: findCodex(cfg().codexPath),
      args: ["app-server", ...(cfg().args ?? [])],
      env: { ...process.env, ...cfg().env, [GATE_TOKEN_ENV]: gate.token },
      cwd: tmpdir(),
    }),
    idleCloseMs: () => cfg().idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS,
    onGlobal: (method, params) => {
      if (method !== "account/rateLimits/updated") return;
      usage?.update(params.rateLimits);
      const events = notices(params.rateLimits);
      for (const s of sessions) for (const e of events) s.notice(e);
    },
  });
  usage = createUsage(
    async (method, params) => (await server.connect()).rpc.request(method, params),
    ctx.log,
  );
  const catalog = createCatalog(cfg, async () => (await server.connect()).rpc.request("model/list", {}));
  const provider: AgentProvider = {
    kind: "agent",
    id: PROVIDER_KEY,
    label: "Codex",
    listModels: () => catalog.list(),
    utility: createUtility(ctx, server),
    async open(opts): Promise<AgentSession> {
      const session = ctx.store.sessions.get(opts.sessionId);
      const project = session && ctx.store.projects.get(session.projectId);
      const save = (resumeId: string) =>
        ctx.store.sessions.setProviderState(opts.sessionId, PROVIDER_KEY, { resumeId });
      const codex: CodexSession = await CodexSession.open(
        {
          server,
          gate,
          cwd: project?.workspaceDir ?? opts.cwd,
          model: opts.model,
          tools: opts.tools,
          cfg,
          flags: () => ({
            sandbox: sandbox(ctx),
            approvalPolicy: approvalPolicy(ctx),
            hideBuiltinTools: hideBuiltinTools(ctx),
          }),
          catalog,
          preamble: {
            get: (id) => ctx.storage.kv.get<string>(`preamble:${id}`),
            set: (id, text) => ctx.storage.kv.set(`preamble:${id}`, text),
          },
          log: ctx.log,
          readBlob: (blobId) => Bun.file(ctx.store.blobs.path(blobId)).bytes(),
          onThread: save,
          onClose: () => sessions.delete(codex),
        },
        opts.resumeId,
      );
      sessions.add(codex);
      save(codex.resumeId);
      return codex;
    },
  };
  return {
    provider,
    usage,
    dispose: async () => {
      await Promise.all([...sessions].map((s) => s.close()));
      await server.close();
    },
  };
}
