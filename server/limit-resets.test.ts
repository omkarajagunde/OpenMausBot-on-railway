import { describe, expect, it, vi } from "vitest";

import { engineLimitFromUsage, LimitResetClock, nearLimitNote } from "./limit-resets.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { parseClaudeUsage, parseCodexUsage, type PlanProviderRow, type PlanWindows } from "./plan-usage.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();

function row(id: string, driver: "claude" | "codex", windows: PlanWindows): PlanProviderRow {
  return { id, name: driver === "claude" ? "Claude" : "Codex", driver, ok: true, error: null, ...windows };
}
/** As the Claude usage endpoint answers (utilization, resets_at). */
const claude = (fiveHour: [number, number | null], weekly: [number, number | null]) => row("claude", "claude", parseClaudeUsage({
  five_hour: { utilization: fiveHour[0], resets_at: fiveHour[1] === null ? null : iso(fiveHour[1]) },
  seven_day: { utilization: weekly[0], resets_at: weekly[1] === null ? null : iso(weekly[1]) },
}));
/** As the ChatGPT usage endpoint answers for Codex (used_percent, reset_at in epoch seconds, window length). */
const codex = (primary: [number, number], secondary: [number, number]) => row("codex", "codex", parseCodexUsage({
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: primary[0], limit_window_seconds: 5 * 3600, reset_at: Math.floor(primary[1] / 1000) },
    secondary_window: { used_percent: secondary[0], limit_window_seconds: 7 * 86400, reset_at: Math.floor(secondary[1] / 1000) },
  },
}));

describe("engineLimitFromUsage", () => {
  it("takes Claude's fullest window and its reset when nothing is at the limit", () => {
    expect(engineLimitFromUsage(claude([92, NOW + 2 * HOUR], [40, NOW + 50 * HOUR]))).toEqual({
      engine: "claude", name: "Claude", driver: "claude", window: "5-hour", usedPercent: 92, resetsAt: NOW + 2 * HOUR, blocked: false,
    });
    expect(engineLimitFromUsage(claude([10, NOW + 2 * HOUR], [95, NOW + 50 * HOUR]))).toMatchObject({ window: "weekly", usedPercent: 95, resetsAt: NOW + 50 * HOUR });
  });

  it("waits for the latest reset of every window at its limit, and knows no time when one has none", () => {
    expect(engineLimitFromUsage(claude([100, NOW + 2 * HOUR], [60, NOW + 50 * HOUR]))).toMatchObject({ blocked: true, window: "5-hour", resetsAt: NOW + 2 * HOUR });
    expect(engineLimitFromUsage(claude([100, NOW + 2 * HOUR], [100, NOW + 50 * HOUR]))).toMatchObject({ blocked: true, window: "weekly", resetsAt: NOW + 50 * HOUR });
    expect(engineLimitFromUsage(claude([100, null], [20, NOW + 50 * HOUR]))).toMatchObject({ blocked: true, resetsAt: null });
  });

  it("reads Codex's primary and secondary windows by their length", () => {
    expect(engineLimitFromUsage(codex([100, NOW + HOUR], [50, NOW + 90 * HOUR]))).toMatchObject({
      engine: "codex", driver: "codex", blocked: true, window: "5-hour", resetsAt: Math.floor((NOW + HOUR) / 1000) * 1000,
    });
    expect(engineLimitFromUsage(codex([10, NOW + HOUR], [97, NOW + 90 * HOUR]))).toMatchObject({ blocked: false, window: "weekly", usedPercent: 97 });
  });

  it("has nothing to say for a row that could not be read, and no time for a row without windows", () => {
    expect(engineLimitFromUsage({ ...claude([1, NOW], [1, NOW]), ok: false, error: "Sign in again in Claude" })).toBeNull();
    expect(engineLimitFromUsage(row("claude", "claude", parseClaudeUsage({})))).toMatchObject({ usedPercent: null, resetsAt: null, blocked: false });
  });
});

describe("nearLimitNote", () => {
  it("tells the turn when its engine is at 90% or more, with the reset", () => {
    const limit = engineLimitFromUsage(claude([92, Date.UTC(2026, 9, 19, 15, 40)], [10, NOW + 90 * HOUR]))!;
    expect(nearLimitNote(limit, "Claude", "UTC")).toBe(" Claude's usage limit is 92% used; it resets Mon 3:40 PM (UTC).");
    expect(nearLimitNote({ ...limit, usedPercent: 89 }, "Claude", "UTC")).toBe("");
    expect(nearLimitNote(undefined, "Claude", "UTC")).toBe("");
  });
});

describe("LimitResetClock and the turns that follow a refusal", () => {
  const accounts = [{ id: "claude", name: "Claude", driver: "claude" as const, environment: {} }];
  const base = { eventId: "e", provider: "claudeAgent", createdAt: "2026-10-19T10:00:00Z" };
  const started = (threadId: string) => ({ ...base, threadId, type: "turn.started" }) as RuntimeEvent;
  const refused = (threadId: string, limitResetsAt?: number) => ({ ...base, threadId, type: "runtime.error", message: "limit", ...(limitResetsAt ? { limitResetsAt } : {}) }) as RuntimeEvent;
  const completed = (threadId: string, ok: boolean) => ({ ...base, threadId, type: "turn.completed", ok }) as RuntimeEvent;
  const clock = (onChange = vi.fn()) => ({ onChange, instance: new LimitResetClock({ accounts: () => accounts, now: () => NOW, onChange }) });

  it("ends the hold when a later turn on the same engine works, even after the engine's turn map forgot it", () => {
    const { instance, onChange } = clock();
    instance.noteRuntimeEvent("claude", started("t1"));
    instance.noteRuntimeEvent(undefined, refused("t1", NOW + 11 * 24 * HOUR));
    instance.noteRuntimeEvent(undefined, completed("t1", false));
    expect(instance.blockedUntil("claude")).toBe(NOW + 11 * 24 * HOUR);
    onChange.mockClear();
    instance.noteRuntimeEvent("claude", started("t2"));
    instance.noteRuntimeEvent(undefined, completed("t2", true));
    expect(instance.blockedUntil("claude")).toBeNull();
    expect(instance.report().engines).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the hold through a failed turn, a working turn on another engine, or a turn whose engine is unknown", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("claude", refused("t1", NOW + HOUR));
    instance.noteRuntimeEvent("claude", started("t2"));
    instance.noteRuntimeEvent(undefined, completed("t2", false));
    instance.noteRuntimeEvent("codex", started("t3"));
    instance.noteRuntimeEvent(undefined, completed("t3", true));
    instance.noteRuntimeEvent(undefined, completed("t4", true));
    expect(instance.blockedUntil("claude")).toBe(NOW + HOUR);
  });

  it("holds nothing for a refusal without an engine-wide reset", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("claude", started("t1"));
    instance.noteRuntimeEvent(undefined, refused("t1"));
    expect(instance.blockedUntil("claude")).toBeNull();
  });
});
