import { describe, it, expect } from "vitest";
import { orchEventToast, nextOrchCursor } from "../utils/orchEvents";
import { buildTasksUrl } from "../components/TasksView.jsx";

describe("orchEventToast", () => {
  it("gives each kind worth telling the user about its own tone", () => {
    expect(orchEventToast({ kind: "refusal", rule: "scope", detail: "W1 touched a file it does not own" }))
      .toEqual({ type: "warning", message: "Move refused · [scope] · W1 touched a file it does not own" });
    expect(orchEventToast({ kind: "gate_fail", detail: "exit 1" }).type).toBe("error");
    expect(orchEventToast({ kind: "halted_for_decision", detail: "which engine?" }).type).toBe("warning");
    expect(orchEventToast({ kind: "run_closed", detail: "closed COMPLETED" }))
      .toEqual({ type: "success", message: "Run closed · closed COMPLETED" });
    // Shapes taken from the live feed on 2026-11-22.
    expect(orchEventToast({ kind: "run_closed", detail: "closed ABANDONED" }).type).toBe("info");
    // The machine field wins over the wording when both are present.
    expect(orchEventToast({ kind: "run_closed", close_status: "COMPLETED", detail: "closed" }).type).toBe("success");
    expect(orchEventToast({ kind: "run_closed", close_status: "ABANDONED", detail: "was COMPLETED before" }).type).toBe("info");
    expect(orchEventToast({ kind: "run_closed", detail: "closed HALTED_FOR_DECISION" }).type).toBe("info");
    expect(orchEventToast({ kind: "refusal", worker: null, rule: "the gate is not answerable to the implementation",
      detail: "the gate script changed after the plan froze" }).message)
      .toBe("Move refused · [the gate is not answerable to the implementation] · the gate script changed after the plan froze");
  });

  it("stays quiet for a passing gate, an ordinary transition and junk", () => {
    expect(orchEventToast({ kind: "gate_pass" })).toBeNull();
    expect(orchEventToast({ kind: null, step: "dispatch" })).toBeNull();
    expect(orchEventToast({ kind: "something_new" })).toBeNull();
    expect(orchEventToast(null)).toBeNull();
    // An inherited property name is not a kind.
    expect(orchEventToast({ kind: "toString" })).toBeNull();
  });

  it("flattens and clips worker-supplied detail, and keeps it as plain text", () => {
    const shown = orchEventToast({ kind: "refusal", detail: `<b>x</b>\n${"y".repeat(400)}` });
    expect(shown.message).toContain("<b>x</b> y");
    expect(shown.message.length).toBeLessThan(200);
    expect(shown.message.endsWith("…")).toBe(true);
  });
});

describe("nextOrchCursor", () => {
  it("takes the seed, then only ever moves forward", () => {
    expect(nextOrchCursor(null, { cursor: 0 })).toBe(0);
    expect(nextOrchCursor(null, { cursor: 41 })).toBe(41);
    expect(nextOrchCursor(41, { cursor: 50 })).toBe(50);
    expect(nextOrchCursor(41, { cursor: 7 })).toBe(41);
  });

  it("ignores a cursor that is not a non-negative integer", () => {
    expect(nextOrchCursor(41, { cursor: "50" })).toBe(41);
    expect(nextOrchCursor(41, { cursor: -1 })).toBe(41);
    expect(nextOrchCursor(null, {})).toBeNull();
    expect(nextOrchCursor(null, undefined)).toBeNull();
  });
});

describe("buildTasksUrl", () => {
  const base = "http://127.0.0.1:8430";
  const orch = { up: true, base, buckets: {}, orch: true };
  const old = { up: true, base, buckets: { p: {} }, orch: false };

  it("opens an orch framework on the focused pane's runs", () => {
    expect(buildTasksUrl(orch, { sessionId: "term 1" })).toBe(`${base}/app?session=term+1`);
    expect(buildTasksUrl(orch, {})).toBe(`${base}/app`);
  });

  it("a run named by a toast wins over the session", () => {
    expect(buildTasksUrl(orch, { sessionId: "t1", runId: "orch-2026-x" })).toBe(`${base}/app?run=orch-2026-x`);
  });

  it("never sends session or run to an older framework, and keeps its bucket link", () => {
    expect(buildTasksUrl(old, { bucket: "p", sessionId: "t1", runId: "r" })).toBe(`${base}/app?bucket=p`);
    expect(buildTasksUrl(old, {})).toBe(`${base}/app`);
  });

  it("is null while the framework is not up", () => {
    expect(buildTasksUrl({ up: false, base, reason: "unreachable" }, { sessionId: "t" })).toBeNull();
    expect(buildTasksUrl(null, {})).toBeNull();
  });
});
