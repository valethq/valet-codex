import type { AgentEvent, AgentSession, Logger, ModelContent, ToolSpec, ToolSurface } from "@valethq/sdk";
import { Channel } from "./channel";
import {
  type ApprovalPolicy,
  type CodexConfig,
  DEFAULT_IDLE_CLOSE_MS,
  type Effort,
  type Sandbox,
} from "./config";
import { mapCompleted, mapNotification, newTurnState, type TurnState } from "./events";
import type { Gate } from "./gate";
import { type ModelCatalog, resolveModel } from "./models";
import { threadParams, userInput } from "./params";
import { RpcError } from "./rpc";
import { type CodexServer, gateActive, type ThreadListener } from "./server";
import { codexName, toDynamicResponse, valetName } from "./tools";

type Obj = Record<string, unknown>;
/** How long a new turn waits for an abandoned one to acknowledge its interrupt. */
const SETTLE_MS = 15_000;

export interface SessionInit {
  server: CodexServer;
  gate: Gate;
  cwd: string;
  model: string;
  tools: ToolSurface;
  cfg(): CodexConfig;
  /** Read at each thread load, so the settings panel applies without a restart. */
  flags(): { sandbox: Sandbox; approvalPolicy: ApprovalPolicy; hideBuiltinTools: boolean };
  catalog: ModelCatalog;
  log: Logger;
  readBlob(blobId: string): Promise<Uint8Array>;
  /** valet's persona preamble per thread, kept so every start or resume sends the same developer instructions. */
  preamble: { get(threadId: string): string | undefined; set(threadId: string, text: string): void };
  /** The thread id changed because the old one could not be resumed. */
  onThread(threadId: string): void;
  onClose(): void;
}

