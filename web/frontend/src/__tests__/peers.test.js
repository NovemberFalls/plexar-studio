import { describe, it, expect, vi } from "vitest";
import {
  describePeerStatus, PEER_REASONS, sessionSocketPath, peerDragData, parsePeerDragData,
  accessPairError, peerCreateBody, reconcilePeerSessions, peerChoiceOptions, peersApi,
  dropUnpairedPeerSessions, PEER_ADOPT_GRACE_MS, followPeerLabels,
} from "../utils/peers";

describe("describePeerStatus", () => {
  it("renders every reason differently, each with its own remedy", () => {
    const reasons = ["unreachable", "unauthorized", "access_required", "access_refused", "remote_disabled"];
    const ds = reasons.map((reason) => describePeerStatus({ reachable: true, authorized: false, reason }));
    expect(new Set(ds.map((d) => d.label)).size).toBe(reasons.length);
    expect(new Set(ds.map((d) => d.remedy)).size).toBe(reasons.length);
    ds.forEach((d, i) => { expect(d.ok).toBe(false); expect(d.reason).toBe(reasons[i]); });
    expect(PEER_REASONS.unauthorized.remedy).toMatch(/pair it again/);
    expect(PEER_REASONS.access_required.remedy).toMatch(/Access service token/);
  });
  it("is ok only for reachable + authorized + no reason", () => {
    expect(describePeerStatus({ reachable: true, authorized: true, reason: null }).ok).toBe(true);
    expect(describePeerStatus(null).ok).toBe(false);
    expect(describePeerStatus({ reachable: true, authorized: null, reason: "weird" }).label).toBe(PEER_REASONS.unexpected.label);
  });
});

describe("sessionSocketPath", () => {
  it("local, peer and not-yet-attached", () => {
    expect(sessionSocketPath({ terminalId: "t1" })).toBe("/ws/terminal/t1");
    expect(sessionSocketPath({ machine: "p/1", remoteId: "s 1" })).toBe("/ws/peer/p%2F1/s%201");
    expect(sessionSocketPath({ machine: "p", remoteId: null })).toBeNull();
    expect(sessionSocketPath({ terminalId: null })).toBeNull();
  });
});

describe("drag data", () => {
  it("round-trips and ignores other drags", () => {
    expect(parsePeerDragData(peerDragData("a/b", "c d"))).toEqual({ peerId: "a/b", remoteId: "c d" });
    expect(parsePeerDragData("session:3")).toBeNull();
    expect(parsePeerDragData("peer:")).toBeNull();
  });
});

describe("accessPairError", () => {
  it("both or neither", () => {
    expect(accessPairError("", "")).toBe("");
    expect(accessPairError("id", "secret")).toBe("");
    expect(accessPairError("id", " ")).not.toBe("");
    expect(accessPairError("", "secret")).not.toBe("");
  });
});

describe("peerCreateBody", () => {
  it("maps to the peer route's field names and omits unset optionals", () => {
    expect(peerCreateBody({ name: "n", workdir: "C:\\x", harness: "codex", model: "m", permissionMode: "plan", effort: "", bypassPermissions: true }))
      .toEqual({ name: "n", workdir: "C:\\x", harness: "codex", model: "m", permission_mode: "plan", bypass: true });
  });
});

describe("reconcilePeerSessions", () => {
  const local = { id: 1, terminalId: "t" };
  it("drops a gone remote, follows name/state, leaves other machines alone", () => {
    const prev = [local, { id: 2, machine: "p", remoteId: "a", name: "old" }, { id: 3, machine: "p", remoteId: "gone" }, { id: 4, machine: "q", remoteId: "z" }];
    const next = reconcilePeerSessions(prev, "p", [{ id: "a", name: "new", activity_state: "busy" }]);
    expect(next.map((s) => s.id)).toEqual([1, 2, 4]);
    expect(next[1]).toMatchObject({ name: "new", activityState: "busy" });
  });
  it("keeps a just-created session the list does not name yet", () => {
    const now = 1_000_000;
    const prev = [{ id: 2, machine: "p", remoteId: "new", adoptedAt: now - 10 }];
    expect(reconcilePeerSessions(prev, "p", [], now)).toBe(prev);
    expect(reconcilePeerSessions(prev, "p", [], now + PEER_ADOPT_GRACE_MS)).toEqual([]);
  });
  it("same array when nothing changed", () => {
    const prev = [{ id: 2, machine: "p", remoteId: "a", name: "n", activityState: "idle" }];
    expect(reconcilePeerSessions(prev, "p", [{ id: "a", name: "n", activity_state: "idle" }])).toBe(prev);
  });
  it("drops records of an unpaired machine only", () => {
    const prev = [local, { id: 2, machine: "p" }, { id: 3, machine: "q" }];
    expect(dropUnpairedPeerSessions(prev, ["p"]).map((s) => s.id)).toEqual([1, 2]);
    expect(dropUnpairedPeerSessions(prev, ["p", "q"])).toBe(prev);
  });
});

