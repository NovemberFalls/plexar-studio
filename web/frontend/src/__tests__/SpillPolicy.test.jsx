/**
 * SpillPolicy + DepthWaitPanel — screens 4a/4b.
 *
 * The contract under test is honesty, not layout. A spill threshold is a number
 * that decides whether a request runs on hardware you own or on a metered API,
 * so every way this screen could lie is pinned here:
 *
 *   - the depth ↔ wait conversions round-trip, and BOTH return null (rendered
 *     "≈?") when there is no measured p50 — never "≈0 deep" and never "≈∞"
 *   - the derived field is read-only; switching the trigger unit swaps which
 *     one is editable
 *   - the translation table's verdict matches the broker's STRICTLY-GREATER
 *     rule: at the trigger exactly, local; past it, spills
 *   - a null threshold renders as spill-off / never-spills, not as 0 seconds
 *   - the session-only reset warning is present
 *   - a remote-scope provider cannot be edited (PUT is 403 server-side)
 *   - the Advanced fields are disabled with the missing endpoint named
 *   - the prose sentence tracks the numbers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import SpillPolicy from "../components/settings/SpillPolicy";
import DepthWaitPanel from "../components/settings/DepthWaitPanel";
import { depthEquivalent, waitEquivalent, wouldSpill } from "../utils/laneMath";

const LOCAL_PROVIDER = {
  id: "lmstudio-local",
  label: "LM Studio (local)",
  kind: "lmstudio",
  scope: "local",
  capabilities: ["models", "health", "queue", "metrics", "spill", "traces"],
};

const REMOTE_PROVIDER = { ...LOCAL_PROVIDER, id: "remote-broker", label: "Studio B", scope: "remote" };

const SPILL = {
  spill_thresholds_s: { interactive: 30, worker: 300, batch: null },
  spilled_total: 4,
  spilled_by_class: { interactive: 4 },
  persisted: false,
};

// p50 = 10s exactly, so 30s ⇄ 3 deep is a clean round-trip in the assertions.
const METRICS = { reachable: true, run_time_ms: { p50: 10000 }, runs_total: 12 };

const QUEUE = {
  shadow: false,
  in_flight: { class: "interactive", elapsed_s: 3, predicted_remaining_s: 7 },
  queued: [{ class: "interactive", position: 0, predicted_wall_s: 10 }],
  estimated_clear_seconds: 17,
  predicted_wait_s_by_class: { interactive: 21, worker: 21, batch: 21 },
};

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body });

function installFetch(overrides = {}) {
  const impl = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/spill") && init?.method === "PUT") {
      return overrides.put ? overrides.put(JSON.parse(init.body)) : jsonOk(SPILL);
    }
    if (u.endsWith("/spill")) return jsonOk("spill" in overrides ? overrides.spill : SPILL);
    if (u.endsWith("/queue")) return jsonOk("queue" in overrides ? overrides.queue : QUEUE);
    if (u.includes("/metrics")) return jsonOk("metrics" in overrides ? overrides.metrics : METRICS);
    if (u.includes("/spills")) return jsonOk({ spills: [], count: 9 });
    return { ok: false, status: 404, json: async () => ({}) };
  });
  globalThis.fetch = impl;
  return impl;
}

/** Render and wait for the mount reads to settle. */
async function mount(props = {}) {
  const view = render(<SpillPolicy provider={LOCAL_PROVIDER} loading={false} {...props} />);
  await waitFor(() => expect(screen.getByTestId("spill-context")).toHaveTextContent(/p50 wall/i));
  return view;
}

describe("laneMath depth ↔ wait conversions", () => {
  it("round-trips a threshold through both directions at a known p50", () => {
    expect(depthEquivalent(30, 10)).toBe(3);
    expect(waitEquivalent(3, 10)).toBe(30);
    expect(depthEquivalent(waitEquivalent(4, 12.5), 12.5)).toBe(4);
  });

  it("returns null — not 0, NaN or Infinity — for a p50 of 0, null or undefined", () => {
    for (const p50 of [0, null, undefined]) {
      expect(depthEquivalent(30, p50)).toBeNull();
      expect(waitEquivalent(3, p50)).toBeNull();
    }
    // Explicitly not the fabricated values this screen must never show.
    expect(depthEquivalent(30, 0)).not.toBe(0);
    expect(Number.isFinite(depthEquivalent(30, 0))).toBe(false);
  });

  it("wouldSpill encodes the broker's strictly-greater rule", () => {
    expect(wouldSpill(30, 30)).toBe(false); // equal to the trigger runs LOCAL
    expect(wouldSpill(30.1, 30)).toBe(true);
    expect(wouldSpill(50, null)).toBe(false); // spill disabled: never spills
    expect(wouldSpill(null, 30)).toBeNull(); // unmeasured wait: unknowable
  });
});

