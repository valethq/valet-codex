import { expect, test } from "bun:test";
import {
  createRateNotices,
  createUsage,
  parseUsage,
  untilReset,
  usageBlocks,
  usageMeter,
  windowName,
} from "../src/usage";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 17, 12);
const chatgpt = { account: { type: "chatgpt", email: "x", planType: "pro" } };
const limits = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: (NOW + 2 * HOUR) / 1000 },
    secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: (NOW + 6 * 24 * HOUR) / 1000 },
    credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300 } },
    sol: {
      limitId: "sol",
      limitName: "GPT-6.1-Sol",
      primary: { usedPercent: 70, windowDurationMins: 10_080 },
    },
  },
};

test("parseUsage reads windows from every limit once", () => {
  const snap = parseUsage(chatgpt, limits);
  expect(snap.available).toBe(true);
  expect(snap.plan).toBe("pro");
  expect(snap.credits).toBe("12.50");
  expect(snap.rows.map((r) => [r.limit, r.scope, r.windowMins, r.percent])).toEqual([
    ["codex", undefined, 300, 40],
    ["codex", undefined, 10_080, 10],
    ["sol", "GPT-6.1-Sol", 10_080, 70],
  ]);
  expect(snap.rows[0]?.resetsAt).toBe(NOW + 2 * HOUR);
});

test("parseUsage explains logins without plan limits and survives junk", () => {
  expect(parseUsage({ account: null }, undefined)).toMatchObject({
    available: false,
    reason: expect.stringContaining("No ChatGPT"),
  });
  expect(parseUsage({ account: { type: "apiKey" } }, undefined).reason).toContain("apiKey");
  expect(parseUsage(chatgpt, { rateLimits: { primary: { usedPercent: "lots" } } }).rows).toEqual([]);
  expect(parseUsage(chatgpt, "garbage")).toEqual({ available: true, plan: "pro", rows: [] });
});

test("window names and reset times", () => {
  expect([
    windowName(300),
    windowName(10_080),
    windowName(120),
    windowName(2880),
    windowName(undefined),
  ]).toEqual(["session", "weekly", "2-hour", "2-day", "usage"]);
  expect(untilReset(NOW + 90 * 60_000, NOW)).toBe("1h 30m");
  expect(untilReset(NOW + 20_000, NOW)).toBe("less than a minute");
});

test("a meter shows what is left and where an even pace would be", () => {
  const meter = usageMeter({ limit: "codex", windowMins: 300, percent: 60, resetsAt: NOW + 2 * HOUR }, NOW);
  expect(meter).toEqual({
    type: "meter",
    label: "Session",
    value: 40,
    display: "40% left",
    caption: "+60% in 2h",
    status: "On pace",
    marker: 40,
    tone: "normal",
  });
  expect(usageMeter({ limit: "sol", scope: "Sol", windowMins: 10_080, percent: 96 }, NOW)).toMatchObject({
    label: "Weekly · Sol",
    tone: "critical",
  });
});

test("usageBlocks: reading, unavailable, and a full panel", () => {
  expect(usageBlocks({})).toEqual([{ type: "note", text: "Reading usage...", tone: "normal" }]);
  expect(usageBlocks({ snapshot: { available: false, reason: "No.", rows: [] }, at: NOW }, NOW)[0]).toEqual({
    type: "note",
    text: "No.",
  });
  const full = usageBlocks({ snapshot: parseUsage(chatgpt, limits), at: NOW }, NOW);
  expect(full.map((b) => b.type)).toEqual(["badge", "meter", "meter", "meter", "stat", "note", "action"]);
  expect(JSON.stringify(full.at(-1))).toContain("refresh");
});

test("createUsage caches, skips the limits call without a ChatGPT login, and folds updates in", async () => {
  const calls: string[] = [];
  let account: unknown = chatgpt;
  let now = NOW;
  const usage = createUsage(
    async (method) => {
      calls.push(method);
      return method === "account/read" ? account : limits;
    },
    { warn() {} },
    () => now,
  );
  await usage.refresh();
  await usage.refresh();
  expect(calls).toEqual(["account/read", "account/rateLimits/read"]);
  usage.update({ limitId: "codex", primary: { usedPercent: 55, windowDurationMins: 300 } });
  const meters = JSON.stringify(await usage.view());
  expect(meters).toContain("45% left");
  account = { account: { type: "apiKey" } };
  now += 11_000;
  await usage.refresh(true);
  expect(calls.slice(2)).toEqual(["account/read"]);
});

test("createUsage reports failures and backs off", async () => {
  let n = 0;
  const usage = createUsage(
    async () => {
      n++;
      throw new Error("codex account authentication required to read rate limits");
    },
    { warn() {} },
    () => NOW,
  );
  const blocks = await usage.view();
  expect(blocks[0]).toEqual({
    type: "note",
    text: "Could not read usage: codex account authentication required to read rate limits",
    tone: "warning",
  });
  await usage.refresh();
  expect(n).toBe(1);
});

test("rate notices: one warning per window period above the threshold, an error when reached", () => {
  const notices = createRateNotices(
    () => 80,
    () => NOW,
  );
  const snap = (pct: number, resetsAt = (NOW + HOUR) / 1000, reached: string | null = null) => ({
    limitId: "codex",
    primary: { usedPercent: pct, windowDurationMins: 300, resetsAt },
    rateLimitReachedType: reached,
  });
  expect(notices(snap(50))).toEqual([]);
  expect(notices(snap(85))).toEqual([
    { type: "notice", level: "warning", text: "Approaching Codex's session limit (85% used)" },
  ]);
  expect(notices(snap(90))).toEqual([]);
  expect(notices(snap(85, (NOW + 6 * HOUR) / 1000))).toHaveLength(1);
  expect(notices(snap(100, (NOW + HOUR) / 1000, "rate_limit_reached"))).toEqual([
    { type: "notice", level: "error", text: "Codex hit its session limit. It resets in 1h." },
  ]);
  expect(notices(snap(100, (NOW + HOUR) / 1000, "rate_limit_reached"))).toEqual([]);
});
