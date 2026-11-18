import { afterEach, expect, test } from "bun:test";
import type { AgentEvent, ToolSurface } from "@valethq/sdk";
import { FakeCodex, HASH, say } from "./fake-codex";
import { collect, fakeCtx, input, noTools, open, textOf } from "./helpers";

const ac = () => new AbortController().signal;
const types = (events: AgentEvent[]) => events.map((e) => e.type);
let h: ReturnType<typeof fakeCtx> | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const tools = (over: Partial<ToolSurface> = {}): ToolSurface => ({
  list: () => [
    { name: "exec", description: "Run a command", inputSchema: { type: "object" } },
    { name: "browse", description: "Open a page", inputSchema: { type: "object" } },
  ],
  call: async () => ({ content: [{ type: "text", text: "ok" }] }),
  authorize: async (_n, i) => ({ input: i }),
  ...over,
});

test("open: spawns app-server once, starts a thread with the gate hook trusted", async () => {
  const codex = new FakeCodex();
  h = fakeCtx(
    {
      developerInstructions: "Be brief.",
      config: { model_provider: "x", features: { foo: true } },
      args: ["--x"],
    },
    codex.spawn,
  );
  const s = await open(h, { tools: tools() });
  expect(s.resumeId).toBe("thr_1");
  expect(h.state["s1:codex"]).toEqual({ resumeId: "thr_1" });
  const spawn = codex.proc.options;
  expect(spawn.args.slice(0, 2)).toEqual(["app-server", "--x"]);
  expect(spawn.args.at(-2)).toBe("-c");
  expect(spawn.env.VALET_CODEX_GATE_TOKEN).toMatch(/^[0-9a-f-]{36}$/);
  expect(codex.proc.hookCommand).toContain("gate-hook.ts");
  const init = codex.calls("initialize")[0] as { capabilities: unknown };
  expect(init.capabilities).toEqual({ experimentalApi: true });
  const p = codex.calls("thread/start")[0] as Record<string, unknown>;
  expect(p.cwd).toBe("/tmp");
  expect(p.model).toBe("gpt-6.1-sol");
  expect(p.sandbox).toBe("workspace-write");
  expect(p.approvalPolicy).toBe("on-request");
  expect(p.developerInstructions).toBe("Be brief.");
  expect(p.dynamicTools).toEqual([
    { type: "function", name: "valet__browse", description: "Open a page", inputSchema: { type: "object" } },
    { type: "function", name: "valet__exec", description: "Run a command", inputSchema: { type: "object" } },
  ]);
  const config = p.config as Record<string, Record<string, unknown>>;
  expect(config.model_provider as unknown).toBe("x");
  expect(config.features).toEqual({ foo: true, hooks: true });
  expect(config.hooks?.state).toEqual({
    "/<session-flags>/config.toml:pre_tool_use:0:0": { trusted_hash: HASH },
  });
  expect(JSON.stringify(config.hooks?.PreToolUse)).toContain("gate-hook.ts");
});

test("a thread whose gate hook is not trusted is refused", async () => {
  const codex = new FakeCodex();
  codex.hookTrust = "untrusted";
  h = fakeCtx({}, codex.spawn);
  await expect(open(h)).rejects.toThrow("tool gate is not active");
  expect(codex.calls("thread/unsubscribe")).toHaveLength(1);
});

test("a server that does not report the gate hook refuses to start threads", async () => {
  const codex = new FakeCodex();
  codex.handlers["hooks/list"] = () => ({ data: [{ hooks: [] }] });
  h = fakeCtx({}, codex.spawn);
  await expect(open(h)).rejects.toThrow("did not load valet's tool gate hook");
  expect(codex.calls("thread/start")).toHaveLength(0);
});

test("a turn streams text and reasoning once, then usage and finish", async () => {
  const codex = new FakeCodex(say("pong", { reasoning: "thinking" }));
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const events = await collect(s.prompt(input("hi"), ac()));
  expect(events.filter((e) => e.type === "text-delta")).toEqual([{ type: "text-delta", text: "pong" }]);
  expect(events.filter((e) => e.type === "reasoning-delta")).toEqual([
    { type: "reasoning-delta", text: "thinking" },
  ]);
  expect(events.at(-2)).toEqual({ type: "usage", contextTokens: 1005, inputTokens: 1000, outputTokens: 5 });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  const start = codex.calls("turn/start")[0] as Record<string, unknown>;
  expect(start).toMatchObject({ threadId: "thr_1", model: "gpt-6.1-sol", effort: "high", summary: "auto" });
  expect(start.input).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
  const turn = h.logs.find((l) => l.msg === "codex turn");
  expect(turn?.data?.cache).toEqual({ input: 1000, cached: 800, output: 5, hitRatio: 0.8 });
});

