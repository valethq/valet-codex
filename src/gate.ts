import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { HttpHost, ToolSurface } from "@valethq/sdk";

export const GATE_TOKEN_ENV = "VALET_CODEX_GATE_TOKEN";
/** Codex's own default; a policy hook that asks a person can take a while. */
const HOOK_TIMEOUT_SEC = 600;

/** What the gate needs to know about the thread a hook fired in. */
export interface GateTarget {
  tools: ToolSurface;
  denyTools(): string[];
  /** True for valet's own tools, which ToolSurface.call already gates. */
  isValetTool(name: string): boolean;
  /** A denied call never becomes a Codex item, so the session reports it itself. */
  denied(call: { callId: string; name: string; input: unknown; reason: string }): void;
}

export interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
}

type HookOutput = Record<string, unknown>;

const deny = (reason: string): HookOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

/** Shell and patch rewrites must keep the `command` string Codex executes. */
const COMMAND_TOOLS = new Set(["Bash", "apply_patch"]);

/** Runs valet's `tool.call` gate for one Codex PreToolUse hook. `{}` lets the call run unchanged. */
export async function decide(input: HookInput, target: GateTarget | undefined): Promise<HookOutput> {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (!target) return deny("valet does not know this Codex thread");
  const name = input.tool_name ?? "";
  if (target.isValetTool(name)) return {};
  const callId = input.tool_use_id ?? "";
  const refuse = (reason: string) => {
    target.denied({ callId, name, input: input.tool_input, reason });
    return deny(reason);
  };
  if (target.denyTools().includes(name)) return refuse(`${name} is disabled in valet`);
  const verdict = await target.tools.authorize(name, input.tool_input, { callId });
  if ("denied" in verdict) return refuse(verdict.denied);
  if (JSON.stringify(verdict.input) === JSON.stringify(input.tool_input)) return {};
  const next = verdict.input;
  if (typeof next !== "object" || next === null || Array.isArray(next))
    return refuse("a policy hook rewrote the input to a non-object");
  if (COMMAND_TOOLS.has(name) && typeof (next as Record<string, unknown>).command !== "string")
    return refuse("a policy hook rewrote the input without a string command");
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: next },
  };
}

export interface Gate {
  readonly token: string;
  /** The hook command Codex runs; also what identifies valet's hook in `hooks/list`. */
  readonly command: string;
  /** The `hooks` config table that installs the hook. */
  hooks(trust?: { key: string; hash: string }): Record<string, unknown>;
  register(threadId: string, target: GateTarget): void;
  unregister(threadId: string): void;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function createGate(http: HttpHost, runtime = process.execPath): Gate {
  const token = randomUUID();
  const want = Buffer.from(`Bearer ${token}`);
  const threads = new Map<string, GateTarget>();
  const script = join(import.meta.dir, "gate-hook.ts");
  const command = [runtime, script, http.url("/gate")].map(shellQuote).join(" ");
  http.route(
    "POST",
    "/gate",
    async (req) => {
      const got = Buffer.from(req.headers.get("authorization") ?? "");
      if (got.length !== want.length || !timingSafeEqual(got, want))
        return Response.json({ error: "bad gate token" }, { status: 401 });
      const input = (await req.json().catch(() => ({}))) as HookInput;
      return Response.json(await decide(input, threads.get(input.session_id ?? "")));
    },
    { public: true },
  );
  return {
    token,
    command,
    hooks: (trust) => ({
      PreToolUse: [{ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SEC }] }],
      ...(trust && { state: { [trust.key]: { trusted_hash: trust.hash } } }),
    }),
    register: (id, target) => void threads.set(id, target),
    unregister: (id) => void threads.delete(id),
  };
}
