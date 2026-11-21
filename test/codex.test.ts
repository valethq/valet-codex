import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSurface } from "@valethq/sdk";
import { findCodex } from "../src/spawn";
import { fakeResponses } from "./fake-responses";
import { collect, fakeCtx, input, open, tempDirs, textOf } from "./helpers";

// The real `codex app-server` against a local fake model: no account and no network needed.
const codex = findCodex(process.env.VALET_CODEX_PATH);
const available = codex.includes("/") ? existsSync(codex) : Bun.which(codex) !== null;

let model: ReturnType<typeof fakeResponses>;
let h: ReturnType<typeof fakeCtx>;
const gated: string[] = [];
const called: string[] = [];
let verdict: (name: string, input: unknown) => { input: unknown } | { denied: string } = (_n, i) => ({
  input: i,
});
const temp = tempDirs();
const work = temp.make("valet-codex-work-");

const tools: ToolSurface = {
  list: () => [
    {
      name: "lookup",
      description: "Look up a key",
      inputSchema: { type: "object", properties: { key: { type: "string" } } },
    },
  ],
  call: async (name, i) => {
    called.push(`${name} ${JSON.stringify(i)}`);
    return { content: [{ type: "text", text: "BANANA" }] };
  },
  authorize: async (name, i) => {
    gated.push(name);
    return verdict(name, i);
  },
};

beforeAll(() => {
  if (!available) return;
  model = fakeResponses();
  h = fakeCtx({
    codexPath: codex,
    env: { CODEX_HOME: temp.make("valet-codex-home-") },
    args: [
      "-c",
      `model_providers.fake={name="fake",base_url="${model.url}",wire_api="responses"}`,
      "-c",
      'model_provider="fake"',
    ],
    models: [{ id: "test-model" }],
    utilityModel: "test-model",
  });
});

afterAll(async () => {
  await h?.dispose();
  model?.stop();
  // spec-gap: dispose kills codex without awaiting exit, and it can still write to CODEX_HOME.
  await temp.cleanup(1000);
});

const ac = () => new AbortController().signal;
const session = (id: string) => open(h, { sessionId: id, model: "test-model", cwd: work, tools });

test.skipIf(!available)(
  "a plain turn round-trips through the real app-server",
  async () => {
    const s = await session("plain");
    const events = await collect(s.prompt(input("hello"), ac()));
    expect(textOf(events)).toBe("pong");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(model.requests.at(-1)?.prompt_cache_key).toBe(s.resumeId);
    await s.close();
  },
  60_000,
);

test.skipIf(!available)(
  "shell calls go through valet's gate before they run",
  async () => {
    const s = await session("shell");
    gated.length = 0;
    const marker = join(work, "ran");
    const allowed = await collect(s.prompt(input(`CALL exec_command {"cmd":"echo hi > ${marker}"}`), ac()));
    expect(gated).toEqual(["Bash"]);
    expect(allowed.find((e) => e.type === "tool-start")).toMatchObject({ name: "Bash" });
    expect(existsSync(marker)).toBe(true);
    verdict = () => ({ denied: "not here" });
    const blocked = join(work, "blocked");
    const denied = await collect(s.prompt(input(`CALL exec_command {"cmd":"touch ${blocked}"}`), ac()));
    verdict = (_n, i) => ({ input: i });
    expect(denied).toContainEqual({
      type: "tool-end",
      callId: "call_2",
      status: "error",
      output: "Denied: not here",
    });
    expect(existsSync(blocked)).toBe(false);
    expect(textOf(denied)).toContain("not here");
    await s.close();
  },
  60_000,
);

test.skipIf(!available)(
  "valet's tools are dynamic tools and skip the hook",
  async () => {
    const s = await session("valet-tool");
    gated.length = 0;
    const events = await collect(s.prompt(input('CALL valet__lookup {"key":"a"}'), ac()));
    expect(called).toEqual(['lookup {"key":"a"}']);
    expect(gated).toEqual([]);
    expect(events.find((e) => e.type === "tool-start")).toMatchObject({
      name: "lookup",
      input: { key: "a" },
    });
    expect(textOf(events)).toContain("BANANA");
    const sent = model.requests.at(-2)?.tools as { name?: string }[];
    expect(sent.map((t) => t.name)).toContain("valet__lookup");
    await s.close();
  },
  60_000,
);

test.skipIf(!available)(
  "a closed session resumes its thread with the context intact",
  async () => {
    const s = await session("resume");
    await collect(s.prompt(input("first"), ac()));
    const id = s.resumeId;
    await s.close();
    const again = await open(h, { sessionId: "resume", model: "test-model", cwd: work, tools, resumeId: id });
    expect(again.resumeId).toBe(id);
    await collect(again.prompt(input("second"), ac()));
    const texts = JSON.stringify(model.requests.at(-1)?.input);
    expect(texts).toContain("first");
    expect(texts).toContain("second");
    await again.close();
  },
  60_000,
);

test.skipIf(!available)(
  "the utility model answers on an ephemeral thread",
  async () => {
    expect(await h.provider.utility?.complete({ system: "Title it.", prompt: "chat" }, ac())).toBe("pong");
    const last = model.requests.at(-1) as { tools?: { name?: string }[]; instructions?: string };
    expect((last.tools ?? []).map((t) => t.name)).not.toContain("exec_command");
  },
  60_000,
);

test.skipIf(!available)(
  "hideBuiltinTools leaves the model valet's tools only",
  async () => {
    h.setConfig({ hideBuiltinTools: true });
    try {
      const s = await session("hidden");
      await collect(s.prompt(input("hello"), ac()));
      const names = ((model.requests.at(-1)?.tools ?? []) as { name?: string }[]).map((t) => t.name);
      expect(names).toContain("valet__lookup");
      expect(names).not.toContain("exec_command");
      expect(names).not.toContain("view_image");
      await s.close();
    } finally {
      h.setConfig({ hideBuiltinTools: false });
    }
  },
  60_000,
);

test.skipIf(!available || !Bun.which("bwrap"))(
  "ignoreGlobalAgentsMd hides CODEX_HOME's AGENTS.md from the real app-server",
  async () => {
    const home = temp.make("valet-codex-home-");
    writeFileSync(join(home, "AGENTS.md"), "GLOBAL-AGENTS-MARKER");
    const turn = async (ignore: boolean) => {
      const c = fakeCtx({
        codexPath: codex,
        env: { CODEX_HOME: home },
        args: [
          "-c",
          `model_providers.fake={name="fake",base_url="${model.url}",wire_api="responses"}`,
          "-c",
          'model_provider="fake"',
        ],
        models: [{ id: "test-model" }],
        ignoreGlobalAgentsMd: ignore,
      });
      try {
        const s = await open(c, { sessionId: `global-${ignore}`, model: "test-model", cwd: work, tools });
        const events = await collect(s.prompt(input("hello"), ac()));
        expect(textOf(events)).toBe("pong");
        await s.close();
        return JSON.stringify(model.requests.at(-1));
      } finally {
        await c.dispose();
      }
    };
    expect(await turn(false)).toContain("GLOBAL-AGENTS-MARKER");
    expect(await turn(true)).not.toContain("GLOBAL-AGENTS-MARKER");
  },
  60_000,
);
