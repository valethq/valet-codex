import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ToolSurface } from "@valethq/sdk";
import { createGate, decide, GATE_TOKEN_ENV, type GateTarget } from "../src/gate";
import { httpHost } from "./helpers";

const surface = (authorize: ToolSurface["authorize"]): ToolSurface => ({
  list: () => [],
  call: async () => ({ content: [] }),
  authorize,
});

function target(authorize: ToolSurface["authorize"] = async (_n, i) => ({ input: i }), deny: string[] = []) {
  const denied: unknown[] = [];
  const t: GateTarget = {
    tools: surface(authorize),
    denyTools: () => deny,
    isValetTool: (n) => n === "valet__exec",
    denied: (c) => denied.push(c),
  };
  return { t, denied };
}

const hook = (tool_name: string, tool_input: unknown = { command: "ls" }) => ({
  session_id: "thr_1",
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
  tool_use_id: "call_1",
});
const denial = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

test("an allowed call passes unchanged and valet's own tools skip the gate", async () => {
  let asked = 0;
  const { t } = target(async (_n, i) => {
    asked++;
    return { input: i };
  });
  expect(await decide(hook("Bash"), t)).toEqual({});
  expect(await decide(hook("valet__exec"), t)).toEqual({});
  expect(asked).toBe(1);
});

test("denyTools and a policy denial block the call and report it", async () => {
  const { t, denied } = target(async () => ({ denied: "not today" }), ["apply_patch"]);
  expect(await decide(hook("apply_patch"), t)).toEqual(denial("apply_patch is disabled in valet"));
  expect(await decide(hook("Bash"), t)).toEqual(denial("not today"));
  expect(denied).toEqual([
    {
      callId: "call_1",
      name: "apply_patch",
      input: { command: "ls" },
      reason: "apply_patch is disabled in valet",
    },
    { callId: "call_1", name: "Bash", input: { command: "ls" }, reason: "not today" },
  ]);
});

test("a rewrite becomes updatedInput; bad rewrites are refused", async () => {
  const rewrite = (input: unknown) => target(async () => ({ input })).t;
  expect(await decide(hook("Bash"), rewrite({ command: "ls -a" }))).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "ls -a" },
    },
  });
  expect(await decide(hook("Bash"), rewrite("ls"))).toEqual(
    denial("a policy hook rewrote the input to a non-object"),
  );
  expect(await decide(hook("Bash"), rewrite({ cmd: "ls" }))).toEqual(
    denial("a policy hook rewrote the input without a string command"),
  );
  expect(await decide(hook("update_plan", {}), rewrite({ plan: [] }))).toMatchObject({
    hookSpecificOutput: { updatedInput: { plan: [] } },
  });
});

test("unknown threads are denied; other hook events pass", async () => {
  expect(await decide(hook("Bash"), undefined)).toEqual(denial("valet does not know this Codex thread"));
  expect(await decide({ hook_event_name: "PostToolUse" }, undefined)).toEqual({});
});

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

async function runHook(command: string, body: unknown, token: string) {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdin: new Blob([JSON.stringify(body)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [GATE_TOKEN_ENV]: token },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

test("the hook script asks the route and prints its verdict", async () => {
  const http = httpHost();
  stop = http.stop;
  const gate = createGate(http.host);
  gate.register("thr_1", target(async () => ({ denied: "nope" })).t);
  const denied = await runHook(gate.command, hook("Bash"), gate.token);
  expect(denied.code).toBe(0);
  expect(JSON.parse(denied.out)).toEqual(denial("nope"));
  gate.register("thr_1", target().t);
  expect(await runHook(gate.command, hook("Bash"), gate.token)).toEqual({ out: "", err: "", code: 0 });
});

test("the hook script fails closed: bad token or no valet means exit 2", async () => {
  const http = httpHost();
  const gate = createGate(http.host);
  gate.register("thr_1", target().t);
  const bad = await runHook(gate.command, hook("Bash"), "wrong");
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("HTTP 401");
  http.stop();
  const down = await runHook(gate.command, hook("Bash"), gate.token);
  expect(down.code).toBe(2);
  expect(down.err).toContain("valet's tool gate failed");
});

test("the hook command quotes paths with spaces and quotes", () => {
  const http = httpHost();
  stop = http.stop;
  const gate = createGate(http.host, "/opt/my bun's/bun");
  expect(
    gate.command.startsWith(
      `'/opt/my bun'\\''s/bun' '${join(import.meta.dir, "..", "src", "gate-hook.ts")}'`,
    ),
  ).toBe(true);
});
