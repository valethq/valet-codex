import type { ModelContent, ToolSpec } from "@valethq/sdk";
import type { ApprovalPolicy, CodexConfig, Sandbox } from "./config";
import type { Gate } from "./gate";
import { dynamicTools } from "./tools";

type Obj = Record<string, unknown>;

/**
 * Feature flags that remove Codex's own tools. Codex has no switch for everything: on code-mode models
 * `apply_patch`, the MCP resource helpers and the multi-agent tools stay. The gate still covers them.
 */
export const BUILTIN_TOOL_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "multi_agent",
  "multi_agent_v2",
  "goals",
  "image_generation",
  "apps",
  "browser_use",
  "computer_use",
  "tool_suggest",
] as const;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b))
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  return out;
}

export interface ThreadOptions {
  cfg: CodexConfig;
  cwd: string;
  model: string;
  sandbox: Sandbox;
  approvalPolicy: ApprovalPolicy;
  hideBuiltinTools: boolean;
  tools: readonly ToolSpec[];
  gate: Gate;
  trust?: { key: string; hash: string };
  /** valet's persona preamble for the thread, sent as developer instructions after the static ones. */
  persona?: string;
}

/**
 * Params shared by `thread/start` and `thread/resume`. A thread's `hooks` table replaces the process-level one,
 * so valet's gate hook and its trust entry are sent with every thread.
 */
export function threadParams(o: ThreadOptions): Obj {
  const ours: Obj = {
    features: {
      hooks: true,
      ...(o.hideBuiltinTools && Object.fromEntries(BUILTIN_TOOL_FEATURES.map((f) => [f, false]))),
    },
    hooks: o.gate.hooks(o.trust),
    ...(o.hideBuiltinTools && { web_search: "disabled" }),
  };
  const developerInstructions = [o.cfg.developerInstructions, o.persona].filter((t) => !!t).join("\n\n");
  return {
    cwd: o.cwd,
    model: o.model,
    approvalPolicy: o.approvalPolicy,
    sandbox: o.sandbox,
    config: deepMerge(
      deepMerge(o.cfg.loadProjectDocs ? {} : { project_doc_max_bytes: 0 }, o.cfg.config ?? {}),
      ours,
    ),
    ...(developerInstructions && { developerInstructions }),
    dynamicTools: dynamicTools(o.tools),
    serviceName: "valet",
  };
}

export type UserInput = { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string };

/** Text goes in as text items, images inline as data URLs. The preamble is not here: it is the thread's developer instructions. */
export async function userInput(
  content: ModelContent[],
  readBlob: (blobId: string) => Promise<Uint8Array>,
): Promise<UserInput[]> {
  const textItem = (text: string): UserInput => ({ type: "text", text, text_elements: [] });
  const items = await Promise.all(
    content.map(async (c): Promise<UserInput | undefined> => {
      if (c.type === "text") return textItem(c.text);
      if (c.type !== "image") return undefined;
      const data = Buffer.from(await readBlob(c.blobId)).toString("base64");
      return { type: "image", url: `data:${c.mime};base64,${data}` };
    }),
  );
  return items.filter((b): b is UserInput => b !== undefined);
}
