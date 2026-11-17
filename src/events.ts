import type { AgentEvent } from "@valethq/sdk";
import { valetName } from "./tools";

type Obj = Record<string, unknown>;

export interface TurnState {
  turnId?: string;
  /** Agent message / reasoning item ids whose text already went out as deltas. */
  streamedText: Set<string>;
  streamedReasoning: Set<string>;
  /** Last summary index streamed per reasoning item, to separate summary parts. */
  summaryIndex: Map<string, number>;
  /** An agent message ended and nothing else happened since: the next one starts a new paragraph. */
  textEnded: boolean;
  textStarted: Set<string>;
  contextTokens?: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  contextWindow?: number;
  /** The last non-retried error, reported when the turn fails. */
  error?: string;
  /** Tool calls started and not yet ended; closed when the turn ends. */
  openTools: Set<string>;
  /** Warnings already shown in this session; Codex repeats some on every turn. */
  warned: Set<string>;
}

export function newTurnState(contextTokens?: number, warned: Set<string> = new Set()): TurnState {
  return {
    streamedText: new Set(),
    streamedReasoning: new Set(),
    summaryIndex: new Map(),
    textEnded: false,
    textStarted: new Set(),
    contextTokens,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    openTools: new Set(),
    warned,
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

function titleOf(input: Obj): string | undefined {
  for (const k of ["description", "command", "path", "file_path", "pattern", "url", "query", "prompt"]) {
    const v = input[k];
    if (typeof v === "string" && v) return clip(v);
  }
  return undefined;
}

/** `/bin/bash -lc 'echo hi'` -> `echo hi`, preferring Codex's parsed command when it has one. */
function commandText(item: Obj): string {
  const actions = Array.isArray(item.commandActions) ? (item.commandActions as Obj[]) : [];
  const parsed = actions.length === 1 ? str(actions[0]?.command) : undefined;
  return parsed ?? str(item.command) ?? "";
}

function contentText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return (items as Obj[])
    .map((c) => (c.type === "text" || c.type === "inputText" ? (str(c.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function toolName(item: Obj): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "apply_patch";
    case "mcpToolCall":
      return `mcp__${str(item.server) ?? ""}__${str(item.tool) ?? ""}`;
    case "dynamicToolCall": {
      const space = str(item.namespace);
      const tool = str(item.tool) ?? "";
      return space ? `${space}__${tool}` : (valetName(tool) ?? tool);
    }
    case "webSearch":
      return "web_search";
    case "imageView":
      return "view_image";
    case "imageGeneration":
      return "image_generation";
    case "collabAgentToolCall":
      return str(item.tool) ?? "agent";
    default:
      return undefined;
  }
}

function toolStart(item: Obj): AgentEvent | undefined {
  const name = toolName(item);
  if (!name) return undefined;
  const callId = String(item.id);
  switch (item.type) {
    case "commandExecution": {
      const command = commandText(item);
      return { type: "tool-start", callId, name, title: clip(command), input: { command, cwd: item.cwd } };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Obj[]) : [];
      const paths = changes.map((c) => str(c.path) ?? "").filter(Boolean);
      return {
        type: "tool-start",
        callId,
        name,
        title: clip(paths.join(", ")),
        input: { changes: changes.map((c) => ({ path: c.path, kind: (c.kind as Obj | undefined)?.type })) },
      };
    }
    case "webSearch": {
      const query = str(item.query) ?? "";
      return { type: "tool-start", callId, name, ...(query && { title: clip(query) }), input: { query } };
    }
    case "imageView":
      return { type: "tool-start", callId, name, title: str(item.path), input: { path: item.path } };
    case "collabAgentToolCall": {
      const prompt = str(item.prompt);
      return { type: "tool-start", callId, name, ...(prompt && { title: clip(prompt) }), input: { prompt } };
    }
    default: {
      const input = (item.arguments ?? {}) as Obj;
      const title = typeof input === "object" && input ? titleOf(input) : undefined;
      return { type: "tool-start", callId, name, ...(title && { title }), input };
    }
  }
}

function toolEnd(item: Obj, aborted: boolean): AgentEvent | undefined {
  const callId = String(item.id);
  const status = str(item.status);
  const failed = status === "failed" || status === "declined" || item.success === false;
  const cancelled = aborted && (failed || status === "inProgress");
  const end = (output: string, exitCode?: number): AgentEvent => ({
    type: "tool-end",
    callId,
    status: cancelled ? "cancelled" : failed ? "error" : "done",
    ...(output && { output }),
    ...(exitCode !== undefined && { exitCode }),
  });
  switch (item.type) {
    case "commandExecution":
      return end(
        str(item.aggregatedOutput) ?? "",
        typeof item.exitCode === "number" ? item.exitCode : undefined,
      );
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Obj[]) : [];
      return end(changes.map((c) => str(c.diff) ?? "").join("\n"));
    }
    case "mcpToolCall": {
      const error = str((item.error as Obj | null)?.message);
      return end(error ?? contentText((item.result as Obj | null)?.content));
    }
    case "dynamicToolCall":
      return end(contentText(item.contentItems));
    case "collabAgentToolCall":
    case "webSearch":
    case "imageView":
    case "imageGeneration":
      return end("");
    default:
      return undefined;
  }
}

function text(st: TurnState, id: string, delta: string): AgentEvent[] {
  if (!delta) return [];
  const prefix = !st.textStarted.has(id) && st.textEnded ? "\n\n" : "";
  st.textStarted.add(id);
  st.textEnded = false;
  return [{ type: "text-delta", text: prefix + delta }];
}

/** Maps one app-server notification for the active turn to valet events. */
export function mapNotification(method: string, p: Obj, st: TurnState, aborted: boolean): AgentEvent[] {
  switch (method) {
    case "turn/started":
      st.turnId = str((p.turn as Obj | undefined)?.id) ?? st.turnId;
      return [];
    case "item/agentMessage/delta": {
      const id = String(p.itemId);
      st.streamedText.add(id);
      return text(st, id, str(p.delta) ?? "");
    }
    case "item/reasoning/summaryTextDelta": {
      const id = String(p.itemId);
      const index = typeof p.summaryIndex === "number" ? p.summaryIndex : 0;
      const prev = st.summaryIndex.get(id);
      st.summaryIndex.set(id, index);
      st.streamedReasoning.add(id);
      const delta = str(p.delta) ?? "";
      if (!delta) return [];
      return [
        { type: "reasoning-delta", text: prev !== undefined && prev !== index ? `\n\n${delta}` : delta },
      ];
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const delta = str(p.delta);
      return delta ? [{ type: "tool-update", callId: String(p.itemId), outputDelta: delta }] : [];
    }
    case "item/started": {
      const item = (p.item ?? {}) as Obj;
      if (item.type === "contextCompaction") return [{ type: "compaction-start" }];
      if (item.type === "agentMessage" || item.type === "reasoning" || item.type === "userMessage") return [];
      const start = toolStart(item);
      if (start?.type !== "tool-start") return [];
      st.textEnded = false;
      st.openTools.add(start.callId);
      return [start];
    }
    case "item/completed": {
      const item = (p.item ?? {}) as Obj;
      const id = String(item.id);
      if (item.type === "contextCompaction") return [{ type: "compaction-end", status: "completed" }];
      if (item.type === "agentMessage") {
        const events = st.streamedText.has(id) ? [] : text(st, id, str(item.text) ?? "");
        st.textEnded = true;
        return events;
      }
      if (item.type === "reasoning") {
        if (st.streamedReasoning.has(id)) return [];
        const parts = [item.summary, item.content].find((x) => Array.isArray(x) && x.length) as
          | string[]
          | undefined;
        const body = (parts ?? []).join("\n\n");
        return body ? [{ type: "reasoning-delta", text: body }] : [];
      }
      const end = toolEnd(item, aborted);
      if (end?.type !== "tool-end") return [];
      st.openTools.delete(end.callId);
      return [end];
    }
    case "thread/tokenUsage/updated": {
      const usage = (p.tokenUsage ?? {}) as Obj;
      const last = (usage.last ?? {}) as Obj;
      const n = (k: string) => (typeof last[k] === "number" ? (last[k] as number) : 0);
      st.inputTokens += n("inputTokens");
      st.cachedTokens += n("cachedInputTokens");
      st.outputTokens += n("outputTokens");
      if (typeof usage.modelContextWindow === "number") st.contextWindow = usage.modelContextWindow;
      // a compaction reports an empty last request; the context size is unknown until the next one
      if (n("inputTokens") === 0) return [];
      st.contextTokens = n("inputTokens") + n("outputTokens");
      return [{ type: "usage", contextTokens: st.contextTokens }];
    }
    case "error": {
      const message = str((p.error as Obj | undefined)?.message) ?? "codex error";
      if (p.willRetry === true)
        return [{ type: "notice", level: "warning", text: `Codex is retrying: ${message}` }];
      st.error = message;
      return [];
    }
    case "warning": {
      const message = str(p.message);
      if (!message || st.warned.has(message)) return [];
      st.warned.add(message);
      return [{ type: "notice", level: "warning", text: message }];
    }
    case "model/rerouted":
      return [
        {
          type: "notice",
          level: "info",
          text: `Codex switched from ${str(p.fromModel) ?? "?"} to ${str(p.toModel) ?? "?"}`,
        },
      ];
    default:
      return [];
  }
}

/** `turn/completed`: final usage, then finish. */
export function mapCompleted(p: Obj, st: TurnState, aborted: boolean): AgentEvent[] {
  const turn = (p.turn ?? {}) as Obj;
  const usage: AgentEvent = {
    type: "usage",
    ...(st.contextTokens !== undefined && { contextTokens: st.contextTokens }),
    inputTokens: st.inputTokens,
    outputTokens: st.outputTokens,
  };
  const status = str(turn.status);
  const cancelled = aborted || status === "interrupted";
  // Codex does not complete an item it interrupts
  const open: AgentEvent[] = [...st.openTools].map((callId) => ({
    type: "tool-end",
    callId,
    status: cancelled ? "cancelled" : "error",
  }));
  st.openTools.clear();
  if (cancelled) return [...open, usage, { type: "finish", reason: "cancelled" }];
  if (status === "completed") return [...open, usage, { type: "finish", reason: "stop" }];
  const error = str((turn.error as Obj | null)?.message) ?? st.error ?? `codex turn ${status ?? "ended"}`;
  return [...open, usage, { type: "finish", reason: "error", error }];
}