describe("SpillPolicy — derived fields and unit switching", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("shows the broker's seconds as editable and the depth as derived", async () => {
    await mount();
    const secs = screen.getByTestId("field-interactive-seconds");
    const depth = screen.getByTestId("field-interactive-depth");

    expect(secs).toHaveAttribute("data-derived", "false");
    expect(secs).toHaveValue(30);
    // 30s at a 10s median = 3 requests deep, shown derived with the ≈ prefix.
    expect(depth).toHaveAttribute("data-derived", "true");
    expect(depth).toHaveTextContent("≈3");
  });

  it("switching to Queue depth makes the seconds field the derived, read-only one", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("unit-interactive-depth"));

    const secs = screen.getByTestId("field-interactive-seconds");
    const depth = screen.getByTestId("field-interactive-depth");
    expect(depth).toHaveAttribute("data-derived", "false");
    expect(depth.tagName).toBe("INPUT");
    expect(secs).toHaveAttribute("data-derived", "true");
    // A derived field is a static node, so there is no input to type into.
    expect(secs.tagName).not.toBe("INPUT");
    expect(secs).toHaveTextContent("≈30s");
  });

  it("a depth typed in depth mode is converted to the seconds the broker stores", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("unit-interactive-depth"));
    fireEvent.change(screen.getByTestId("field-interactive-depth"), { target: { value: "5" } });
    // 5 deep at a 10s median = 50s, and the seconds readout proves what will be sent.
    expect(screen.getByTestId("field-interactive-seconds")).toHaveTextContent("≈50s");
  });

  it("renders ≈? with an explanatory title when there is no measured p50", async () => {
    installFetch({ metrics: { reachable: true, run_time_ms: {} } });
    render(<SpillPolicy provider={LOCAL_PROVIDER} loading={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("spill-context")).toHaveTextContent(/not measured yet/i)
    );

    const depth = screen.getByTestId("field-interactive-depth");
    expect(depth).toHaveTextContent("≈?");
    expect(depth.getAttribute("title")).toMatch(/no measured median wall time/i);
    // And the unit that cannot be converted is refused rather than mis-written.
    expect(screen.getByTestId("unit-interactive-depth")).toBeDisabled();
  });
});

describe("SpillPolicy — the Either mode is refused, not faked", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("disables Either and names the reason (the broker stores one wait number)", async () => {
    await mount();
    const either = screen.getByTestId("unit-interactive-either");
    expect(either).toBeDisabled();
    expect(either.getAttribute("title")).toMatch(/single wait threshold/i);
  });
});

describe("SpillPolicy — disabled classes and the session-only warning", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("renders a null threshold as spill-off / never-spills, not as zero seconds", async () => {
    await mount();
    // batch is null in the broker payload.
    expect(screen.getByTestId("enable-batch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("field-batch-seconds")).toBeDisabled();
    expect(screen.getByTestId("field-batch-seconds")).toHaveValue(null);
    expect(screen.getByTestId("sentence-batch")).toHaveTextContent(
      /Spill is off for batch .* always wait for the local lane/i
    );
    expect(screen.getByTestId("sentence-batch")).not.toHaveTextContent("0s");
  });

  it("states that thresholds are session-only and reset when the broker restarts", async () => {
    await mount();
    const note = screen.getByTestId("spill-session-only");
    expect(note).toHaveTextContent(/session-only on the broker/i);
    expect(note).toHaveTextContent(/discarded when the broker restarts/i);
    expect(note).toHaveAttribute("role", "note");
  });

  it("labels spill counters by when they were counted, not as 'today'", async () => {
    await mount();
    const billing = screen.getByTestId("spill-billing");
    expect(billing).toHaveTextContent(/4 since the broker started/i);
    expect(billing).toHaveTextContent(/9 recorded in total/i);
    expect(billing).not.toHaveTextContent(/today/i);
    // No fabricated dollar figure.
    expect(billing).not.toHaveTextContent(/\$/);
  });
});

describe("SpillPolicy — remote providers cannot be edited", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("disables every control and explains the 403 up front", async () => {
    render(<SpillPolicy provider={REMOTE_PROVIDER} loading={false} />);
    await waitFor(() => expect(screen.getByTestId("spill-remote")).toBeInTheDocument());

    expect(screen.getByTestId("spill-remote")).toHaveTextContent(/403/);
    expect(screen.getByTestId("spill-master")).toBeDisabled();
    expect(screen.getByTestId("enable-interactive")).toBeDisabled();
    expect(screen.getByTestId("field-interactive-seconds")).toBeDisabled();
    expect(screen.getByTestId("spill-apply")).toBeDisabled();
  });

  it("says plainly when no backend offers spill at all", async () => {
    render(<SpillPolicy provider={null} loading={false} />);
    expect(screen.getByTestId("spill-no-capability")).toHaveTextContent(/no registered backend/i);
  });
});

