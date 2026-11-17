import { Channel } from "../src/channel";
import type { SpawnOptions, Spawner } from "../src/spawn";

type Obj = Record<string, unknown>;
export const HASH = "sha256:fake";
const KEY = "/<session-flags>/config.toml:pre_tool_use:0:0";

/** What a turn script can do: send notifications for its thread and ask the client things. */
export interface TurnCtl {
  threadId: string;
  turnId: string;
  params: Obj;
  emit(method: string, params?: Obj): void;
  request(method: string, params?: Obj): Promise<unknown>;
  interrupted(): boolean;
  /** Resolves when the client sends turn/interrupt. */
  onInterrupt: Promise<void>;
}

export type TurnScript = (ctl: TurnCtl) => Promise<void>;

/** Plain text turn: deltas, the completed item, token usage, then turn/completed. */
export const say =
  (text: string, opts: { reasoning?: string } = {}): TurnScript =>
  async (c) => {
    if (opts.reasoning) {
      c.emit("item/started", { item: { type: "reasoning", id: "r1", summary: [], content: [] } });
      c.emit("item/reasoning/summaryTextDelta", { itemId: "r1", delta: opts.reasoning, summaryIndex: 0 });
      c.emit("item/completed", {
        item: { type: "reasoning", id: "r1", summary: [opts.reasoning], content: [] },
      });
    }
    c.emit("item/started", { item: { type: "agentMessage", id: "m1", text: "" } });
    c.emit("item/agentMessage/delta", { itemId: "m1", delta: text });
    c.emit("item/completed", { item: { type: "agentMessage", id: "m1", text } });
    c.emit("thread/tokenUsage/updated", {
      tokenUsage: {
        last: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 5, totalTokens: 1005 },
        total: {},
        modelContextWindow: 400_000,
      },
    });
    c.emit("turn/completed", { turn: { id: c.turnId, status: "completed", error: null } });
  };

export interface Thread {
  id: string;
  params: Obj;
  loaded: boolean;
}

/** One fake app-server process. */
export class FakeProcess {
  readonly calls: { method: string; params: Obj }[] = [];
  readonly out = new Channel<string>();
  private next = 0;
  private waiting = new Map<number, (v: unknown) => void>();
  private interrupts = new Map<string, () => void>();
  dead = false;

  constructor(
    readonly fake: FakeCodex,
    readonly options: SpawnOptions,
  ) {}

