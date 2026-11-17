/** A line-oriented duplex to one `codex app-server` (stdio JSONL). Tests substitute a fake. */
export interface Transport {
  send(line: string): void;
  readonly lines: AsyncIterable<string>;
  close(): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;
type Pending = { resolve(v: unknown): void; reject(e: Error): void };
export type NotificationHandler = (method: string, params: Obj) => void;
export type RequestHandler = (method: string, params: Obj) => Promise<unknown>;

/** JSON-RPC 2.0 as app-server speaks it: the "jsonrpc" header is omitted on the wire. */
export class RpcClient {
  private next = 0;
  private pending = new Map<number, Pending>();
  private closedWith?: Error;
  readonly closed: Promise<Error>;

  constructor(
    private transport: Transport,
    private onNotification: NotificationHandler,
    private onRequest: RequestHandler,
  ) {
    this.closed = this.read();
  }

  request<T = Obj>(method: string, params: unknown = {}): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.closedWith) this.write({ method, params });
  }

  close(): void {
    this.transport.close();
  }

  private write(m: Obj): void {
    try {
      this.transport.send(JSON.stringify(m));
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async read(): Promise<Error> {
    try {
      for await (const line of this.transport.lines) {
        if (!line.trim()) continue;
        let m: Obj;
        try {
          m = JSON.parse(line) as Obj;
        } catch {
          continue;
        }
        this.dispatch(m);
      }
      return this.fail(new Error("codex app-server exited"));
    } catch (e) {
      return this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private dispatch(m: Obj): void {
    const method = typeof m.method === "string" ? m.method : undefined;
    const id = m.id as number | string | undefined;
    if (method === undefined && typeof id === "number") {
      const p = this.pending.get(id);
      this.pending.delete(id);
      const err = m.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (err) p?.reject(new RpcError(err.code ?? -32603, err.message ?? "codex error", err.data));
      else p?.resolve(m.result);
      return;
    }
    if (method === undefined) return;
    const params = (m.params ?? {}) as Obj;
    if (id === undefined) {
      this.onNotification(method, params);
      return;
    }
    this.onRequest(method, params).then(
      (result) => this.write({ id, result }),
      (e: unknown) => {
        const code = e instanceof RpcError ? e.code : -32603;
        this.write({ id, error: { code, message: e instanceof Error ? e.message : String(e) } });
      },
    );
  }

  private fail(e: Error): Error {
    this.closedWith ??= e;
    for (const p of this.pending.values()) p.reject(this.closedWith);
    this.pending.clear();
    return this.closedWith;
  }
}
