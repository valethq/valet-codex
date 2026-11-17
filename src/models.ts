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

/** "gpt-6.1-sol-high" -> { model: "gpt-6.1-sol", effort: "high" }. Ids without a suffix pass through. */
export function resolveModel(id: string): { model: string; effort?: Effort } {
  const effort = EFFORT_SUFFIX.exec(id)?.[1] as Effort | undefined;
  return effort ? { model: id.replace(EFFORT_SUFFIX, ""), effort } : { model: id };
}

/** One picker entry per declared effort: "<id>-<effort>". Without declared efforts, just the bare model. */
export function toModelInfos(m: ModelConfig, windows: ReadonlyMap<string, number> = new Map()): ModelInfo[] {
  const base: ModelInfo = {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? windows.get(m.id) ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    input: m.input ?? ["text", "image"],
    reasoning: true,
  };
  if (!m.efforts?.length) return [base];
  return m.efforts.map((e) => ({ ...base, id: `${m.id}-${e}`, name: `${base.name} (${e})` }));
}

interface CodexModel {
  id?: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort?: string }[];
  inputModalities?: string[];
}

/** `model/list` entries as model configs; hidden models and unknown efforts are dropped. */
export function fromCodex(list: unknown): ModelConfig[] {
  const data = (list as { data?: CodexModel[] } | undefined)?.data ?? [];
  return data
    .filter((m): m is CodexModel & { id: string } => typeof m.id === "string" && !m.hidden)
    .map((m) => ({
      id: m.id,
      name: m.displayName ?? m.id,
      efforts: (m.supportedReasoningEfforts ?? [])
        .map((e) => e.reasoningEffort)
        .filter((e): e is Effort => (EFFORTS as readonly string[]).includes(e ?? "")),
      input: (m.inputModalities ?? ["text", "image"]).filter(
        (i): i is "text" | "image" => i === "text" || i === "image",
      ),
    }));
}

export interface ModelCatalog {
  list(): Promise<ModelInfo[]>;
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
  return {
    async list() {
      const configured = cfg()?.models;
      if (configured) return configured.flatMap((m) => toModelInfos(m, windows));
      if (!cached || now() - cached.at > LIST_TTL_MS)
        cached = { at: now(), models: fromCodex(await fetchList()) };
      return cached.models.flatMap((m) => toModelInfos(m, windows));
    },
    learnWindow(model, tokens) {
      if (tokens > 0) windows.set(model, tokens);
    },
  };
}