test("text arrives whole when Codex sends no deltas; back-to-back messages get a paragraph break", async () => {
  const codex = new FakeCodex(async (c) => {
    c.emit("item/completed", { item: { type: "agentMessage", id: "a", text: "one" } });
    c.emit("item/completed", { item: { type: "agentMessage", id: "b", text: "two" } });
    c.emit("turn/completed", { turn: { id: c.turnId, status: "completed" } });
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  expect(textOf(await collect(s.prompt(input("hi"), ac())))).toBe("one\n\ntwo");
});

test("images go inline and text stays a text item", async () => {
  const codex = new FakeCodex();
  const path = `${import.meta.dir}/fixtures/dot.png`;
  await Bun.write(path, new Uint8Array([137, 80, 78, 71]));
  h = fakeCtx({}, codex.spawn, { img: path });
  const s = await open(h);
  await collect(
    s.prompt(
      {
        content: [
          { type: "text", text: "look" },
          { type: "image", mime: "image/png", blobId: "img" },
        ],
      },
      ac(),
    ),
  );
  expect((codex.calls("turn/start")[0] as { input: unknown }).input).toEqual([
    { type: "text", text: "look", text_elements: [] },
    { type: "image", url: "data:image/png;base64,iVBORw==" },
  ]);
});

test("the preamble becomes the thread's developer instructions, kept for every relaunch", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({ developerInstructions: "Be brief.", idleCloseMs: 0 }, codex.spawn);
  const s = await open(h);
  await collect(s.prompt(input("hi", "## Persona\nHelper"), ac()));
  const starts = codex.calls("thread/start");
  expect(starts).toHaveLength(2);
  expect(starts[0]?.developerInstructions).toBe("Be brief.");
  expect(starts[1]?.developerInstructions).toBe("Be brief.\n\n## Persona\nHelper");
  expect(s.resumeId).toBe("thr_2");
  expect(h.state["s1:codex"]).toEqual({ resumeId: "thr_2" });
  expect(h.kv.get("preamble:thr_2")).toBe("## Persona\nHelper");
  expect((codex.calls("turn/start")[0] as { input: unknown }).input).toEqual([
    { type: "text", text: "hi", text_elements: [] },
  ]);

  await collect(s.prompt(input("again", "## Persona\nHelper"), ac()));
  expect(codex.calls("thread/start")).toHaveLength(2);

  const again = await open(h, { resumeId: "thr_2" });
  await collect(again.prompt(input("after restart"), ac()));
  expect(codex.calls("thread/resume").at(-1)?.developerInstructions).toBe("Be brief.\n\n## Persona\nHelper");
});

test("codex does not load the workspace AGENTS.md unless asked", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({}, codex.spawn);
  await open(h);
  const on = fakeCtx({ loadProjectDocs: true }, codex.spawn);
  await open(on);
  const cfg = (i: number) => (codex.calls("thread/start")[i] as { config: Record<string, unknown> }).config;
  expect(cfg(0).project_doc_max_bytes).toBe(0);
  expect(cfg(1).project_doc_max_bytes).toBeUndefined();
  await on.dispose();
});

test("one app-server serves every session; notifications go to their own thread", async () => {
  const codex = new FakeCodex(async (c) => {
    await Bun.sleep(5);
    await say(c.threadId)(c);
  });
  h = fakeCtx({}, codex.spawn);
  const a = await open(h);
  const b = await open(h, { sessionId: "s2" });
  const [ea, eb] = await Promise.all([
    collect(a.prompt(input("x"), ac())),
    collect(b.prompt(input("y"), ac())),
  ]);
  expect(codex.processes).toHaveLength(1);
  expect(textOf(ea)).toBe("thr_1");
  expect(textOf(eb)).toBe("thr_2");
});