describe("SpillPolicy — Advanced fields are inert with the gap named", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("disables cooldown, headroom, estimator window and spill target", async () => {
    await mount();
    for (const [name, pattern] of [
      ["cooldown", /no cooldown setting/i],
      ["headroom", /no headroom setting/i],
      ["estimator", /not configurable/i],
      ["target", /does not forward spilled requests/i],
    ]) {
      const field = screen.getByTestId(`adv-${name}`);
      expect(field).toBeDisabled();
      expect(field.getAttribute("title")).toMatch(pattern);
    }
  });

  it("shows shadow mode as a start-time-only live reading, not a switch", async () => {
    await mount();
    const shadow = screen.getByTestId("adv-shadow");
    expect(shadow).toHaveTextContent(/enforcing/i);
    expect(shadow).toHaveTextContent(/start-time only/i);
    expect(shadow.querySelector('[role="switch"]')).toBeNull();
  });

  it("shows spills.jsonl logging as an unconditional fact", async () => {
    await mount();
    expect(screen.getByTestId("adv-spilllog")).toHaveTextContent(/always on/i);
    expect(screen.getByTestId("adv-spilllog")).toHaveTextContent(/unconditionally/i);
  });
});

describe("SpillPolicy — applying a change", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("PUTs only the changed classes, in seconds, and adopts the broker's echo", async () => {
    const echo = {
      ...SPILL,
      spill_thresholds_s: { interactive: 45, worker: 300, batch: null },
    };
    const put = vi.fn(() => jsonOk(echo));
    const fetchMock = installFetch({ put });
    await mount();

    fireEvent.change(screen.getByTestId("field-interactive-seconds"), { target: { value: "45" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("spill-apply"));
    });

    expect(put).toHaveBeenCalledWith({ interactive: 45 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local/lmstudio-local/spill",
      expect.objectContaining({ method: "PUT" })
    );
    await waitFor(() =>
      expect(screen.getByTestId("field-interactive-seconds")).toHaveValue(45)
    );
    expect(screen.getByTestId("spill-apply")).toBeDisabled(); // nothing pending
  });

  it("surfaces a refused write inline instead of silently keeping the draft", async () => {
    installFetch({
      put: () => ({ ok: false, status: 400, json: async () => ({ error: "'interactive' seconds must be in 0..86400" }) }),
    });
    await mount();
    fireEvent.change(screen.getByTestId("field-interactive-seconds"), { target: { value: "45" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("spill-apply"));
    });
    expect(screen.getByTestId("spill-error")).toHaveTextContent(/must be in 0\.\.86400/);
  });

  it("Revert drops the draft and restores the broker's value", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("field-interactive-seconds"), { target: { value: "90" } });
    expect(screen.getByTestId("field-interactive-seconds")).toHaveValue(90);
    fireEvent.click(screen.getByTestId("spill-revert"));
    expect(screen.getByTestId("field-interactive-seconds")).toHaveValue(30);
  });

  it("installs no polling interval — Settings is intent, not a dashboard", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    // Awaited inside act so the mount reads settle here rather than leaking a
    // state update into the next test; waitFor is deliberately NOT used because
    // waitFor itself installs an interval and would poison the assertion.
    await act(async () => {
      render(<SpillPolicy provider={LOCAL_PROVIDER} loading={false} />);
    });
    expect(intervalSpy).not.toHaveBeenCalled();
  });
});

