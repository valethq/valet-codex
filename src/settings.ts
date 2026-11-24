import type { ModelInfo, Option, PluginContext } from "@valethq/sdk";
import {
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type CodexConfig,
  DEFAULT_UTILITY_MODEL,
  type Effort,
  SANDBOXES,
  type Sandbox,
} from "./config";
import { asEffort } from "./models";
import type { UsageService } from "./usage";

type Ctx = PluginContext<CodexConfig>;

const oneOf = <T extends string>(all: readonly T[], v: unknown, fallback: T): T =>
  (all as readonly unknown[]).includes(v) ? (v as T) : fallback;

// Settings are config (12.1): core fills in the manifest's defaults, so these fallbacks only matter without it.

export const sandbox = (ctx: Ctx): Sandbox => oneOf(SANDBOXES, ctx.config?.sandbox, "workspace-write");

export const approvalPolicy = (ctx: Ctx): ApprovalPolicy =>
  oneOf(APPROVAL_POLICIES, ctx.config?.approvalPolicy, "on-request");

/** The Utility model and its effort; no model (or an empty one) turns it off. */
export function utilityModel(ctx: Ctx): { model: string; effort?: Effort } | undefined {
  const v = ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL;
  const model = v.model?.trim() ?? "";
  if (model === "") return undefined;
  const effort = asEffort(v.effort);
  return effort ? { model, effort } : { model };
}

export const hideBuiltinTools = (ctx: Ctx): boolean => ctx.config?.hideBuiltinTools ?? false;

export const ignoreGlobalAgentsMd = (ctx: Ctx): boolean => ctx.config?.ignoreGlobalAgentsMd ?? false;

/** The usage-warning threshold as a percent (0-100). */
export const minRateLimitNoticePercent = (ctx: Ctx): number => (ctx.config?.rateLimitNoticeAt ?? 0.8) * 100;

/** settings@2: live plan usage as a runtime subsection. */
export function registerSettings(
  ctx: Ctx,
  usage: UsageService,
  listModels: () => Promise<ModelInfo[]>,
): void {
  ctx.scopes.define({ name: "settings", version: 2, cardinality: "many" });
  ctx.scopes.provide("settings", {
    options: {
      models: async (): Promise<Option[]> =>
        (await listModels()).map((m) => ({ value: m.id, label: m.name })),
      efforts: async ({ model }): Promise<Option[]> =>
        ((await listModels()).find((m) => m.id === model)?.efforts ?? []).map((e) => ({ value: e })),
    },
    actions: { refresh: () => usage.refresh(true) },
    subsections: async () => [
      { id: "usage", label: "Plan usage", order: -1, refreshMs: 15_000, items: await usage.view() },
    ],
  });
}
