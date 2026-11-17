import { expect, test } from "bun:test";
import { collect, fakeCtx, input, open, textOf } from "./helpers";

// Opt-in: a real model behind Codex. VALET_LIVE_CODEX_MODEL picks the model; CODEX_HOME (and any provider key
// it names) come from the environment, so this can run against a ChatGPT login or a custom provider.
const model = process.env.VALET_LIVE_CODEX_MODEL ?? "gpt-6-luna-low";

test.skipIf(process.env.VALET_LIVE_CODEX !== "1")(
  "live: a turn, a remembered follow-up, and plan usage",
  async () => {
    const h = fakeCtx({
      idleCloseMs: 0,
      models: [{ id: model }],
      utilityModel: model,
      ...(process.env.VALET_LIVE_CODEX_ARGS && { args: JSON.parse(process.env.VALET_LIVE_CODEX_ARGS) }),
    });
    try {
      const s = await open(h, { cwd: process.cwd(), model });
      const ac = new AbortController().signal;
      const one = await collect(s.prompt(input("reply with the word pong"), ac));
      expect(textOf(one).toLowerCase()).toContain("pong");
      expect(one.at(-1)).toEqual({ type: "finish", reason: "stop" });
      const two = await collect(s.prompt(input("what single word did I ask you to reply with?"), ac));
      expect(textOf(two).toLowerCase()).toContain("pong");
      console.log("usage panel:", JSON.stringify(await h.usage.view()));
      await s.close();
    } finally {
      await h.dispose();
    }
  },
  180_000,
);