describe("peerChoiceOptions", () => {
  const catalog = {
    harnesses: [{ id: "claude-code", label: "Claude Code", models: [{ id: "m1", label: "M1" }], default_model: "m1" }],
    permission_modes: [{ id: "default" }, { id: "plan" }],
    efforts: ["low", "high"],
  };
  const vocab = {
    harnesses: [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }],
    permissionModes: [{ id: "default" }, { id: "plan" }, { id: "bypassPermissions" }],
    efforts: [{ id: "" }, { id: "low" }, { id: "high" }, { id: "max" }],
    machineLabel: "Desk",
  };
  it("marks what the peer does not offer as not selectable, with a reason", () => {
    const o = peerChoiceOptions(catalog, "claude-code", vocab);
    expect(o.harnessOptions.find((h) => h.id === "codex")).toMatchObject({ disabled: true, reason: expect.stringMatching(/Desk/) });
    expect(o.permissionOptions.find((p) => p.id === "bypassPermissions").disabled).toBe(true);
    expect(o.effortOptions.find((e) => e.id === "").disabled).toBeUndefined();
    expect(o.effortOptions.find((e) => e.id === "max").disabled).toBe(true);
    expect(o.modelOptions).toEqual([{ id: "m1", label: "M1" }]);
    expect(o.defaultModel).toBe("m1");
    expect(o.harnessOffered).toBe(true);
    expect(peerChoiceOptions(catalog, "codex", vocab).harnessOffered).toBe(false);
  });
});

describe("peersApi", () => {
  it("surfaces the peer reason on a 502 and never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ reason: "unreachable" }) });
    const r = await peersApi.sessions("p", { fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 502, reason: "unreachable" });
    const thrown = await peersApi.list({ fetchImpl: vi.fn().mockRejectedValue(new Error("x")) });
    expect(thrown.ok).toBe(false);
  });
  it("quotes ids into one path segment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await peersApi.endSession("a/b", "c d", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("/api/peers/a%2Fb/sessions/c%20d", expect.objectContaining({ method: "DELETE" }));
  });
});

describe("peersApi round 2", () => {
  const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  it("rename PUTs the label; subagent routes quote every segment", async () => {
    const f = ok();
    await peersApi.rename("a/b", "Office", { fetchImpl: f });
    expect(f).toHaveBeenCalledWith("/api/peers/a%2Fb", expect.objectContaining({ method: "PUT", body: JSON.stringify({ label: "Office" }) }));
    await peersApi.subagents("p1", { fetchImpl: f });
    expect(f).toHaveBeenCalledWith("/api/peers/p1/subagents", expect.anything());
    await peersApi.subagentReport("p1", "s 1", "a/1", { fetchImpl: f });
    expect(f).toHaveBeenCalledWith("/api/peers/p1/sessions/s%201/subagents/a%2F1", expect.anything());
  });
});

describe("followPeerLabels", () => {
  const rec = (id, machine, machineLabel) => ({ id, machine, machineLabel });
  it("moves a record's machineLabel onto the current peer label", () => {
    const prev = [rec(1, "p1", "Old"), rec(2, null, undefined), rec(3, "gone", "Keep")];
    const next = followPeerLabels(prev, [{ id: "p1", label: "New" }]);
    expect(next[0].machineLabel).toBe("New");
    expect(next[1]).toBe(prev[1]);
    expect(next[2]).toBe(prev[2]);
  });
  it("returns the same array when nothing changed", () => {
    const prev = [rec(1, "p1", "Same")];
    expect(followPeerLabels(prev, [{ id: "p1", label: "Same" }])).toBe(prev);
  });
});
