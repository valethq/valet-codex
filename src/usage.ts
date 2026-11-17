import type { AgentEvent, SettingsBlock, SettingsTone } from "@valethq/sdk";

/** Pace within this many points of an even burn-down counts as "on pace". */
const PACE_SLACK = 5;
const FRESH_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const MANUAL_GAP_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
const FIRST_WAIT_MS = 3_000;
const SESSION_MINS = 300;
const WEEK_MINS = 10_080;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface UsageRow {
  /** Which limit this window belongs to (`limitId`), "codex" for the main one. */
  limit: string;
  scope?: string;
  windowMins?: number;
  /** Share of the window used, 0-100. */
  percent: number;
  /** Epoch ms. */
  resetsAt?: number;
}

export interface UsageSnapshot {
  available: boolean;
  /** Why limits are unavailable, shown in the panel. */
  reason?: string;
  plan?: string;
  rows: UsageRow[];
  reached?: string;
  credits?: string;
}

/** Time left until `resetsAt` (epoch ms). */
export function untilReset(resetsAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const rh = h % 24;
  return rh ? `${Math.floor(h / 24)}d ${rh}h` : `${Math.floor(h / 24)}d`;
}

export function windowName(mins: number | undefined): string {
  if (mins === SESSION_MINS) return "session";
  if (mins === WEEK_MINS) return "weekly";
  if (mins === undefined) return "usage";
  return mins % 1440 === 0 ? `${mins / 1440}-day` : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute`;
}

/** Rows from one `RateLimitSnapshot` (primary and secondary windows). The protocol is not stable: trust nothing. */
export function snapshotRows(raw: unknown): UsageRow[] {
  if (!isObj(raw)) return [];
  const limit = str(raw.limitId) ?? "codex";
  const scope = limit === "codex" ? undefined : (str(raw.limitName) ?? limit);
  const rows: UsageRow[] = [];
  for (const w of [raw.primary, raw.secondary]) {
    if (!isObj(w)) continue;
    const percent = num(w.usedPercent);
    if (percent === undefined) continue;
    const windowMins = num(w.windowDurationMins);
    const resets = num(w.resetsAt);
    rows.push({
      limit,
      ...(scope && { scope }),
      ...(windowMins !== undefined && { windowMins }),
      percent: Math.min(100, Math.max(0, percent)),
      ...(resets !== undefined && { resetsAt: resets * 1000 }),
    });
  }
  return rows;
}

/** `account/read` + `account/rateLimits/read` replies as one snapshot. */
export function parseUsage(account: unknown, limits: unknown): UsageSnapshot {
  const acct = isObj(account) && isObj(account.account) ? account.account : undefined;
  if (!acct) return { available: false, reason: "No ChatGPT account is signed in to Codex.", rows: [] };
  if (acct.type !== "chatgpt")
    return {
      available: false,
      reason: `Plan limits only apply to ChatGPT sign-ins (this login is ${String(acct.type)}).`,
      rows: [],
    };
  const plan = str(acct.planType);
  const o = isObj(limits) ? limits : {};
  const main = isObj(o.rateLimits) ? o.rateLimits : undefined;
  const others = isObj(o.rateLimitsByLimitId) ? Object.values(o.rateLimitsByLimitId) : [];
  const seen = new Set<string>();
  const rows: UsageRow[] = [];
  for (const snap of [main, ...others]) {
    for (const r of snapshotRows(snap)) {
      const key = `${r.limit}:${r.windowMins}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }
  const reached = isObj(main) ? str(main.rateLimitReachedType) : undefined;
  const credits = isObj(main) && isObj(main.credits) ? main.credits : undefined;
  const balance = credits && !credits.unlimited ? str(credits.balance) : undefined;
  return {
    available: true,
    ...(plan && { plan }),
    rows,
    ...(reached && { reached }),
    ...(balance && { credits: balance }),
  };
}

const capitalize = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);
const label = (r: UsageRow) => `${capitalize(windowName(r.windowMins))}${r.scope ? ` · ${r.scope}` : ""}`;
const tone = (percent: number): SettingsTone =>
  percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal";

/** One meter per window: the bar shows what is left, the marker where an even burn-down would be by now. */
export function usageMeter(r: UsageRow, now: number): SettingsBlock {
  const used = Math.round(r.percent);
  const left = 100 - used;
  const remaining = r.resetsAt === undefined ? 0 : Math.max(0, r.resetsAt - now);
  const span = r.windowMins === undefined ? undefined : r.windowMins * 60_000;
  const pace = remaining > 0 && span !== undefined;
  const burned = pace ? Math.min(1, Math.max(0, 1 - remaining / span)) * 100 : 0;
  const status = !pace
    ? undefined
    : used > burned + PACE_SLACK
      ? "Over pace"
      : used < burned - PACE_SLACK
        ? "Under pace"
        : "On pace";
  return {
    type: "meter",
    label: label(r),
    value: left,
    display: `${left}% left`,
    ...(used > 0 && remaining > 0 && { caption: `+${used}% in ${untilReset(now + remaining, now)}` }),
    ...(status && { status }),
    ...(pace && { marker: 100 - burned }),
    tone: tone(r.percent),
  };
}

