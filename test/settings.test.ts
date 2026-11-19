import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, SettingsPanel } from "@valethq/sdk";
import type { CodexConfig } from "../src/config";
import {
  approvalPolicy,
  hideBuiltinTools,
  ignoreGlobalAgentsMd,
  minRateLimitNoticePercent,
  registerSettings,
  sandbox,
  utilityModel,
} from "../src/settings";
import type { UsageService } from "../src/usage";

const ctxOf = (config: CodexConfig) => ({ config }) as unknown as PluginContext<CodexConfig>;
const props = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8")).configSchema
  .properties as Record<string, { default?: unknown }>;

test("accessors fall back to the defaults the manifest declares", () => {
  const ctx = ctxOf({});
  expect(sandbox(ctx)).toBe(props.sandbox?.default as "workspace-write");
  expect(approvalPolicy(ctx)).toBe(props.approvalPolicy?.default as "on-request");
  expect(utilityModel(ctx)).toBe(props.utilityModel?.default as string);
  expect(hideBuiltinTools(ctx)).toBe(props.hideBuiltinTools?.default as boolean);
  expect(ignoreGlobalAgentsMd(ctx)).toBe(props.ignoreGlobalAgentsMd?.default as boolean);
  expect(minRateLimitNoticePercent(ctx)).toBe(props.minRateLimitNoticePercent?.default as number);
  expect(props.customModels).toBeUndefined();
});

test("config values win; values outside the enums fall back; an empty utility model is off", () => {
  const ctx = ctxOf({ sandbox: "read-only", approvalPolicy: "never", utilityModel: "" });
  expect(sandbox(ctx)).toBe("read-only");
  expect(approvalPolicy(ctx)).toBe("never");
  expect(utilityModel(ctx)).toBeUndefined();
  expect(sandbox(ctxOf({ sandbox: "yolo" as never }))).toBe("workspace-write");
});

test("the settings page carries usage: view and refresh action, no form", async () => {
  let provided: SettingsPanel | undefined;
  const ctx = {
    config: {},
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
  expect(provided?.schema).toBeUndefined();
  expect(await provided?.view?.()).toEqual([{ type: "text", text: "usage" }]);
  await provided?.actions?.refresh?.({});
  expect(refreshed).toBe(1);
});
