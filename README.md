# valet-codex

`inference@1` agent provider `codex`, built on the Codex CLI's app-server (`codex app-server`, JSON-RPC over stdio).

A [valet](https://github.com/valethq/valet-core) plugin and a sibling of `valet-claudecode`: Codex runs the loop and its own tools, and valet mirrors the stream into messages and parts. It authenticates as whoever is signed in to `codex` on the host (ChatGPT or API key), or uses any model provider configured for Codex, so there is no key in valet.

Imports `@valethq/sdk` only and has no runtime dependencies: it spawns the installed `codex` binary. Checked against Codex CLI 0.169.0.

## How it works

- **One app-server for the plugin.** It starts on first use (a session, the model list, the usage panel), serves every session, and stops after `idleCloseMs` with no thread attached. If it dies, the running turn fails and the next prompt starts a new one and resumes the thread.
- **One Codex thread per valet session.** The thread id is the session's `resumeId`. `open()` resumes it (`thread/resume`) or starts a new one; a thread that can't be resumed is replaced, and valet sends the preamble again.
- **Persona in developer instructions.** valet's preamble goes in `developerInstructions` on `thread/start` / `thread/resume` (after the static `developerInstructions` option), not in the user message, so the identical persona sits ahead of the per-chat environment context and user text and new chats can share the cached prefix. Those fields only exist on start and resume, so a thread without turns is replaced when the preamble arrives, and the preamble is kept in plugin kv (`preamble:<threadId>`) and sent again on every resume (idle unload, valet restart). Codex's own AGENTS.md loading is off (`project_doc_max_bytes = 0`) because the preamble already carries it; set `loadProjectDocs` to turn it back on. Codex has no setting to skip the global `CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`): `ignoreGlobalAgentsMd` runs the app-server under `bwrap --dev-bind / /` with an empty file mounted read-only over whichever of those exists, which Codex then skips. It needs `bwrap` and fails the start without it; with neither file present Codex starts as usual.
- **Turns** are `turn/start`; notifications for the thread become valet events (`item/agentMessage/delta` -> text, reasoning summaries -> reasoning, items -> tool parts, `thread/tokenUsage/updated` -> usage). Codex's prompt cache key is the thread id, so a session keeps its cache across turns and resumes.
- **Models.** `listModels` reads `model/list` (cached 5 min) and lists each model once with its `efforts` and `fast` (from Codex's service tiers). Effort and fast mode arrive as model options (`open({ effort, fast })`, `setModel(model, { effort, fast })`) and go on the next `turn/start` as `reasoningEffort` / `serviceTier`; nothing is encoded in the model id. Codex doesn't report context windows in `model/list`; the default 272k is replaced by the window the first turn reports.
- **Abort** sends `turn/interrupt`. A turn the caller stopped reading is interrupted before the next one starts. Tool items Codex leaves open on an interrupt are closed as cancelled.
- **Compaction** (`compact()`) is `thread/compact/start`; Codex's `contextCompaction` item (manual or automatic) drives `compaction-start` / `compaction-end`. Codex takes no compaction instructions, so valet's are dropped.
- **Idle threads** are unsubscribed after `idleCloseMs` (default 15 min) and resumed by the next prompt.
- **Utility model** jobs (session names and the like) run as one turn on an ephemeral thread with the job's own system prompt (`baseInstructions`) and Codex's tools switched off.

## Tools

**valet's tools** go to Codex as dynamic tools named `valet__<name>` (sent with `thread/start` / `thread/resume`). Codex calls them back with `item/tool/call`, and the plugin runs them through `ToolSurface.call`, which gates them; image results go back as data URLs. No MCP server and no HTTP transport are involved. The prefix matters: Codex's code mode has its own `exec` tool, and a dynamic tool named `exec` is silently hidden. Names stay flat because some Responses API providers drop tool namespaces.

**Codex's own tools are gated by valet's `tool.call` gate** through a Codex `PreToolUse` command hook:

- The hook runs `bun src/gate-hook.ts <url>`, which posts the hook input to the plugin's `/plugins/valet-codex/gate` route (bearer token in `VALET_CODEX_GATE_TOKEN`, set only for the app-server). The route finds the session by Codex thread id and runs `ToolSurface.authorize`. A denial becomes a Codex deny (and a failed tool part in the chat, since Codex never creates an item for it). A rewrite becomes `updatedInput`. `denyTools` names are always denied.
- **It fails closed.** Codex lets a tool run when a hook errors or prints garbage, so the script exits 2 (block) on any failure: valet down, bad token, HTTP error.
- **It is verified.** Codex skips hooks that are not trusted. The plugin defines the hook at process level (`-c hooks.PreToolUse=...`) only to read its trust hash from `hooks/list`, then sends the hook and a `hooks.state` trust entry with every thread. A thread's `hooks` table replaces the process-level one, so a thread without both would run ungated. After each thread start the plugin asks `hooks/list` for that thread, and a thread where the hook is not enabled and trusted is unsubscribed and refused. Nothing is written to `~/.codex`.
- Coverage is Codex's: shell (`Bash`), `apply_patch`, MCP tools and other local function tools. Hosted tools such as web search don't go through hooks. Subagent hooks carry the parent thread id, so they map to the same session; that path was not exercised here (it needs a model that spawns subagents).

**Approvals.** With `approvalPolicy` `on-request` (default) or `untrusted`, Codex's approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`) become valet `permission` events, which valet-agent answers through the `tool.call` gate. MCP elicitations are declined. `request_user_input` gets no answers, since an agent provider can't ask the user mid-turn.

**`hideBuiltinTools`** turns off the Codex features that add tools (shell, unified exec, `view_image`, multi-agent, goals, image generation, apps, browser and computer use, tool suggestions) and web search. Codex has no switch for everything: on code-mode models (`gpt-6.x`) `apply_patch`, the MCP resource helpers and the code-mode collaboration tools stay. The gate still covers them, and `denyTools: ["apply_patch"]` blocks edits outright.

## Plan usage

The plugin's settings page shows the plan's rate-limit windows (a view-only `settings` panel above the config form) (session, weekly, and per-model limits) as meters with an even-pace marker, plus credits when the plan has them. It reads `account/read` and `account/rateLimits/read` over the shared app-server (no model turn), caches for a minute, retries a failure after 5 minutes, and folds in the `account/rateLimits/updated` snapshots Codex sends after each response. Those snapshots also produce chat notices: a warning once per window period above `minRateLimitNoticePercent` (default 80), and an error with the reset time when a limit is reached.

Logins without plan limits (API key, custom provider, nobody signed in) get a one-line explanation. **The ChatGPT path is untested**: no ChatGPT account was signed in while building this. It was written against the 0.169.0 protocol types (`RateLimitSnapshot`: `primary` / `secondary` windows with `usedPercent`, `windowDurationMins`, `resetsAt` in epoch seconds), and the parser treats every field as optional. Run the live test with a ChatGPT login to see real data.

## Config

Settings are this plugin's config (valet-core 12.1): the UI edits them through core, and every value applies at the next prompt or app-server start.
(`plugins.valet-codex.config`)

| Key                         | Meaning                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codexPath`                 | The `codex` binary. Default: `codex` on PATH, then `~/.local/bin/codex`.                                                                                                                    |
| `args`                      | Extra `codex app-server` arguments, e.g. `["-c", "model_provider=\"my-proxy\""]`. Applied when the app-server starts.                                                                       |
| `env`                       | Extra environment for the app-server, e.g. `{ "CODEX_HOME": "/srv/codex" }`.                                                                                                                |
| `config`                    | Codex config sent with every thread (nested tables, as in `config.toml`). Part of the cached prefix: keep it static.                                                                        |
| `sandbox`                   | `read-only` / `workspace-write` (default) / `danger-full-access`.                                                                                                                           |
| `approvalPolicy`            | `untrusted` / `on-request` (default) / `never`.                                                                                                                                             |
| `denyTools`                 | Hook tool names the gate always denies: `Bash`, `apply_patch`, `mcp__<server>__<tool>`, ...                                                                                                 |
| `hideBuiltinTools`          | Default `false`. Turn off Codex's own tools where Codex allows it (see Tools).                                                                                                              |
| `developerInstructions`     | Static developer instructions for every thread, ahead of valet's persona (which is added per thread, never configured here).                                                                |
| `loadProjectDocs`           | Default `false`: Codex does not load the workspace's AGENTS.md (valet's persona already has it). `true` leaves Codex's default.                                                             |
| `ignoreGlobalAgentsMd`      | Default `false`. Hide `CODEX_HOME`'s `AGENTS.md` / `AGENTS.override.md` via bwrap (see Persona).                                                                                            |
| `reasoningSummary`          | `auto` (default) / `concise` / `detailed` / `none`: how much reasoning streams as reasoning parts.                                                                                          |
| `idleCloseMs`               | Default 900000. Unsubscribe idle threads and stop an unused app-server after this long; `0` never does.                                                                                     |
| `minRateLimitNoticePercent` | Default 80. "Approaching limit" warnings start here.                                                                                                                                        |
| `utilityModel`              | Default `gpt-6-luna-low`. A trailing `-<effort>` still works for the utility path. Empty turns side jobs off.                                                                               |
| `models`                    | Replace `model/list`: `{ id, name?, contextWindow?, maxOutputTokens?, efforts?, defaultEffort?, fastTier?, fastByDefault?, input? }`. Needed for providers whose models Codex doesn't list. |

Sandbox, approvals and `hideBuiltinTools` are read when a thread loads (start, resume after idle), so config changes apply then. `args`, `env` and `ignoreGlobalAgentsMd` apply when the app-server next starts.

## Tests

- `bun test` runs the unit tests against a fake app-server (`test/fake-codex.ts`) and boots the real kernel once.
- `test/codex.test.ts` drives the **real** `codex app-server` against a local fake Responses API (`test/fake-responses.ts`): no account, no network. It covers a plain turn, a shell call allowed and denied by the gate (the denied command does not run), valet's dynamic tools, resume, the utility model and `hideBuiltinTools`. It is skipped when `codex` isn't installed (`VALET_CODEX_PATH` overrides the lookup).
- `test/live.test.ts` runs a real model when `VALET_LIVE_CODEX=1`. `VALET_LIVE_CODEX_MODEL` picks the model, `VALET_LIVE_CODEX_ARGS` (JSON array) adds app-server arguments, and `CODEX_HOME` and provider keys come from the environment. For a custom Responses provider whose models think, add `["-c", "show_raw_agent_reasoning=true"]`: some providers reject follow-up requests unless the reasoning content is sent back.
