import type { PluginContext } from "@valethq/sdk";
import {
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type CodexConfig,
  type CustomModel,
  DEFAULT_UTILITY_MODEL,
  SANDBOXES,
  type Sandbox,
} from "./config";
import type { UsageService } from "./usage";

type Ctx = PluginContext<CodexConfig>;

const oneOf = <T extends string>(all: readonly T[], v: unknown, fallback: T): T =>
  (all as readonly unknown[]).includes(v) ? (v as T) : fallback;

/** Panel values win over config.json so the UI can change them without a restart. */
export function sandbox(ctx: Ctx): Sandbox {
  return oneOf(SANDBOXES, ctx.storage.kv.get<string>("sandbox") ?? ctx.config?.sandbox, "workspace-write");
}

export function approvalPolicy(ctx: Ctx): ApprovalPolicy {
  const v = ctx.storage.kv.get<string>("approvalPolicy") ?? ctx.config?.approvalPolicy;
  return oneOf(APPROVAL_POLICIES, v, "on-request");
}

/** The Utility model; an empty string turns it off. */
export function utilityModel(ctx: Ctx): string | undefined {
  const v = ctx.storage.kv.get<string>("utilityModel") ?? ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL;
  return v.trim() === "" ? undefined : v.trim();
}

export function hideBuiltinTools(ctx: Ctx): boolean {
  return ctx.storage.kv.get<boolean>("hideBuiltinTools") ?? ctx.config?.hideBuiltinTools ?? false;
}

export function ignoreGlobalAgentsMd(ctx: Ctx): boolean {
  return ctx.storage.kv.get<boolean>("ignoreGlobalAgentsMd") ?? ctx.config?.ignoreGlobalAgentsMd ?? false;
}

export function minRateLimitNoticePercent(ctx: Ctx): number {
  const v = ctx.storage.kv.get<number>("minRateLimitNoticePercent") ?? ctx.config?.minRateLimitNoticePercent;
  return typeof v === "number" && v >= 0 && v <= 100 ? v : 80;
}

/** Panel value wins over config.json. Entries without an id are dropped. */
export function customModels(ctx: Ctx): CustomModel[] {
  const v = ctx.storage.kv.get<unknown>("customModels") ?? ctx.config?.customModels;
  return Array.isArray(v)
    ? v
        .filter(isCustomModel)
        .map(({ id, name }) => ({ id: id.trim(), ...(name?.trim() && { name: name.trim() }) }))
    : [];
}

const isCustomModel = (m: unknown): m is CustomModel =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as CustomModel).id === "string" &&
  (m as CustomModel).id.trim() !== "";

export function registerSettings(ctx: Ctx, usage: UsageService): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Codex",
      description: "Overrides plugins.valet-codex.config; applies when a session's Codex thread (re)loads.",
      view: () => usage.view(),
      refreshMs: 15_000,
      actions: { refresh: () => usage.refresh(true) },
      schema: {
        type: "object",
        properties: {
          sandbox: {
            type: "string",
            title: "Sandbox",
            description: "Where Codex's own commands may write.",
            enum: SANDBOXES,
            enumNames: ["Read only", "Workspace write", "Full access"],
          },
          approvalPolicy: {
            type: "string",
            title: "Approvals",
            description: "When Codex asks before running something. Requests go through valet's tool gate.",
            enum: APPROVAL_POLICIES,
            enumNames: ["Untrusted commands", "When Codex asks", "Never"],
          },
          utilityModel: {
            type: "string",
            title: "Utility model",
            description: "Model for small side jobs such as naming sessions. Empty turns them off.",
          },
          customModels: {
            type: "array",
            title: "Custom models",
            description: "Extra models for the picker. The model name is sent to Codex as is.",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", title: "Model name" },
                name: { type: "string", title: "Friendly name" },
              },
            },
          },
          minRateLimitNoticePercent: {
            type: "number",
            title: "Usage warning threshold (%)",
            description:
              'Only show "approaching limit" warnings once usage is at or above this percent. Hitting a limit is always shown.',
            minimum: 0,
            maximum: 100,
          },
          hideBuiltinTools: {
            type: "boolean",
            title: "Hide built-in tools",
            description:
              "Turn off Codex's own tools (shell, view_image, web search, ...) where Codex allows it, leaving valet's.",
          },
          ignoreGlobalAgentsMd: {
            type: "boolean",
            title: "Ignore global .codex AGENTS.md",
            description:
              "Hide CODEX_HOME's AGENTS.md / AGENTS.override.md from Codex (valet's persona replaces it). Needs bwrap. Applies when the Codex app-server next starts.",
          },
        },
      },
      get: () => ({
        sandbox: sandbox(ctx),
        approvalPolicy: approvalPolicy(ctx),
        utilityModel: utilityModel(ctx) ?? "",
        customModels: customModels(ctx),
        minRateLimitNoticePercent: minRateLimitNoticePercent(ctx),
        hideBuiltinTools: hideBuiltinTools(ctx),
        ignoreGlobalAgentsMd: ignoreGlobalAgentsMd(ctx),
      }),
      set: (v) => {
        if (v.sandbox !== undefined && !(SANDBOXES as readonly unknown[]).includes(v.sandbox))
          throw new Error(`sandbox must be one of: ${SANDBOXES.join(", ")}`);
        if (
          v.approvalPolicy !== undefined &&
          !(APPROVAL_POLICIES as readonly unknown[]).includes(v.approvalPolicy)
        )
          throw new Error(`approvalPolicy must be one of: ${APPROVAL_POLICIES.join(", ")}`);
        if (v.utilityModel !== undefined && typeof v.utilityModel !== "string")
          throw new Error("utilityModel must be a string");
        if (
          v.customModels !== undefined &&
          !(Array.isArray(v.customModels) && v.customModels.every(isCustomModel))
        )
          throw new Error("customModels entries need a model name");
        const min = v.minRateLimitNoticePercent;
        if (min !== undefined && (typeof min !== "number" || !(min >= 0 && min <= 100)))
          throw new Error("minRateLimitNoticePercent must be a number from 0 to 100");
        if (v.hideBuiltinTools !== undefined && typeof v.hideBuiltinTools !== "boolean")
          throw new Error("hideBuiltinTools must be true or false");
        if (v.ignoreGlobalAgentsMd !== undefined && typeof v.ignoreGlobalAgentsMd !== "boolean")
          throw new Error("ignoreGlobalAgentsMd must be true or false");
        for (const key of [
          "sandbox",
          "approvalPolicy",
          "utilityModel",
          "customModels",
          "minRateLimitNoticePercent",
          "hideBuiltinTools",
          "ignoreGlobalAgentsMd",
        ] as const)
          if (v[key] !== undefined) ctx.storage.kv.set(key, v[key]);
      },
    },
    { key: "valet-codex" },
  );
}
