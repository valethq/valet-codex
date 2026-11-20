import type { PluginContext } from "@valethq/sdk";
import {
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type CodexConfig,
  DEFAULT_UTILITY_MODEL,
  SANDBOXES,
  type Sandbox,
} from "./config";
import type { UsageService } from "./usage";

type Ctx = PluginContext<CodexConfig>;

const oneOf = <T extends string>(all: readonly T[], v: unknown, fallback: T): T =>
  (all as readonly unknown[]).includes(v) ? (v as T) : fallback;

// Settings are config (12.1): core fills in the manifest's defaults, so these fallbacks only matter without it.

export const sandbox = (ctx: Ctx): Sandbox => oneOf(SANDBOXES, ctx.config?.sandbox, "workspace-write");

export const approvalPolicy = (ctx: Ctx): ApprovalPolicy =>
  oneOf(APPROVAL_POLICIES, ctx.config?.approvalPolicy, "on-request");

/** The Utility model; an empty string turns it off. */
export function utilityModel(ctx: Ctx): string | undefined {
  const v = (ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL).trim();
  return v === "" ? undefined : v;
}

export const hideBuiltinTools = (ctx: Ctx): boolean => ctx.config?.hideBuiltinTools ?? false;

export const ignoreGlobalAgentsMd = (ctx: Ctx): boolean => ctx.config?.ignoreGlobalAgentsMd ?? false;

export const minRateLimitNoticePercent = (ctx: Ctx): number => ctx.config?.minRateLimitNoticePercent ?? 80;

/** settings@2: live plan usage as a runtime subsection. */
export function registerSettings(ctx: Ctx, usage: UsageService): void {
  ctx.scopes.define({ name: "settings", version: 2, cardinality: "many" });
  ctx.scopes.provide("settings", {
    actions: { refresh: () => usage.refresh(true) },
    subsections: async () => [
      { id: "usage", label: "Plan usage", order: -1, refreshMs: 15_000, items: await usage.view() },
    ],
  });
}
