import { expect, test } from "bun:test";
import type { SettingsPanel } from "@valethq/sdk";
import type { CodexConfig } from "../src/config";
import { registerSettings } from "../src/settings";
import type { UsageService } from "../src/usage";

function panel(config: CodexConfig = {}) {
  const kv = new Map<string, unknown>();
  let provided: SettingsPanel | undefined;
  const ctx = {
    config,
    storage: { kv: { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => void kv.set(k, v) } },
    scopes: {
      define() {},
      provide: (_name: string, p: SettingsPanel) => {
        provided = p;
      },
    },
  };
  let refreshed = 0;
  const usage: UsageService = {
    view: async () => [{ type: "text", text: "usage" }],
    refresh: async () => void refreshed++,
    update() {},
  };
  registerSettings(ctx as never, usage);
  if (!provided) throw new Error("no panel");
  return { p: provided, kv, refreshed: () => refreshed };
}

test("defaults, config values, and panel overrides", async () => {
  const { p } = panel({ sandbox: "read-only", utilityModel: "gpt-6-luna-low" });
  expect(await p.get?.()).toEqual({
    sandbox: "read-only",
    approvalPolicy: "on-request",
    utilityModel: "gpt-6-luna-low",
    minRateLimitNoticePercent: 80,
    hideBuiltinTools: false,
    ignoreGlobalAgentsMd: false,
  });
  await p.set?.({
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    utilityModel: "",
    hideBuiltinTools: true,
  });
  expect(await p.get?.()).toMatchObject({
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    utilityModel: "",
    hideBuiltinTools: true,
  });
});

test("invalid values are rejected", () => {
  const { p, kv } = panel();
  expect(() => p.set?.({ sandbox: "yolo" })).toThrow("sandbox must be one of");
  expect(() => p.set?.({ approvalPolicy: "sometimes" })).toThrow("approvalPolicy must be one of");
  expect(() => p.set?.({ minRateLimitNoticePercent: 120 })).toThrow("0 to 100");
  expect(() => p.set?.({ hideBuiltinTools: "yes" })).toThrow("true or false");
  expect(() => p.set?.({ ignoreGlobalAgentsMd: 1 })).toThrow("true or false");
  expect(kv.size).toBe(0);
});

test("the view shows usage and the refresh action forces a read", async () => {
  const { p, refreshed } = panel();
  expect(await p.view?.()).toEqual([{ type: "text", text: "usage" }]);
  await p.actions?.refresh?.({});
  expect(refreshed()).toBe(1);
});
