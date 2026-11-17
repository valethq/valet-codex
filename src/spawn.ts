import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Transport } from "./rpc";

export interface SpawnOptions {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  onStderr(line: string): void;
}

export type Spawner = (o: SpawnOptions) => Transport;

/** `codex` on PATH, then the standalone installer's ~/.local/bin/codex. */
export function findCodex(configured?: string): string {
  if (configured) return configured;
  const local = join(homedir(), ".local", "bin", "codex");
  return Bun.which("codex") ?? (existsSync(local) ? local : "codex");
}

async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
      yield buf.slice(0, n);
      buf = buf.slice(n + 1);
    }
  }
  if (buf) yield buf;
}

export const spawnCodex: Spawner = (o) => {
  const proc = Bun.spawn([o.command, ...o.args], {
    cwd: o.cwd,
    env: o.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    for await (const line of linesOf(proc.stderr)) o.onStderr(line);
  })();
  return {
    send(line) {
      proc.stdin.write(`${line}\n`);
      void proc.stdin.flush();
    },
    lines: linesOf(proc.stdout),
    close() {
      try {
        proc.stdin.end();
      } catch {}
      proc.kill();
    },
  };
};
