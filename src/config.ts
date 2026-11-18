export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
export const SANDBOXES: readonly Sandbox[] = ["read-only", "workspace-write", "danger-full-access"];

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["untrusted", "on-request", "never"];

/** Every effort Codex models report (`model/list` supportedReasoningEfforts), lowest first. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Effort levels offered as picker entries ("<id>-<effort>"). Unset = bare id only. */
  efforts?: Effort[];
  input?: ("text" | "image")[];
}

/** A model the user adds by hand; `id` goes to the harness unchanged, `name` is the picker label. */
export interface CustomModel {
  id: string;
  name?: string;
}

export interface CodexConfig {
  /** Path to the `codex` binary. Default: `codex` on PATH, then ~/.local/bin/codex. */
  codexPath?: string;
  /** Extra arguments for `codex app-server`, e.g. ["--enable", "some_feature"]. */
  args?: string[];
  /** Extra environment for the app-server, e.g. { CODEX_HOME: "/srv/codex" }. Merged over valet's own. */
  env?: Record<string, string>;
  /**
   * Codex config overrides sent with every thread (`thread/start` `config`), as dotted keys or nested tables,
   * e.g. { model_provider: "my-proxy" }. Static per plugin config: it is part of the cached prefix.
   */
  config?: Record<string, unknown>;
  /** Sandbox for model-run commands. Also a settings panel that overrides it. Default "workspace-write". */
  sandbox?: Sandbox;
  /** When Codex asks before running something. Requests go to valet as permission events. Default "on-request". */
  approvalPolicy?: ApprovalPolicy;
  /** Tool names the gate always denies, as Codex's hooks name them ("Bash", "apply_patch", "mcp__srv__tool", ...). */
  denyTools?: string[];
  /** Turn off Codex's own tools where Codex allows it, leaving valet's. Also in the settings panel. Default false. */
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
   * loads otherwise. Needs bwrap. Also in the settings panel. Applies when the app-server next starts. Default false.
   */
  ignoreGlobalAgentsMd?: boolean;
  /** Reasoning summary detail streamed as reasoning. Default "auto". */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  /** Unsubscribe from an idle thread after this long; the next prompt resumes it. 0 disables. Default 15 min. */
  idleCloseMs?: number;
  /** Hide "approaching limit" warnings below this percent used (0-100). Also in the settings panel. Default 80. */
  minRateLimitNoticePercent?: number;
  /** Model for small side jobs such as session naming. Empty string turns them off. */
  utilityModel?: string;
  /** Override the model list. Unset reads `model/list` from Codex. */
  models?: ModelConfig[];
  /** Extra picker entries added to the model list. Also in the settings panel. */
  customModels?: CustomModel[];
}

export const DEFAULT_UTILITY_MODEL = "gpt-6-luna-low";
export const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;
/** Codex does not report a window in `model/list`; this is used until a turn reports `modelContextWindow`. */
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