interface Turn {
  channel: Channel<AgentEvent>;
  state: TurnState;
  aborted: boolean;
  /** turn/interrupt went out; it is sent once. */
  interruptSent: boolean;
  completed: boolean;
  /** Aborts valet tool calls that belong to this turn. */
  tools: AbortController;
  /** Permission prompts still waiting; answered "no" when the turn ends. */
  asks: Set<(allow: boolean) => void>;
  done: Promise<void>;
  finish(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class CodexSession implements AgentSession, ThreadListener {
  private threadId = "";
  private loaded = false;
  /** A turn was sent, so the thread has a rollout and can be resumed. */
  private used = false;
  private persona?: string;
  private pendingPersona?: string;
  private model: string;
  private effort?: Effort;
  private valetNames = new Set<string>();
  private turn?: Turn;
  private idle?: ReturnType<typeof setTimeout>;
  private lastContext?: number;
  private warned = new Set<string>();

  private constructor(private init: SessionInit) {
    const { model, effort } = resolveModel(init.model);
    this.model = model;
    this.effort = effort;
  }

  /** Resumes `resumeId` when Codex still has it, otherwise starts a new thread. */
  static async open(init: SessionInit, resumeId?: string): Promise<CodexSession> {
    const s = new CodexSession(init);
    await s.load(resumeId);
    return s;
  }

  get resumeId(): string {
    return this.threadId;
  }

  private async load(resume: string | undefined, persona?: string): Promise<void> {
    const { server, gate, log } = this.init;
    const conn = await server.connect();
    if (!conn.trust)
      throw new Error("codex did not load valet's tool gate hook, so valet will not start a thread");
    const tools: ToolSpec[] = this.init.tools.list();
    this.valetNames = new Set(tools.map((t) => codexName(t.name)));
    const text = persona ?? (resume ? this.init.preamble.get(resume) : undefined);
    const params = threadParams({
      persona: text,
      cfg: this.init.cfg(),
      cwd: this.init.cwd,
      model: this.model,
      ...this.init.flags(),
      tools,
      gate,
      trust: conn.trust,
    });
    let id: string | undefined;
    if (resume) {
      try {
        const r = await conn.rpc.request<{ thread: { id: string } }>("thread/resume", {
          threadId: resume,
          excludeTurns: true,
          ...params,
        });
        id = r.thread.id;
        this.used = true;
      } catch (e) {
        log.warn("codex thread could not be resumed, starting a new one", {
          resumeId: resume,
          error: message(e),
        });
      }
    }
    if (!id) this.used = false;
    id ??= (await conn.rpc.request<{ thread: { id: string } }>("thread/start", params)).thread.id;
    const changed = this.threadId !== "" && id !== this.threadId;
    this.threadId = id;
    this.loaded = true;
    this.persona = text;
    if (text) this.init.preamble.set(id, text);
    server.attach(id, this);
    gate.register(id, {
      tools: this.init.tools,
      denyTools: () => this.init.cfg().denyTools ?? [],
      isValetTool: (name) => this.valetNames.has(name),
      denied: (call) => this.denied(call),
    });
    const listed = await conn.rpc.request("hooks/list", { threadId: id }).catch(() => undefined);
    if (!gateActive(listed, gate.command)) {
      await this.unload();
      throw new Error("valet's tool gate is not active in the codex thread (hooks disabled or not trusted)");
    }
    if (changed) this.init.onThread(id);
  }

  private async unload(): Promise<void> {
    clearTimeout(this.idle);
    if (!this.threadId) return;
    const wasLoaded = this.loaded;
    this.loaded = false;
    this.init.server.detach(this.threadId);
    if (!wasLoaded) return;
    const conn = await this.init.server.connect().catch(() => undefined);
    await conn?.rpc.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => undefined);
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    const ms = this.init.cfg().idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    if (!ms || !this.loaded || this.turn) return;
    this.idle = setTimeout(() => {
      this.init.log.info("unloading idle codex thread; the next prompt resumes it", {
        thread: this.threadId,
      });
      void this.unload();
    }, ms);
    this.idle.unref?.();
  }

  async setModel(next: string): Promise<void> {
    const { model, effort } = resolveModel(next);
    this.model = model;
    this.effort = effort;
  }

  async close(): Promise<void> {
    const t = this.turn;
    if (t && !t.completed) {
      await this.interrupt(t);
      for (const callId of t.state.openTools)
        t.channel.push({ type: "tool-end", callId, status: "cancelled" });
      t.channel.push({ type: "finish", reason: "cancelled" });
      this.complete(t);
    }
    await this.unload();
    this.init.gate.unregister(this.threadId);
    this.init.onClose();
  }

  /** A notice from outside the turn stream (rate limits); dropped when no turn is running. */
  notice(event: AgentEvent): void {
    const t = this.turn;
    if (t && !t.completed) t.channel.push(event);
  }

  async *prompt(
    input: { content: ModelContent[]; preamble?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    let items: unknown[];
    if (input.preamble) this.pendingPersona = input.preamble;
    try {
      items = await userInput(input.content, this.init.readBlob);
    } catch (e) {
      yield { type: "finish", reason: "error", error: message(e) };
      return;
    }
    const summary = this.init.cfg().reasoningSummary ?? "auto";
    yield* this.run(async (rpc) => {
      const r = await rpc.request("turn/start", {
        threadId: this.threadId,
        input: items,
        model: this.model,
        ...(this.effort && { effort: this.effort }),
        summary,
      });
      this.used = true;
      return r;
    }, signal);
  }

  /** Codex compacts as a turn of its own and reports it as a `contextCompaction` item. */
  compact(instructions: string | undefined, signal: AbortSignal): AsyncIterable<AgentEvent> {
    // spec-gap: Codex's thread/compact/start takes no instructions, so they are dropped.
    if (instructions) this.init.log.debug("codex compaction ignores instructions", { instructions });
    return this.run((rpc) => rpc.request("thread/compact/start", { threadId: this.threadId }), signal);
  }

  private async ensureLoaded() {
    const next = this.pendingPersona;
    this.pendingPersona = undefined;
    if (next && next !== this.persona) {
      // Developer instructions are set when a thread starts or resumes. A thread with no turn has no rollout to
      // resume, so it is replaced; one with turns is resumed with the new text.
      const old = this.threadId;
      await this.unload();
      await this.load(this.used ? old : undefined, next);
      if (this.threadId !== old) this.init.gate.unregister(old);
    } else if (!this.loaded) {
      const before = this.threadId;
      await this.load(this.threadId);
      if (this.threadId !== before)
        this.turn?.channel.push({
          type: "notice",
          level: "warning",
          text: "Codex could not resume its thread, so this turn starts without the earlier context.",
        });
    }
    return (await this.init.server.connect()).rpc;
  }

  /** Waits for an abandoned turn to stop, so its events can't bleed into the next one. */
  private async settle(): Promise<void> {
    const t = this.turn;
    if (!t || t.completed) return;
    await this.interrupt(t);
    await Promise.race([t.done, Bun.sleep(SETTLE_MS)]);
    if (!t.completed) this.complete(t);
  }

  private async interrupt(t: Turn): Promise<void> {
    t.aborted = true;
    t.tools.abort();
    for (const ask of t.asks) ask(false);
    t.asks.clear();
    const turnId = t.state.turnId;
    if (!turnId || !this.loaded || t.interruptSent) return;
    t.interruptSent = true;
    const conn = await this.init.server.connect().catch(() => undefined);
    await conn?.rpc.request("turn/interrupt", { threadId: this.threadId, turnId }).catch(() => undefined);
  }

  private complete(t: Turn): void {
    if (t.completed) return;
    t.completed = true;
    for (const ask of t.asks) ask(false);
    t.asks.clear();
    t.channel.end();
    t.finish();
    if (this.turn === t) this.turn = undefined;
  }

  private async *run(
    start: (rpc: Awaited<ReturnType<CodexSession["ensureLoaded"]>>) => Promise<unknown>,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    clearTimeout(this.idle);
    await this.settle();
    let finish!: () => void;
    const t: Turn = {
      channel: new Channel(),
      state: newTurnState(this.lastContext, this.warned),
      aborted: false,
      interruptSent: false,
      completed: false,
      tools: new AbortController(),
      asks: new Set(),
      done: new Promise<void>((r) => {
        finish = r;
      }),
      finish: () => finish(),
    };
    this.turn = t;
    const abort = () => void this.interrupt(t);
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        const rpc = await this.ensureLoaded();
        if (signal.aborted) {
          this.complete(t);
          yield { type: "finish", reason: "cancelled" };
          return;
        }
        const r = (await start(rpc)) as { turn?: { id?: string } } | undefined;
        t.state.turnId ??= r?.turn?.id;
        if (t.aborted) void this.interrupt(t);
      } catch (e) {
        this.complete(t);
        for await (const ev of t.channel) yield ev;
        yield { type: "finish", reason: "error", error: message(e) };
        return;
      }
      for await (const ev of t.channel) yield ev;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!t.completed) void this.interrupt(t);
      this.armIdle();
    }
  }

  // ---- ThreadListener ----

  notify(method: string, params: Obj): void {
    const t = this.turn;
    if (!t || t.completed) return;
    const turnId = typeof params.turnId === "string" ? params.turnId : (params.turn as Obj | undefined)?.id;
    if (t.state.turnId && typeof turnId === "string" && turnId !== t.state.turnId) return;
    if (method === "turn/completed") {
      for (const ev of mapCompleted(params, t.state, t.aborted)) t.channel.push(ev);
      this.finished(t);
      return;
    }
    for (const ev of mapNotification(method, params, t.state, t.aborted)) t.channel.push(ev);
    if (method === "turn/started" && t.aborted) void this.interrupt(t);
  }

  lost(error: Error): void {
    this.loaded = false;
    const t = this.turn;
    if (!t || t.completed) return;
    for (const callId of t.state.openTools) t.channel.push({ type: "tool-end", callId, status: "error" });
    t.channel.push({ type: "finish", reason: "error", error: `codex app-server stopped: ${error.message}` });
    this.complete(t);
  }

  async request(method: string, params: Obj): Promise<unknown> {
    switch (method) {
      case "item/tool/call":
        return this.callTool(params);
      case "item/commandExecution/requestApproval": {
        const what = typeof params.command === "string" ? params.command : "a command";
        const ok = await this.ask(String(params.itemId), withReason(`Run ${what}`, params.reason));
        return { decision: ok ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const ok = await this.ask(String(params.itemId), withReason("Apply file changes", params.reason));
        return { decision: ok ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval": {
        const ok = await this.ask(
          String(params.itemId),
          withReason("Grant extra permissions", params.reason),
        );
        return { permissions: ok ? granted(params.permissions) : {}, scope: "turn" };
      }
      case "item/tool/requestUserInput":
        // spec-gap: an agent provider has no way to ask the user a question mid-turn, so Codex gets no answers.
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      default:
        throw new RpcError(-32601, `valet does not handle ${method}`);
    }
  }

  private finished(t: Turn): void {
    const st = t.state;
    this.lastContext = st.contextTokens;
    if (st.contextWindow) this.init.catalog.learnWindow(this.model, st.contextWindow);
    const prompt = st.inputTokens;
    this.init.log.info("codex turn", {
      thread: this.threadId,
      model: this.model,
      cache: {
        input: prompt,
        cached: st.cachedTokens,
        output: st.outputTokens,
        hitRatio: prompt ? Math.round((st.cachedTokens / prompt) * 1000) / 1000 : 0,
      },
    });
    this.complete(t);
  }

  private ask(callId: string, title: string): Promise<boolean> {
    const t = this.turn;
    if (!t || t.completed || t.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const respond = (allow: boolean) => {
        if (!t.asks.delete(respond)) return;
        resolve(allow);
      };
      t.asks.add(respond);
      t.channel.push({ type: "permission", request: { callId, title }, respond });
    });
  }

  private async callTool(params: Obj): Promise<unknown> {
    const t = this.turn;
    const tool = String(params.tool ?? "");
    const name = params.namespace ? undefined : valetName(tool);
    if (name === undefined)
      return { contentItems: [{ type: "inputText", text: `unknown tool "${tool}"` }], success: false };
    const signal = t && !t.completed ? t.tools.signal : AbortSignal.abort();
    const result = await this.init.tools.call(name, params.arguments ?? {}, {
      callId: String(params.callId ?? ""),
      signal,
    });
    return toDynamicResponse(result, this.init.readBlob);
  }

  private denied(call: { callId: string; name: string; input: unknown; reason: string }): void {
    const t = this.turn;
    if (!t || t.completed) return;
    const command = (call.input as Obj | undefined)?.command;
    t.channel.push({
      type: "tool-start",
      callId: call.callId,
      name: call.name,
      ...(typeof command === "string" && { title: command.slice(0, 120) }),
      input: call.input,
    });
    t.channel.push({
      type: "tool-end",
      callId: call.callId,
      status: "error",
      output: `Denied: ${call.reason}`,
    });
  }
}

function withReason(title: string, reason: unknown): string {
  return typeof reason === "string" && reason ? `${title} (${reason})` : title;
}

/** Grants exactly what was requested; Codex rejects null members in the reply. */
function granted(requested: unknown): Obj {
  const r = (requested ?? {}) as Obj;
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined));
}
