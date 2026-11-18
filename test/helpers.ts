import type {
  AgentEvent,
  AgentProvider,
  HttpHost,
  PluginContext,
  RouteHandler,
  ToolSurface,
} from "@valethq/sdk";
import type { CodexConfig } from "../src/config";
import { createProvider } from "../src/provider";
import type { Spawner } from "../src/spawn";

/** A real HTTP host on a free port, so Codex's gate hook can reach the plugin's routes. */
export function httpHost() {
  const routes = new Map<string, RouteHandler>();
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/plugins\/valet-codex/, "");
      const handler = routes.get(`${req.method} ${path}`);
      if (!handler) return new Response("not found", { status: 404 });
      return handler(req, { caller: { kind: "anonymous" }, principal: undefined, params: {}, url } as never);
    },
  });
  const host: HttpHost = {
    route(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
      return { dispose: () => routes.delete(`${method} ${path}`) };
    },
    url: (path) => `http://127.0.0.1:${server.port}/plugins/valet-codex${path}`,
  };
  return { host, stop: () => server.stop(true) };
}

export function fakeCtx(config: CodexConfig, spawn?: Spawner, blobs: Record<string, string> = {}) {
  const state: Record<string, unknown> = {};
  const kv = new Map<string, unknown>();
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    logs.push({ level, msg, data });
  const http = httpHost();
  let current = config;
  const ctx = {
    get config() {
      return current;
    },
    plugin: { version: "0.1.0" },
    paths: { cache: "/tmp", data: "/tmp", valetHome: "/tmp" },
    http: http.host,
    log: { debug: logger("debug"), info: logger("info"), warn: logger("warn"), error: logger("error") },
    storage: {
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
      },
    },
    store: {
      sessions: {
        get: () => ({ projectId: "p1" }),
        setProviderState: (id: string, provider: string, s: unknown) => {
          state[`${id}:${provider}`] = s;
        },
      },
      projects: { get: () => ({ workspaceDir: "/tmp" }) },
      blobs: {
        path: (id: string) => {
          const p = blobs[id];
          if (p === undefined) throw new Error(`unknown blob "${id}"`);
          return p;
        },
      },
    },
  } as unknown as PluginContext<CodexConfig>;
  const p = createProvider(ctx, spawn);
  return {
    provider: p.provider as AgentProvider,
    usage: p.usage,
    state,
    logs,
    kv,
    ctx,
    /** What core does on a settings save: the new block replaces ctx.config. */
    setConfig: (patch: Partial<CodexConfig>) => {
      current = { ...current, ...patch };
    },
    dispose: async () => {
      await p.dispose();
      http.stop();
    },
  };
}

export async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of it) {
    if (e.type === "permission") e.respond(true);
    events.push(e);
  }
  return events;
}

export const input = (t: string, preamble?: string) => ({
  content: [{ type: "text" as const, text: t }],
  ...(preamble && { preamble }),
});

export const noTools: ToolSurface = {
  list: () => [],
  call: async () => ({ content: [] }),
  authorize: async (_name, input) => ({ input }),
};

export const open = (h: ReturnType<typeof fakeCtx>, extra: Record<string, unknown> = {}) =>
  h.provider.open({
    sessionId: "s1",
    cwd: "/tmp",
    model: "gpt-6.1-sol",
    effort: "high",
    tools: noTools,
    signal: new AbortController().signal,
    ...extra,
  });

export const textOf = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
