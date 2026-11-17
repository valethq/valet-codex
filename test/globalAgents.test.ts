import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hideGlobalAgents } from "../src/globalAgents";

const launch = (home: string) => ({
  command: "/bin/codex",
  args: ["app-server"],
  env: { CODEX_HOME: home },
  cwd: "/tmp",
});

test("no global AGENTS files: launch is unchanged", () => {
  const l = launch(mkdtempSync(join(tmpdir(), "valet-codex-home-")));
  expect(hideGlobalAgents(l, mkdtempSync(join(tmpdir(), "valet-codex-scratch-")))).toBe(l);
});

test.skipIf(!Bun.which("bwrap"))("each global AGENTS file present gets an empty file mounted over it", () => {
  const home = mkdtempSync(join(tmpdir(), "valet-codex-home-"));
  const scratch = mkdtempSync(join(tmpdir(), "valet-codex-scratch-"));
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