describe("SpillPolicy — the live sentence tracks the numbers", () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("updates the plain-English sentence when the trigger changes", async () => {
    await mount();
    // 30s trigger at a 10s median = 3 deep; live wait is 21s → 9s of headroom.
    expect(screen.getByTestId("sentence-interactive")).toHaveTextContent(
      /3 requests are already ahead of you\. 9s of headroom left\./i
    );

    fireEvent.change(screen.getByTestId("field-interactive-seconds"), { target: { value: "60" } });
    expect(screen.getByTestId("sentence-interactive")).toHaveTextContent(
      /6 requests are already ahead of you\. 39s of headroom left\./i
    );
  });

  it("reads the live wait and queue depth from the broker snapshot", async () => {
    await mount();
    expect(screen.getByTestId("now-interactive")).toHaveTextContent("now · 21s wait · 1 queued");
  });
});

describe("DepthWaitPanel — the translation table", () => {
  it("marks rows at or under the trigger local and rows past it spills", () => {
    // p50 10s, trigger 30s → 0/1/2 ahead = 0/10/20s (local), 4 = 40s and 7 = 70s (spill).
    render(<DepthWaitPanel laneClass="interactive" p50WallSeconds={10} thresholdSeconds={30} />);
    expect(screen.getByTestId("xlate-row-0")).toHaveAttribute("data-verdict", "local");
    expect(screen.getByTestId("xlate-row-1")).toHaveAttribute("data-verdict", "local");
    expect(screen.getByTestId("xlate-row-2")).toHaveAttribute("data-verdict", "local");
    expect(screen.getByTestId("xlate-row-4")).toHaveAttribute("data-verdict", "spills");
    expect(screen.getByTestId("xlate-row-7")).toHaveAttribute("data-verdict", "spills");
  });

  it("treats a wait exactly equal to the trigger as local, matching the broker", () => {
    // trigger 20s, p50 10s → the 2-ahead row is exactly 20s.
    render(<DepthWaitPanel laneClass="worker" p50WallSeconds={10} thresholdSeconds={20} />);
    expect(screen.getByTestId("xlate-wait-2")).toHaveTextContent("20s");
    expect(screen.getByTestId("xlate-row-2")).toHaveAttribute("data-verdict", "local");
    expect(screen.getByTestId("xlate-row-4")).toHaveAttribute("data-verdict", "spills");
  });

  it("says every row is unknown — never 0s — when p50 is unmeasured", () => {
    render(<DepthWaitPanel laneClass="interactive" p50WallSeconds={null} thresholdSeconds={30} />);
    for (const ahead of [0, 1, 2, 4, 7]) {
      expect(screen.getByTestId(`xlate-row-${ahead}`)).toHaveAttribute("data-verdict", "unknown");
      expect(screen.getByTestId(`xlate-wait-${ahead}`)).toHaveTextContent("?");
    }
    expect(screen.getByTestId("xlate-prose")).toHaveTextContent(/no measured median wall time/i);
  });

  it("says nothing ever spills when the class has no threshold", () => {
    render(<DepthWaitPanel laneClass="batch" p50WallSeconds={10} thresholdSeconds={null} />);
    for (const ahead of [0, 1, 2, 4, 7]) {
      expect(screen.getByTestId(`xlate-row-${ahead}`)).toHaveAttribute("data-verdict", "local");
    }
    expect(screen.getByTestId("xlate-prose")).toHaveTextContent(/Spill is off for batch/i);
  });

  it("restates the threshold in prose and points at the Workspace lane meter", () => {
    render(<DepthWaitPanel laneClass="interactive" p50WallSeconds={10} thresholdSeconds={30} />);
    expect(screen.getByTestId("xlate-prose")).toHaveTextContent(
      /up to 3 requests ahead of them \(30s of predicted wait\)\. The 4th spills/i
    );
    expect(screen.getByText(/identical calculation/i)).toBeInTheDocument();
  });

  it("uses a color-mix of the error token for spilling rows, not a raw rgba", () => {
    render(<DepthWaitPanel laneClass="interactive" p50WallSeconds={10} thresholdSeconds={30} />);
    const style = screen.getByTestId("xlate-row-7").getAttribute("style");
    expect(style).toMatch(/color-mix\(in srgb, var\(--cc-error\) 7%, transparent\)/);
    expect(style).not.toMatch(/rgba\(/);
  });
});
