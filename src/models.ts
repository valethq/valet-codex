import type { ModelInfo } from "@valethq/sdk";
import {
  type CodexConfig,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  EFFORTS,
  type Effort,
  type ModelConfig,
} from "./config";

const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);
const LIST_TTL_MS = 5 * 60_000;

/** For the utility model setting, which may name an effort: "gpt-6-luna-low" -> { model, effort: "low" }. */
export function resolveModel(id: string): { model: string; effort?: Effort } {
  const effort = EFFORT_SUFFIX.exec(id)?.[1] as Effort | undefined;
  return effort ? { model: id.replace(EFFORT_SUFFIX, ""), effort } : { model: id };
}

/** An effort Codex takes, or undefined for anything else. */
export const asEffort = (v: string | undefined): Effort | undefined =>
  v !== undefined && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined;

export function toModelInfo(m: ModelConfig, windows: ReadonlyMap<string, number> = new Map()): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? windows.get(m.id) ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    input: m.input ?? ["text", "image"],
    reasoning: true,
    ...(m.efforts?.length ? { efforts: m.efforts } : {}),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    ...(m.fastTier ? { fast: true } : {}),
    ...(m.fastTier && m.fastByDefault ? { fastByDefault: true } : {}),
  };
}

interface CodexModel {
  id?: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort?: string }[];
  defaultReasoningEffort?: string;
  inputModalities?: string[];
  serviceTiers?: { id?: string }[];
  defaultServiceTier?: string | null;
}

const isEffort = (e: string | undefined): e is Effort => (EFFORTS as readonly string[]).includes(e ?? "");

/** `model/list` entries as model configs; hidden models and unknown efforts are dropped. The first service tier is fast mode. */
export function fromCodex(list: unknown): ModelConfig[] {
  const data = (list as { data?: CodexModel[] } | undefined)?.data ?? [];
  return data
    .filter((m): m is CodexModel & { id: string } => typeof m.id === "string" && !m.hidden)
    .map((m) => {
      const fastTier = m.serviceTiers?.find((t) => typeof t.id === "string")?.id;
      return {
        id: m.id,
        name: m.displayName ?? m.id,
        efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter(isEffort),
        ...(isEffort(m.defaultReasoningEffort) ? { defaultEffort: m.defaultReasoningEffort } : {}),
        input: (m.inputModalities ?? ["text", "image"]).filter(
          (i): i is "text" | "image" => i === "text" || i === "image",
        ),
        ...(fastTier
          ? { fastTier, ...(m.defaultServiceTier === fastTier ? { fastByDefault: true } : {}) }
          : {}),
      };
    });
}

export interface ModelCatalog {
  list(): Promise<ModelInfo[]>;
  /** The service tier that means fast mode for `model`; "priority" when the list doesn't say. */
  fastTier(model: string): string;
  /** Records the window a turn reported (`modelContextWindow`), so the picker shows the real one. */
  learnWindow(model: string, tokens: number): void;
}

export function createCatalog(
  cfg: () => CodexConfig | undefined,
  fetchList: () => Promise<unknown>,
  now = Date.now,
): ModelCatalog {
  const windows = new Map<string, number>();
  let cached: { at: number; models: ModelConfig[] } | undefined;
  const configs = async (): Promise<ModelConfig[]> => {
    const configured = cfg()?.models;
    if (configured) return configured;
    if (!cached || now() - cached.at > LIST_TTL_MS)
      cached = { at: now(), models: fromCodex(await fetchList()) };
    return cached.models;
  };
  return {
    async list() {
      return (await configs()).map((m) => toModelInfo(m, windows));
    },
    fastTier(model) {
      const listed = cfg()?.models ?? cached?.models ?? [];
      return listed.find((m) => m.id === model)?.fastTier ?? "priority";
    },
    learnWindow(model, tokens) {
      if (tokens > 0) windows.set(model, tokens);
    },
  };
}
