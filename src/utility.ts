import type { PluginContext, UtilityModel } from "@valethq/sdk";
import type { CodexConfig } from "./config";
import { resolveModel } from "./models";
import { BUILTIN_TOOL_FEATURES, deepMerge } from "./params";
import type { CodexServer } from "./server";
import { utilityModel } from "./settings";

type Obj = Record<string, unknown>;

/** Side jobs run as one turn on an ephemeral, tool-free thread whose system prompt is the job's own. */
export function createUtility(ctx: PluginContext<CodexConfig>, server: CodexServer): UtilityModel {
  return {
    model: () => utilityModel(ctx),
    async complete(req, signal) {
      const picked = utilityModel(ctx);
      if (!picked) throw new Error("no utility model is configured");
      const { model, effort } = resolveModel(picked);
      const { rpc } = await server.connect();
      const off = Object.fromEntries(BUILTIN_TOOL_FEATURES.map((f) => [f, false]));
      const thread = await rpc.request<{ thread: { id: string } }>("thread/start", {
        model,
        cwd: ctx.paths.cache,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: req.system,
        config: deepMerge(ctx.config?.config ?? {}, { features: off, web_search: "disabled" }),
        serviceName: "valet",
      });
      const threadId = thread.thread.id;
      let text = "";
      let turnId: string | undefined;
      const done = new Promise<string>((resolve, reject) => {
        server.attach(threadId, {
          notify(method, p: Obj) {
            if (method === "item/completed") {
              const item = (p.item ?? {}) as Obj;
              if (item.type === "agentMessage" && typeof item.text === "string") text = item.text;
            }
            if (method !== "turn/completed") return;
            const turn = (p.turn ?? {}) as Obj;
            if (turn.status === "completed") resolve(text.trim());
            else
              reject(
                new Error(String((turn.error as Obj | null)?.message ?? `codex turn ${String(turn.status)}`)),
              );
          },
          request: async () => {
            throw new Error("the utility thread has no tools");
          },
          lost: reject,
        });
      });
      void done.catch(() => undefined);
      const abort = () => {
        if (turnId) void rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const r = await rpc.request<{ turn: { id: string } }>("turn/start", {
          threadId,
          input: [{ type: "text", text: req.prompt, text_elements: [] }],
          ...(effort && { effort }),
          summary: "none",
        });
        turnId = r.turn.id;
        if (signal.aborted) abort();
        return await done;
      } finally {
        signal.removeEventListener("abort", abort);
        server.detach(threadId);
        void rpc.request("thread/unsubscribe", { threadId }).catch(() => undefined);
      }
    },
  };
}