  get hookCommand(): string | undefined {
    const arg = this.options.args.find((a) => a.startsWith("hooks.PreToolUse="));
    const m = arg && /command=("(?:[^"\\]|\\.)*")/.exec(arg);
    return m?.[1] ? (JSON.parse(m[1]) as string) : undefined;
  }

  send(line: string): void {
    if (this.dead) throw new Error("process is dead");
    const m = JSON.parse(line) as { id?: number; method?: string; params?: Obj; result?: unknown };
    if (m.method === undefined) {
      this.waiting.get(m.id as number)?.(m.result ?? m);
      this.waiting.delete(m.id as number);
      return;
    }
    const params = m.params ?? {};
    this.calls.push({ method: m.method, params });
    if (m.id === undefined) return;
    const id = m.id;
    Promise.resolve()
      .then(() => this.handle(m.method as string, params))
      .then(
        (result) => this.write({ id, result }),
        (e: Error) => this.write({ id, error: { code: -32600, message: e.message } }),
      );
  }

  write(m: Obj): void {
    if (!this.dead) this.out.push(JSON.stringify(m));
  }

  kill(): void {
    this.dead = true;
    this.out.end();
  }

  emit(method: string, params: Obj): void {
    this.write({ method, params });
  }

  request(method: string, params: Obj): Promise<unknown> {
    const id = 1000 + this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.write({ id, method, params });
    });
  }

  private trusted(thread: Thread): boolean {
    const config = (thread.params.config ?? {}) as Obj;
    const hooks = (config.hooks ?? {}) as Obj;
    const state = (hooks.state ?? {}) as Record<string, { trusted_hash?: string }>;
    return state[KEY]?.trusted_hash === HASH;
  }

  private async handle(method: string, p: Obj): Promise<unknown> {
    const f = this.fake;
    const custom = f.handlers[method];
    if (custom) return custom(p, this);
    switch (method) {
      case "initialize":
        return { userAgent: "fake" };
      case "hooks/list": {
        if (p.threadId) {
          const t = f.threads.get(String(p.threadId));
          const hooks = (((t?.params.config ?? {}) as Obj).hooks ?? {}) as Obj;
          const defined = Array.isArray(hooks.PreToolUse) && f.hookTrust !== "missing";
          return {
            data: [
              {
                hooks: defined
                  ? [
                      {
                        key: KEY,
                        command: this.hookCommand,
                        eventName: "preToolUse",
                        enabled: true,
                        trustStatus: t && this.trusted(t) && f.hookTrust === "ok" ? "trusted" : "untrusted",
                        currentHash: HASH,
                      },
                    ]
                  : [],
              },
            ],
          };
        }
        return {
          data: [
            {
              hooks: [
                {
                  key: KEY,
                  command: this.hookCommand,
                  eventName: "preToolUse",
                  currentHash: HASH,
                  enabled: true,
                },
              ],
            },
          ],
        };
      }
      case "thread/start": {
        const id = `thr_${++f.threadCount}`;
        f.threads.set(id, { id, params: p, loaded: true });
        return { thread: { id } };
      }
      case "thread/resume": {
        const t = f.threads.get(String(p.threadId));
        if (!t || t.params.ephemeral) throw new Error(`no rollout found for thread id ${String(p.threadId)}`);
        t.params = p;
        t.loaded = true;
        return { thread: { id: t.id } };
      }
      case "thread/unsubscribe": {
        const t = f.threads.get(String(p.threadId));
        if (t) t.loaded = false;
        return { status: "unsubscribed" };
      }
      case "turn/start":
      case "thread/compact/start": {
        const threadId = String(p.threadId);
        if (!f.threads.get(threadId)?.loaded) throw new Error(`thread not loaded: ${threadId}`);
        const turnId = `turn_${++f.turnCount}`;
        const script = method === "turn/start" ? f.script : f.compactScript;
        let fire!: () => void;
        const onInterrupt = new Promise<void>((r) => {
          fire = r;
        });
        let interrupted = false;
        this.interrupts.set(turnId, () => {
          interrupted = true;
          fire();
        });
        const ctl: TurnCtl = {
          threadId,
          turnId,
          params: p,
          emit: (m, params = {}) => this.emit(m, { threadId, turnId, ...params }),
          request: (m, params = {}) => this.request(m, { threadId, turnId, ...params }),
          interrupted: () => interrupted,
          onInterrupt,
        };
        setTimeout(() => {
          ctl.emit("turn/started", { turn: { id: turnId, status: "inProgress" } });
          void script(ctl);
        }, 0);
        return method === "turn/start" ? { turn: { id: turnId, status: "inProgress" } } : {};
      }
      case "turn/interrupt":
        this.interrupts.get(String(p.turnId))?.();
        return {};
      case "model/list":
        return { data: f.models };
      case "account/read":
        return f.account;
      case "account/rateLimits/read":
        return f.rateLimits;
      default:
        throw new Error(`fake codex: unhandled ${method}`);
    }
  }
}

/** A fake `codex app-server` spawner. Threads survive a process restart, like rollouts on disk. */
export class FakeCodex {
  readonly processes: FakeProcess[] = [];
  readonly threads = new Map<string, Thread>();
  threadCount = 0;
  turnCount = 0;
  handlers: Record<string, (p: Obj, proc: FakeProcess) => unknown> = {};
  /** "ok": the gate hook is trusted; "untrusted": trust is not applied; "missing": hooks are disabled. */
  hookTrust: "ok" | "untrusted" | "missing" = "ok";
  models: unknown[] = [];
  account: unknown = { account: null, requiresOpenaiAuth: false };
  rateLimits: unknown = {};
  compactScript: TurnScript = async (c) => {
    c.emit("item/started", { item: { type: "contextCompaction", id: "c1" } });
    c.emit("item/completed", { item: { type: "contextCompaction", id: "c1" } });
    c.emit("turn/completed", { turn: { id: c.turnId, status: "completed" } });
  };

  constructor(public script: TurnScript = say("pong")) {}

  get proc(): FakeProcess {
    const p = this.processes.at(-1);
    if (!p) throw new Error("no process spawned");
    return p;
  }

  calls(method: string): Obj[] {
    return this.processes.flatMap((p) => p.calls.filter((c) => c.method === method).map((c) => c.params));
  }

  readonly spawn: Spawner = (options) => {
    const proc = new FakeProcess(this, options);
    this.processes.push(proc);
    return { send: (l) => proc.send(l), lines: proc.out, close: () => proc.kill() };
  };
}
