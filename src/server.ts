import { tmpdir } from "node:os";
import type { Logger } from "@valethq/sdk";
import type { Gate } from "./gate";
import { RpcClient, RpcError } from "./rpc";
import type { SpawnOptions, Spawner } from "./spawn";

type Obj = Record<string, unknown>;
const INIT_TIMEOUT_MS = 30_000;

/** One thread's view of the shared app-server. */
export interface ThreadListener {
  notify(method: string, params: Obj): void;
  request(method: string, params: Obj): Promise<unknown>;
  /** The app-server went away; the thread is no longer loaded. */
  lost(error: Error): void;
}

export interface Connection {
  rpc: RpcClient;
  /** `hooks.state` entry that trusts valet's gate hook, read back from Codex at start. */
  trust?: { key: string; hash: string };
}

export interface ServerInit {
  spawn: Spawner;
  launch(): Omit<SpawnOptions, "onStderr">;
  gate: Gate;
  log: Logger;
  version: string;
  idleCloseMs(): number;
  /** Notifications that belong to no thread, such as `account/rateLimits/updated`. */
  onGlobal(method: string, params: Obj): void;
}

interface HookEntry {
  key?: string;
  command?: string;
  eventName?: string;
  currentHash?: string;
}

/** The `-c` override that defines the gate hook at process level, so `hooks/list` reports its trust hash. */
export function hookArg(command: string): string {
  return `hooks.PreToolUse=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=600}]}]`;
}

/**
 * One `codex app-server` shared by every session, started on first use and stopped after `idleCloseMs`
 * with no thread attached. Notifications and server requests are routed to threads by `threadId`.
 */
export class CodexServer {
  private conn?: Promise<Connection>;
  private listeners = new Map<string, ThreadListener>();
  private idle?: ReturnType<typeof setTimeout>;

  constructor(private init: ServerInit) {}

  connect(): Promise<Connection> {
    clearTimeout(this.idle);
    this.conn ??= this.start().catch((e: unknown) => {
      this.conn = undefined;
      throw e;
    });
    void this.conn.then(
      () => this.armIdle(),
      () => undefined,
    );
    return this.conn;
  }

  attach(threadId: string, listener: ThreadListener): void {
    clearTimeout(this.idle);
    this.listeners.set(threadId, listener);
  }

  detach(threadId: string): void {
    this.listeners.delete(threadId);
    this.armIdle();
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    const conn = await this.conn?.catch(() => undefined);
    this.conn = undefined;
    conn?.rpc.close();
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    const ms = this.init.idleCloseMs();
    if (!ms || this.listeners.size || !this.conn) return;
    this.idle = setTimeout(() => {
      this.init.log.info("stopping idle codex app-server");
      void this.close();
    }, ms);
    this.idle.unref?.();
  }

  private async start(): Promise<Connection> {
    const { log, gate } = this.init;
    const launch = this.init.launch();
    const transport = this.init.spawn({
      ...launch,
      args: [...launch.args, "-c", hookArg(gate.command)],
      onStderr: (line) => log.debug("codex stderr", { line }),
    });
    const rpc = new RpcClient(
      transport,
      (method, params) => this.notify(method, params),
      (method, params) => this.request(method, params),
    );
    void rpc.closed.then((error) => this.lost(rpc, error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const failed = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("codex app-server did not initialize")), INIT_TIMEOUT_MS);
        void rpc.closed.then(reject);
      });
      await Promise.race([
        rpc.request("initialize", {
          clientInfo: { name: "valet", title: "valet", version: this.init.version },
          capabilities: { experimentalApi: true },
        }),
        failed,
      ]);
      rpc.notify("initialized");
      const listed = await Promise.race([rpc.request("hooks/list", { cwds: [tmpdir()] }), failed]);
      const trust = gateTrust(listed, gate.command);
      if (!trust) log.warn("codex did not report valet's gate hook; sessions will refuse to start");
      log.info("codex app-server started", { command: launch.command });
      return { rpc, ...(trust && { trust }) };
    } catch (e) {
      rpc.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private lost(rpc: RpcClient, error: Error): void {
    void this.conn?.then(
      (c) => {
        if (c.rpc !== rpc) return;
        this.conn = undefined;
        const listeners = [...this.listeners.values()];
        this.listeners.clear();
        for (const l of listeners) l.lost(error);
      },
      () => undefined,
    );
  }

  private notify(method: string, params: Obj): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId === undefined) this.init.onGlobal(method, params);
    else this.listeners.get(threadId)?.notify(method, params);
  }

  private request(method: string, params: Obj): Promise<unknown> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const l = this.listeners.get(threadId);
    if (!l) return Promise.reject(new RpcError(-32601, `valet does not handle ${method} here`));
    return l.request(method, params);
  }
}

/** Finds valet's hook in a `hooks/list` reply. */
export function gateTrust(listed: unknown, command: string): { key: string; hash: string } | undefined {
  const data = (listed as { data?: { hooks?: HookEntry[] }[] } | undefined)?.data ?? [];
  for (const entry of data)
    for (const h of entry.hooks ?? [])
      if (h.command === command && h.eventName === "preToolUse" && h.key && h.currentHash)
        return { key: h.key, hash: h.currentHash };
  return undefined;
}

/** Whether a thread's `hooks/list` shows valet's gate hook enabled and trusted. */
export function gateActive(listed: unknown, command: string): boolean {
  const data = (
    listed as { data?: { hooks?: (HookEntry & { enabled?: boolean; trustStatus?: string })[] }[] }
  )?.data;
  return (data ?? []).some((e) =>
    (e.hooks ?? []).some(
      (h) =>
        h.command === command &&
        h.eventName === "preToolUse" &&
        h.enabled !== false &&
        (h.trustStatus === "trusted" || h.trustStatus === "managed"),
    ),
  );
}