test("resume: a known thread is resumed, an unknown one is replaced", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({}, codex.spawn);
  const first = await open(h);
  await first.close();
  const again = await open(h, { resumeId: first.resumeId });
  expect(again.resumeId).toBe(first.resumeId);
  expect(codex.calls("thread/resume")[0]).toMatchObject({ threadId: "thr_1", excludeTurns: true });
  const lost = await open(h, { sessionId: "s2", resumeId: "thr_gone" });
  expect(lost.resumeId).toBe("thr_2");
  expect(h.logs.some((l) => l.msg.includes("could not be resumed"))).toBe(true);
});

test("Codex items map to tool events", async () => {
  const codex = new FakeCodex(async (c) => {
    const cmd = { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'ls'", cwd: "/w" };
    c.emit("item/started", { item: { ...cmd, status: "inProgress", commandActions: [{ command: "ls" }] } });
    c.emit("item/commandExecution/outputDelta", { itemId: "c1", delta: "a\n" });
    c.emit("item/completed", {
      item: {
        ...cmd,
        status: "completed",
        commandActions: [{ command: "ls" }],
        aggregatedOutput: "a\n",
        exitCode: 0,
      },
    });
    const patch = {
      type: "fileChange",
      id: "p1",
      changes: [{ path: "x.ts", kind: { type: "update" }, diff: "+1" }],
    };
    c.emit("item/started", { item: { ...patch, status: "inProgress" } });
    c.emit("item/completed", { item: { ...patch, status: "failed" } });
    c.emit("item/started", {
      item: { type: "mcpToolCall", id: "m1", server: "gh", tool: "pr", arguments: { url: "u" } },
    });
    c.emit("item/completed", {
      item: {
        type: "mcpToolCall",
        id: "m1",
        server: "gh",
        tool: "pr",
        status: "completed",
        result: { content: [{ type: "text", text: "merged" }] },
      },
    });
    c.emit("item/started", { item: { type: "webSearch", id: "w1", query: "bun" } });
    c.emit("item/completed", { item: { type: "webSearch", id: "w1", query: "bun" } });
    c.emit("turn/completed", { turn: { id: c.turnId, status: "completed" } });
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const events = (await collect(s.prompt(input("go"), ac()))).filter((e) => e.type.startsWith("tool"));
  expect(events).toEqual([
    { type: "tool-start", callId: "c1", name: "Bash", title: "ls", input: { command: "ls", cwd: "/w" } },
    { type: "tool-update", callId: "c1", outputDelta: "a\n" },
    { type: "tool-end", callId: "c1", status: "done", output: "a\n", exitCode: 0 },
    {
      type: "tool-start",
      callId: "p1",
      name: "apply_patch",
      title: "x.ts",
      input: { changes: [{ path: "x.ts", kind: "update" }] },
    },
    { type: "tool-end", callId: "p1", status: "error", output: "+1" },
    { type: "tool-start", callId: "m1", name: "mcp__gh__pr", title: "u", input: { url: "u" } },
    { type: "tool-end", callId: "m1", status: "done", output: "merged" },
    { type: "tool-start", callId: "w1", name: "web_search", title: "bun", input: { query: "bun" } },
    { type: "tool-end", callId: "w1", status: "done" },
  ]);
});

test("valet's tools run through ToolSurface.call; images go back as data URLs", async () => {
  const path = `${import.meta.dir}/fixtures/dot.png`;
  await Bun.write(path, new Uint8Array([1, 2, 3]));
  let reply: unknown;
  const codex = new FakeCodex(async (c) => {
    const item = { type: "dynamicToolCall", id: "d1", tool: "valet__exec", arguments: { command: "ls" } };
    c.emit("item/started", { item: { ...item, status: "inProgress" } });
    reply = await c.request("item/tool/call", {
      callId: "d1",
      namespace: null,
      tool: "valet__exec",
      arguments: { command: "ls" },
    });
    c.emit("item/completed", {
      item: {
        ...item,
        status: "completed",
        contentItems: [{ type: "inputText", text: "out" }],
        success: true,
      },
    });
    c.emit("turn/completed", { turn: { id: c.turnId, status: "completed" } });
  });
  const seen: unknown[] = [];
  h = fakeCtx({}, codex.spawn, { b1: path });
  const s = await open(h, {
    tools: tools({
      call: async (name, i, call) => {
        seen.push([name, i, call.callId]);
        return {
          content: [
            { type: "text", text: "out" },
            { type: "image", mime: "image/png", blobId: "b1" },
          ],
        };
      },
    }),
  });
  const events = await collect(s.prompt(input("go"), ac()));
  expect(seen).toEqual([["exec", { command: "ls" }, "d1"]]);
  expect(reply).toEqual({
    contentItems: [
      { type: "inputText", text: "out" },
      { type: "inputImage", imageUrl: "data:image/png;base64,AQID" },
    ],
    success: true,
  });
  expect(events.find((e) => e.type === "tool-start")).toMatchObject({ name: "exec", title: "ls" });
});

test("approval requests become permission events", async () => {
  const replies: unknown[] = [];
  const codex = new FakeCodex(async (c) => {
    replies.push(
      await c.request("item/commandExecution/requestApproval", {
        itemId: "c1",
        command: "curl x",
        reason: "network",
      }),
    );
    replies.push(await c.request("item/fileChange/requestApproval", { itemId: "p1" }));
    replies.push(
      await c.request("item/permissions/requestApproval", {
        itemId: "q1",
        permissions: { network: { enabled: true }, fileSystem: null },
      }),
    );
    replies.push(await c.request("item/tool/requestUserInput", { itemId: "u1", questions: [] }));
    c.emit("turn/completed", { turn: { id: c.turnId, status: "completed" } });
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const titles: string[] = [];
  let n = 0;
  for await (const e of s.prompt(input("go"), ac()))
    if (e.type === "permission") {
      titles.push(e.request.title);
      e.respond(n++ !== 1);
    }
  expect(titles).toEqual(["Run curl x (network)", "Apply file changes", "Grant extra permissions"]);
  expect(replies).toEqual([
    { decision: "accept" },
    { decision: "decline" },
    { permissions: { network: { enabled: true } }, scope: "turn" },
    { answers: {} },
  ]);
});

test("abort interrupts the turn and closes tools Codex left open", async () => {
  const codex = new FakeCodex(async (c) => {
    c.emit("item/started", {
      item: { type: "commandExecution", id: "c1", command: "sleep 9", status: "inProgress" },
    });
    await c.onInterrupt;
    c.emit("turn/completed", { turn: { id: c.turnId, status: "interrupted" } });
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const ctl = new AbortController();
  const events: AgentEvent[] = [];
  for await (const e of s.prompt(input("go"), ctl.signal)) {
    events.push(e);
    if (e.type === "tool-start") ctl.abort();
  }
  expect(codex.calls("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }]);
  expect(events.slice(-3)).toEqual([
    { type: "tool-end", callId: "c1", status: "cancelled" },
    { type: "usage", inputTokens: 0, outputTokens: 0 },
    { type: "finish", reason: "cancelled" },
  ]);
});

test("closing a session mid-turn ends the turn as cancelled", async () => {
  const codex = new FakeCodex(async (c) => {
    c.emit("item/started", {
      item: { type: "commandExecution", id: "c1", command: "sleep 9", status: "inProgress" },
    });
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const events: AgentEvent[] = [];
  for await (const e of s.prompt(input("go"), ac())) {
    events.push(e);
    if (e.type === "tool-start") void s.close();
  }
  expect(events.slice(-2)).toEqual([
    { type: "tool-end", callId: "c1", status: "cancelled" },
    { type: "finish", reason: "cancelled" },
  ]);
  expect(codex.calls("turn/interrupt")).toHaveLength(1);
});

test("a prompt that is already aborted starts no turn", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const ctl = new AbortController();
  ctl.abort();
  expect(await collect(s.prompt(input("go"), ctl.signal))).toEqual([{ type: "finish", reason: "cancelled" }]);
  expect(codex.calls("turn/start")).toHaveLength(0);
});

test("an abandoned turn is interrupted before the next one starts", async () => {
  let turns = 0;
  const codex = new FakeCodex(async (c) => {
    if (++turns > 1) return say("second")(c);
    c.emit("item/agentMessage/delta", { itemId: "m", delta: "first" });
    await c.onInterrupt;
    c.emit("item/agentMessage/delta", { itemId: "m", delta: " late" });
    c.emit("turn/completed", { turn: { id: c.turnId, status: "interrupted" } });
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  for await (const e of s.prompt(input("one"), ac())) if (e.type === "text-delta") break;
  const events = await collect(s.prompt(input("two"), ac()));
  expect(textOf(events)).toBe("second");
  expect(codex.calls("turn/interrupt")).toHaveLength(1);
});

test("a failed turn finishes with its error; retries are notices", async () => {
  const codex = new FakeCodex(async (c) => {
    c.emit("error", { error: { message: "overloaded" }, willRetry: true });
    c.emit("error", { error: { message: "quota" }, willRetry: false });
    c.emit("turn/completed", {
      turn: { id: c.turnId, status: "failed", error: { message: "usage limit reached" } },
    });
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const events = await collect(s.prompt(input("go"), ac()));
  expect(events).toContainEqual({ type: "notice", level: "warning", text: "Codex is retrying: overloaded" });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "error", error: "usage limit reached" });
});

test("Codex warnings show once per session", async () => {
  const codex = new FakeCodex(async (c) => {
    c.emit("warning", { message: "metadata missing" });
    await say("ok")(c);
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const notices = async () => (await collect(s.prompt(input("go"), ac()))).filter((e) => e.type === "notice");
  expect(await notices()).toHaveLength(1);
  expect(await notices()).toHaveLength(0);
});

test("compact runs thread/compact/start and reports the compaction", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  if (!s.compact) throw new Error("no compact");
  const events = await collect(s.compact("keep the plan", ac()));
  expect(codex.calls("thread/compact/start")).toEqual([{ threadId: "thr_1" }]);
  expect(types(events)).toEqual(["compaction-start", "compaction-end", "usage", "finish"]);
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
});

test("setModel applies to the next turn: effort, and fast mode as the service tier", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  await s.setModel?.("gpt-6-luna", { effort: "max", fast: true });
  await collect(s.prompt(input("go"), ac()));
  expect(codex.calls("turn/start")[0]).toMatchObject({
    model: "gpt-6-luna",
    effort: "max",
    serviceTier: "priority",
  });
  await s.setModel?.("gpt-6-luna", { fast: false });
  await collect(s.prompt(input("again"), ac()));
  const second = codex.calls("turn/start")[1] as Record<string, unknown>;
  expect(second.serviceTier).toBeNull();
  expect("effort" in second).toBe(false);
});

test("open sends the fast tier with the thread, and nothing when fast mode is unset", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({}, codex.spawn);
  await open(h, { fast: true });
  expect(codex.calls("thread/start")[0]).toMatchObject({ serviceTier: "priority" });
  await open(h, { sessionId: "s2" });
  expect("serviceTier" in (codex.calls("thread/start")[1] as Record<string, unknown>)).toBe(false);
});

test("when the app-server dies mid-turn the turn fails and the next prompt resumes the thread", async () => {
  let turns = 0;
  const codex = new FakeCodex(async (c) => {
    if (++turns === 1) {
      c.emit("item/started", {
        item: { type: "commandExecution", id: "c1", command: "x", status: "inProgress" },
      });
      codex.proc.kill();
      return;
    }
    await say("back")(c);
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const one = await collect(s.prompt(input("go"), ac()));
  expect(one.at(-2)).toEqual({ type: "tool-end", callId: "c1", status: "error" });
  expect(one.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  const two = await collect(s.prompt(input("again"), ac()));
  expect(textOf(two)).toBe("back");
  expect(codex.processes).toHaveLength(2);
  expect(codex.calls("thread/resume")).toHaveLength(1);
  expect(s.resumeId).toBe("thr_1");
});

test("an idle thread is unsubscribed and resumed by the next prompt", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({ idleCloseMs: 20 }, codex.spawn);
  const s = await open(h);
  await collect(s.prompt(input("one"), ac()));
  await Bun.sleep(60);
  expect(codex.calls("thread/unsubscribe")).toEqual([{ threadId: "thr_1" }]);
  await collect(s.prompt(input("two"), ac()));
  expect(codex.calls("thread/resume")).toHaveLength(1);
});

test("rate-limit updates become notices in running turns, once per window", async () => {
  const limits = { limitId: "codex", primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 9e9 } };
  const codex = new FakeCodex(async (c) => {
    codex.proc.emit("account/rateLimits/updated", { rateLimits: limits });
    codex.proc.emit("account/rateLimits/updated", { rateLimits: limits });
    await Bun.sleep(5);
    await say("ok")(c);
  });
  h = fakeCtx({}, codex.spawn);
  const s = await open(h);
  const events = await collect(s.prompt(input("go"), ac()));
  expect(events.filter((e) => e.type === "notice")).toEqual([
    { type: "notice", level: "warning", text: "Approaching Codex's session limit (91% used)" },
  ]);
});

test("hideBuiltinTools turns Codex's tool features off; a settings change applies at the next thread", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({ hideBuiltinTools: false, sandbox: "read-only" }, codex.spawn);
  h.setConfig({ hideBuiltinTools: true, approvalPolicy: "never" });
  await open(h);
  const p = codex.calls("thread/start")[0] as {
    sandbox: string;
    approvalPolicy: string;
    config: Record<string, Record<string, unknown>>;
  };
  expect(p.sandbox).toBe("read-only");
  expect(p.approvalPolicy).toBe("never");
  expect(p.config.features).toMatchObject({
    hooks: true,
    shell_tool: false,
    unified_exec: false,
    view_image: false,
  });
  expect(p.config.web_search as unknown).toBe("disabled");
});

test("listModels reads model/list: efforts, default effort and the fast tier; turns teach the context window", async () => {
  const codex = new FakeCodex();
  codex.models = [
    {
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
      defaultReasoningEffort: "low",
      inputModalities: ["text", "image"],
      serviceTiers: [{ id: "priority", name: "Fast" }],
      defaultServiceTier: "priority",
    },
    { id: "plain", displayName: "Plain", hidden: false, supportedReasoningEfforts: [] },
    { id: "secret", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [] },
  ];
  h = fakeCtx({}, codex.spawn);
  const before = await h.provider.listModels();
  expect(before.map((m) => [m.id, m.name, m.contextWindow])).toEqual([
    ["gpt-6.1-sol", "GPT-6.1-Sol", 272_000],
    ["plain", "Plain", 272_000],
  ]);
  expect(before[0]).toMatchObject({
    efforts: ["low", "high"],
    defaultEffort: "low",
    fast: true,
    fastByDefault: true,
  });
  expect(before[1]?.fast).toBeUndefined();
  const s = await open(h);
  await collect(s.prompt(input("go"), ac()));
  expect((await h.provider.listModels())[0]?.contextWindow).toBe(400_000);
});

test("configured models replace model/list", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({ models: [{ id: "local", contextWindow: 64_000 }] }, codex.spawn);
  expect(await h.provider.listModels()).toEqual([
    {
      id: "local",
      name: "local",
      contextWindow: 64_000,
      maxOutputTokens: 128_000,
      input: ["text", "image"],
      reasoning: true,
    },
  ]);
  expect(codex.processes).toHaveLength(0);
});

test("the utility model runs one turn on an ephemeral tool-free thread", async () => {
  const codex = new FakeCodex(say(" A Title "));
  h = fakeCtx({ utilityModel: "gpt-6-luna-low" }, codex.spawn);
  const out = await h.provider.utility?.complete({ system: "Name it.", prompt: "chat" }, ac());
  expect(out).toBe("A Title");
  const start = codex.calls("thread/start")[0] as Record<string, unknown>;
  expect(start).toMatchObject({
    model: "gpt-6-luna",
    ephemeral: true,
    baseInstructions: "Name it.",
    sandbox: "read-only",
  });
  expect(start.dynamicTools).toBeUndefined();
  expect(codex.calls("turn/start")[0]).toMatchObject({ effort: "low", summary: "none" });
  expect(codex.calls("thread/unsubscribe")).toHaveLength(1);
});

test("close unsubscribes; dispose stops the app-server", async () => {
  const codex = new FakeCodex();
  h = fakeCtx({}, codex.spawn);
  const s = await open(h, { tools: noTools });
  await s.close();
  expect(codex.calls("thread/unsubscribe")).toEqual([{ threadId: "thr_1" }]);
  await h.dispose();
  h = undefined;
  expect(codex.proc.dead).toBe(true);
});

test("the provider names the OpenAI logo for UIs", () => {
  h = fakeCtx({}, new FakeCodex().spawn);
  expect((h.provider as { icon?: string }).icon).toBe("openai");
});
