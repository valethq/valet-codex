import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, Setting, SettingsContribution } from "@valethq/sdk";
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
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));
const props: Record<string, { default?: unknown }> = Object.fromEntries(
  (manifest.settings.sections.inference.subsections as { items: Setting[] }[])
    .flatMap((s) => s.items)
    .map((s) => [s.id, { default: s.input.default }]),
);

test("accessors fall back to the defaults the manifest declares", () => {
  const ctx = ctxOf({});
  expect(sandbox(ctx)).toBe(props.sandbox?.default as "workspace-write");
  expect(approvalPolicy(ctx)).toBe(props.approvalPolicy?.default as "on-request");
  expect(utilityModel(ctx)).toEqual(props.utilityModel?.default as { model: string });
  expect(hideBuiltinTools(ctx)).toBe(props.hideBuiltinTools?.default as boolean);
  expect(ignoreGlobalAgentsMd(ctx)).toBe(props.ignoreGlobalAgentsMd?.default as boolean);
  expect(minRateLimitNoticePercent(ctx)).toBe((props.rateLimitNoticeAt?.default as number) * 100);
  expect(props.customModels).toBeUndefined();
});

test("config values win; values outside the enums fall back; an empty utility model is off", () => {
  const ctx = ctxOf({ sandbox: "read-only", approvalPolicy: "never", utilityModel: { model: "" } });
  expect(sandbox(ctx)).toBe("read-only");
  expect(approvalPolicy(ctx)).toBe("never");
  expect(utilityModel(ctx)).toBeUndefined();
  expect(sandbox(ctxOf({ sandbox: "yolo" as never }))).toBe("workspace-write");
});

test("settings@2 carries plan usage as a runtime subsection with a refresh action", async () => {
  let provided: SettingsContribution | undefined;
  const ctx = {
    config: {},
    scopes: {
      define() {},
      provide: (_name: string, p: SettingsContribution) => {
        provided = p;
      },
    },
  };
  let refreshed = 0;
  const usage: UsageService = {
    view: async () => [{ type: "note", text: "usage" }],
    refresh: async () => void refreshed++,
    update() {},
  };
  registerSettings(ctx as never, usage, async () => []);
  expect(await provided?.subsections?.()).toEqual([
    {
      id: "usage",
      label: "Plan usage",
      order: -1,
      refreshMs: 15_000,
      items: [{ type: "note", text: "usage" }],
    },
  ]);
  await provided?.actions?.refresh?.({});
  expect(refreshed).toBe(1);
});