export interface UsageState {
  snapshot?: UsageSnapshot;
  at?: number;
  error?: string;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function usageBlocks(s: UsageState, now = Date.now()): SettingsBlock[] {
  const out: SettingsBlock[] = [];
  const snap = s.snapshot;
  if (!snap) {
    out.push({
      type: "text",
      text: s.error ? `Could not read usage: ${s.error}` : "Reading usage...",
      tone: s.error ? "warning" : "normal",
    });
  } else if (!snap.available) {
    out.push({ type: "text", text: snap.reason ?? "Plan limits are not available for this login." });
  } else {
    out.push({
      type: "group",
      title: "Plan usage",
      blocks: [
        ...(snap.plan ? [{ type: "badge" as const, text: capitalize(snap.plan) }] : []),
        ...(snap.reached
          ? [{ type: "badge" as const, text: "Limit reached", tone: "critical" as const }]
          : []),
        ...snap.rows.map((r) => usageMeter(r, now)),
        ...(snap.credits ? [{ type: "stat" as const, label: "Credits", value: snap.credits }] : []),
      ],
    });
    if (s.error) out.push({ type: "text", text: `Could not refresh usage: ${s.error}`, tone: "warning" });
  }
  if (snap || s.error)
    out.push({
      type: "group",
      layout: "row",
      blocks: [
        ...(s.at === undefined ? [] : [{ type: "text" as const, text: `Updated ${clock(s.at)}` }]),
        { type: "button", label: "Refresh now", action: "refresh" },
      ],
    });
  return out;
}

export interface UsageService {
  view(): Promise<SettingsBlock[]>;
  refresh(force?: boolean): Promise<void>;
  /** Folds an `account/rateLimits/updated` snapshot into the cached reading. */
  update(snapshot: unknown): void;
}

/** Reads plan usage over the shared app-server (no model turn) and caches it. */
export function createUsage(
  request: (method: string, params?: unknown) => Promise<unknown>,
  log: { warn(msg: string, data?: Record<string, unknown>): void },
  now = Date.now,
): UsageService {
  const state: UsageState = {};
  let failedAt: number | undefined;
  let inflight: Promise<void> | undefined;

  async function read(): Promise<UsageSnapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out reading usage")), FETCH_TIMEOUT_MS);
    });
    try {
      const account = await Promise.race([request("account/read", {}), timeout]);
      const signedIn = isObj(account) && isObj(account.account) && account.account.type === "chatgpt";
      const limits = signedIn
        ? await Promise.race([request("account/rateLimits/read", {}), timeout])
        : undefined;
      return parseUsage(account, limits);
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh(force = false): Promise<void> {
    if (inflight) return inflight;
    const t = now();
    if (state.at !== undefined && t - state.at < (force ? MANUAL_GAP_MS : FRESH_MS)) return Promise.resolve();
    if (!force && failedAt !== undefined && t - failedAt < RETRY_MS) return Promise.resolve();
    inflight = read()
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.at = now();
        delete state.error;
        failedAt = undefined;
      })
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        failedAt = now();
        log.warn("codex usage read failed", { error: state.error });
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    refresh,
    update(snapshot) {
      const snap = state.snapshot;
      const fresh = snapshotRows(snapshot);
      if (!snap?.available || !fresh.length) return;
      const key = (r: UsageRow) => `${r.limit}:${r.windowMins}`;
      const replaced = new Set(fresh.map(key));
      snap.rows = [...snap.rows.filter((r) => !replaced.has(key(r))), ...fresh];
      state.at = now();
    },
    async view() {
      const pending = refresh();
      if (!state.snapshot && !state.error) {
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([pending, new Promise<void>((r) => (wait = setTimeout(r, FIRST_WAIT_MS)))]);
        clearTimeout(wait);
      }
      return usageBlocks(state, now());
    },
  };
}

/**
 * Turns `account/rateLimits/updated` snapshots (sent after every model response) into chat notices: a warning
 * once per window period when usage crosses `min()` percent, and an error when a limit is reached.
 */
export function createRateNotices(min: () => number, now = Date.now) {
  const warned = new Set<string>();
  return (snapshot: unknown): AgentEvent[] => {
    const rows = snapshotRows(snapshot);
    const events: AgentEvent[] = [];
    const reached = isObj(snapshot) ? str(snapshot.rateLimitReachedType) : undefined;
    if (reached) {
      const full = rows
        .filter((r) => r.percent >= 100)
        .sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
      const key = `reached:${full?.limit}:${full?.windowMins}:${full?.resetsAt}`;
      if (!warned.has(key)) {
        warned.add(key);
        const scope = full ? windowName(full.windowMins) : "usage";
        const reset =
          full?.resetsAt === undefined ? "" : ` It resets in ${untilReset(full.resetsAt, now())}.`;
        events.push({ type: "notice", level: "error", text: `Codex hit its ${scope} limit.${reset}` });
      }
      return events;
    }
    for (const r of rows) {
      if (r.percent < min() || r.percent >= 100) continue;
      const key = `${r.limit}:${r.windowMins}:${r.resetsAt}`;
      if (warned.has(key)) continue;
      warned.add(key);
      const scope = `${windowName(r.windowMins)}${r.scope ? ` (${r.scope})` : ""}`;
      events.push({
        type: "notice",
        level: "warning",
        text: `Approaching Codex's ${scope} limit (${Math.round(r.percent)}% used)`,
      });
    }
    return events;
  };
}
