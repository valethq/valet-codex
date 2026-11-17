import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "./spawn";

type Launch = Omit<SpawnOptions, "onStderr">;

/** Codex reads the first non-empty one of these from CODEX_HOME, with no setting to skip them. */
const GLOBAL_FILES = ["AGENTS.override.md", "AGENTS.md"];

/**
 * Runs Codex under bwrap with an empty file mounted over each global AGENTS file that exists, so Codex
 * sees them empty and skips them. Everything else is the host filesystem as is (`--dev-bind / /`).
 */
export function hideGlobalAgents(launch: Launch, scratchDir: string): Launch {
  const home = launch.env.CODEX_HOME || join(homedir(), ".codex");
  const present = GLOBAL_FILES.map((f) => join(home, f)).filter((p) => existsSync(p));
  if (present.length === 0) return launch;
  const bwrap = Bun.which("bwrap");
  if (!bwrap) throw new Error("ignoring the global .codex AGENTS.md needs bwrap (bubblewrap) on PATH");
  mkdirSync(scratchDir, { recursive: true });
  const empty = join(scratchDir, "empty-agents.md");
  writeFileSync(empty, "");
  return {
    ...launch,
    command: bwrap,
    args: [
      "--dev-bind",
      "/",
      "/",
      ...present.flatMap((p) => ["--ro-bind", empty, p]),
      "--",
      launch.command,
      ...launch.args,
    ],
  };
}
