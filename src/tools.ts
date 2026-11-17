import type { ToolResult, ToolSpec } from "@valethq/sdk";

/**
 * valet's tools reach the model as flat Codex dynamic tools named `valet__<name>`. The prefix keeps names such as
 * `exec` clear of Codex's own (code mode has an `exec` tool), and flat names work with providers that drop
 * Responses API tool namespaces.
 */
export const TOOL_PREFIX = "valet__";

export const codexName = (name: string) => `${TOOL_PREFIX}${name}`;

/** valet's tool name for a Codex dynamic tool name, or undefined when it isn't one of valet's. */
export const valetName = (name: string): string | undefined =>
  name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : undefined;

export function dynamicTools(specs: readonly ToolSpec[]): unknown[] {
  return [...specs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      type: "function",
      name: codexName(s.name),
      description: s.description,
      inputSchema: s.inputSchema,
    }));
}

export type DynamicContent = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };

/** A ToolResult as a `item/tool/call` response; images go inline as data URLs. */
export async function toDynamicResponse(
  result: ToolResult,
  readBlob: (blobId: string) => Promise<Uint8Array>,
): Promise<{ contentItems: DynamicContent[]; success: boolean }> {
  const contentItems = await Promise.all(
    result.content.map(async (c): Promise<DynamicContent> => {
      if (c.type === "text") return { type: "inputText", text: c.text };
      try {
        const data = Buffer.from(await readBlob(c.blobId)).toString("base64");
        return { type: "inputImage", imageUrl: `data:${c.mime};base64,${data}` };
      } catch {
        return { type: "inputText", text: `[image ${c.mime} blob ${c.blobId} could not be read]` };
      }
    }),
  );
  return {
    contentItems: contentItems.length ? contentItems : [{ type: "inputText", text: "" }],
    success: !result.isError,
  };
}
