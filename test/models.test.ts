import { expect, test } from "bun:test";
import { createCatalog, fromCodex } from "../src/models";

test("fromCodex keeps known efforts and takes the first service tier as fast mode", () => {
  expect(
    fromCodex({
      data: [
        {
          id: "m",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "weird" }],
          defaultReasoningEffort: "low",
          serviceTiers: [{ id: "flex" }],
          defaultServiceTier: null,
        },
      ],
    }),
  ).toEqual([
    {
      id: "m",
      name: "m",
      efforts: ["low"],
      defaultEffort: "low",
      input: ["text", "image"],
      fastTier: "flex",
    },
  ]);
});

test("the catalog knows each model's fast tier, defaulting to priority", async () => {
  const catalog = createCatalog(
    () => ({ models: [{ id: "a", fastTier: "turbo" }, { id: "b" }] }),
    async () => ({}),
  );
  expect((await catalog.list()).map((m) => [m.id, m.fast ?? false])).toEqual([
    ["a", true],
    ["b", false],
  ]);
  expect(catalog.fastTier("a")).toBe("turbo");
  expect(catalog.fastTier("b")).toBe("priority");
});
