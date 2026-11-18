import { expect, test } from "bun:test";
import { createCatalog } from "../src/models";

test("custom models follow the listed ones and keep their friendly name", async () => {
  const catalog = createCatalog(
    () => ({ models: [{ id: "a", name: "A" }] }),
    async () => ({}),
    Date.now,
    () => [
      { id: "a", name: "Dup" },
      { id: "mine", name: "Mine" },
    ],
  );
  expect((await catalog.list()).map((m) => [m.id, m.name])).toEqual([
    ["a", "A"],
    ["mine", "Mine"],
  ]);
});
