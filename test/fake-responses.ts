type Obj = Record<string, unknown>;

const sse = (events: Obj[]) =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 105,
};

function reply(item: Obj): Response {
  const body = sse([
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", usage } },
  ]);
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const message = (text: string) =>
  reply({
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });

const textOf = (item: Obj | undefined): string =>
  Array.isArray(item?.content) ? (item.content as Obj[]).map((c) => String(c.text ?? "")).join("") : "";

/**
 * A Responses API stand-in. The last user message "CALL <tool> <json args>" makes the model call that tool;
 * a tool result makes it answer "result: <output>"; anything else gets "pong".
 */
export function fakeResponses() {
  const requests: Obj[] = [];
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Obj;
      requests.push(body);
      const input = (body.input ?? []) as Obj[];
      const last = input.at(-1);
      if (last?.type === "function_call_output")
        return message(
          `result: ${typeof last.output === "string" ? last.output : JSON.stringify(last.output)}`,
        );
      const user = [...input].reverse().find((i) => i.role === "user");
      const m = /^CALL (\S+) (.*)$/s.exec(textOf(user));
      if (!m) return message("pong");
      calls++;
      return reply({
        type: "function_call",
        id: `fc_${calls}`,
        call_id: `call_${calls}`,
        name: m[1],
        arguments: m[2],
        status: "completed",
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
