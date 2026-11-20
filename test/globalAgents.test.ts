import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hideGlobalAgents } from "../src/globalAgents";
import { tempDirs } from "./helpers";

const temp = tempDirs();
afterAll(() => temp.cleanup());

const launch = (home: string) => ({
  command: "/bin/codex",
  args: ["app-server"],
  env: { CODEX_HOME: home },
  cwd: "/tmp",
});

test("no global AGENTS files: launch is unchanged", () => {
  const l = launch(temp.make("valet-codex-home-"));
  expect(hideGlobalAgents(l, temp.make("valet-codex-scratch-"))).toBe(l);
});

test.skipIf(!Bun.which("bwrap"))("each global AGENTS file present gets an empty file mounted over it", () => {
  const home = temp.make("valet-codex-home-");
  const scratch = temp.make("valet-codex-scratch-");
  writeFileSync(join(home, "AGENTS.md"), "global");
  writeFileSync(join(home, "AGENTS.override.md"), "override");
  const l = hideGlobalAgents(launch(home), scratch);
  const empty = join(scratch, "empty-agents.md");
  expect(l.command).toBe(Bun.which("bwrap") as string);
  expect(l.args).toEqual([
    "--dev-bind",
    "/",
    "/",
    "--ro-bind",
    empty,
    join(home, "AGENTS.override.md"),
    "--ro-bind",
    empty,
    join(home, "AGENTS.md"),
    "--",
    "/bin/codex",
    "app-server",
  ]);
  expect(readFileSync(empty, "utf8")).toBe("");
});
