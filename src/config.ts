export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
export const SANDBOXES: readonly Sandbox[] = ["read-only", "workspace-write", "danger-full-access"];

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["untrusted", "on-request", "never"];

/** Every effort Codex models report (`model/list` supportedReasoningEfforts), lowest first. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export type Effort = (typeof EFFORTS)[number];

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Effort levels the model takes. Unset = none to pick. */
  efforts?: Effort[];
  defaultEffort?: Effort;
  input?: ("text" | "image")[];
  /** The service tier that is the model's fast mode, e.g. "priority". Unset = no fast mode. */
  fastTier?: string;
  /** The model runs on `fastTier` unless a selection turns fast mode off. */
  fastByDefault?: boolean;
}

export interface CodexConfig {
  /** Path to the `codex` binary. Default: `codex` on PATH, then ~/.local/bin/codex. */
  codexPath?: string;
  /** Extra arguments for `codex app-server`, e.g. ["--enable", "some_feature"]. */
  args?: string[];
  /** Extra environment for the app-server, e.g. { CODEX_HOME: "/srv/codex" }. Merged over valet's own. */
  env?: Record<string, string>;
  /**
   * Codex config overrides sent with every thread (`thread/start` `config`), one dotted key per entry, e.g.
   * { model_provider: "my-proxy" }. Values that parse as JSON are sent parsed. Static per plugin config: it is part
   * of the cached prefix.
   */
  config?: Record<string, string>;
  /** Sandbox for model-run commands. Default "workspace-write". */
  sandbox?: Sandbox;
  /** When Codex asks before running something. Requests go to valet as permission events. Default "on-request". */
  approvalPolicy?: ApprovalPolicy;
  /** Tool names the gate always denies, as Codex's hooks name them ("Bash", "apply_patch", "mcp__srv__tool", ...). */
  denyTools?: string[];
  /** Turn off Codex's own tools where Codex allows it, leaving valet's. Default false. */
  hideBuiltinTools?: boolean;
  /** Static developer instructions for every thread (`developerInstructions`), ahead of valet's persona. Part of the cached prefix. */
  developerInstructions?: string;
  /**
   * Let Codex load the workspace's AGENTS.md itself. Default false (`project_doc_max_bytes = 0`): valet's persona
   * already carries AGENTS.md, so Codex would send it twice. `config` can still set `project_doc_max_bytes`.
   */
  loadProjectDocs?: boolean;
  /**
   * Run Codex under bwrap with an empty file over CODEX_HOME's AGENTS.md / AGENTS.override.md, which Codex always
   * loads otherwise. Needs bwrap. Applies when the app-server next starts. Default false.
   */
  ignoreGlobalAgentsMd?: boolean;
  /** Reasoning summary detail streamed as reasoning. Default "auto". */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  /** Unsubscribe from an idle thread after this long; the next prompt resumes it. 0 disables. Default 15 min. */
  idleCloseMs?: number;
  /** Hide "approaching limit" warnings below this percent used as a share (0-1). Default 0.8. */
  rateLimitNoticeAt?: number;
  /** Model for small side jobs such as session naming. Empty string turns them off. */
  utilityModel?: { model?: string; effort?: Effort };
  /** Override the model list. Unset reads `model/list` from Codex. */
  models?: ModelConfig[];
}

export const DEFAULT_UTILITY_MODEL: { model: string; effort?: Effort } = {
  model: "gpt-6-luna",
  effort: "low",
};
export const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;
/** Codex does not report a window in `model/list`; this is used until a turn reports `modelContextWindow`. */
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
