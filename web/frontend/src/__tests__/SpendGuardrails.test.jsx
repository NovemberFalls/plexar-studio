/**
 * SpendGuardrails — Settings ▸ Reporting & retention.
 *
 * The load-bearing assertion in this file is the INTERLOCK: the API-equivalent
 * hard-stop switch must be DISABLED while spend.mode is "subscription" (a block
 * there would refuse work that costs nothing at the margin) and ENABLED under
 * "api". The real-money switch must be enabled in BOTH modes, because OpenRouter
 * and direct API keys are billed today regardless of the Claude plan.
 *
 * The page is driven through a harness that owns the draft, so every assertion
 * about `setField` is about the real dotted path the backend contract pins.
 */
import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import SpendGuardrails, {
  SPEND,
  asNumber,
  enforcementScopeSentence,
  isConfiguredNotEnforcing,
  meterRead,
  usedFraction,
  validateCap,
  validatePercent,
  validateResetDay,
} from "../components/settings/SpendGuardrails.jsx";

function jsonRes(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

/** Minimal stand-in for useSettings: a draft + a spy on every write. */
function Harness({ initial = {}, spy }) {
  const [draft, setDraft] = useState(initial);
  const get = (path, fallback) => (path in draft ? draft[path] : fallback);
  const setField = (path, value) => {
    spy(path, value);
    setDraft((prev) => ({ ...prev, [path]: value }));
  };
  return <SpendGuardrails get={get} setField={setField} isDirty={() => false} />;
}

const STATUS = {
  period: { start: "2026-07-01", end: "2026-07-31", label: "1–31 July 2026" },
  mode: "subscription",
  real: { spent: 4.5, cap: 20, percent: 22.5, state: "ok" },
  equivalent: { spent: 812.4, cap: 100, percent: 812, state: "over" },
  blocking: false,
  reasons: [],
};

beforeEach(() => {
  globalThis.fetch = vi.fn((url) => {
    if (url === "/api/spend/status") return jsonRes(STATUS);
    return jsonRes({}, false, 404);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpendGuardrails — pure validators", () => {
  it("rejects nonsense caps and accepts real amounts", () => {
    expect(validateCap("25.5")).toEqual({ ok: true, value: 25.5 });
    expect(validateCap("-1").ok).toBe(false);
    expect(validateCap("0").ok).toBe(false);
    expect(validateCap("").ok).toBe(false);
    expect(validateCap("abc").ok).toBe(false);
    expect(validateCap("9999999").ok).toBe(false);
  });

  it("bounds the alert percent to 1..100 whole numbers", () => {
    expect(validatePercent("80")).toEqual({ ok: true, value: 80 });
    expect(validatePercent("0").ok).toBe(false);
    expect(validatePercent("101").ok).toBe(false);
    expect(validatePercent("-5").ok).toBe(false);
    expect(validatePercent("80.5").ok).toBe(false);
    expect(validatePercent("").ok).toBe(false);
  });

  it("bounds the reset day to 1..28 so every month has one", () => {
    expect(validateResetDay("28")).toEqual({ ok: true, value: 28 });
    expect(validateResetDay("1")).toEqual({ ok: true, value: 1 });
    expect(validateResetDay("0").ok).toBe(false);
    expect(validateResetDay("29").ok).toBe(false);
    expect(validateResetDay("31").ok).toBe(false);
  });

  it("asNumber and usedFraction never fabricate a number", () => {
    expect(asNumber("12")).toBe(null);
    expect(asNumber(NaN)).toBe(null);
    expect(asNumber(12)).toBe(12);
    expect(usedFraction(5, 10)).toBe(0.5);
    expect(usedFraction(50, 10)).toBe(1); // clamped
    expect(usedFraction(5, null)).toBe(null);
    expect(usedFraction(null, 10)).toBe(null);
    expect(usedFraction(5, 0)).toBe(null);
  });
});

describe("SpendGuardrails — control to dotted path", () => {
  it("writes the billing mode through setField", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await waitFor(() => expect(screen.getByTestId("spend-mode")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("spend-mode-api"));
    expect(spy).toHaveBeenCalledWith(SPEND.mode, "api");
    expect(SPEND.mode).toBe("spend.mode");
  });

  it("writes the period, and only shows the reset-day field for monthly", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.period]: "daily" }} />);
    await waitFor(() => expect(screen.getByTestId("spend-period")).toBeInTheDocument());

    // daily → no reset-day field at all
    expect(screen.queryByLabelText("Monthly reset day of month")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reset-day-note")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("spend-period-weekly"));
    expect(spy).toHaveBeenCalledWith("spend.period", "weekly");
    expect(screen.queryByLabelText("Monthly reset day of month")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("spend-period-monthly"));
    expect(spy).toHaveBeenCalledWith("spend.period", "monthly");
    const day = screen.getByLabelText("Monthly reset day of month");
    expect(day).toBeInTheDocument();

    fireEvent.change(day, { target: { value: "15" } });
    expect(spy).toHaveBeenCalledWith("spend.monthly_reset_day", 15);
    // Anniversary-vs-calendar-month warning is present with the field.
    expect(screen.getByTestId("reset-day-note")).toHaveTextContent(/signup anniversary/);
    expect(screen.getByTestId("reset-day-note")).toHaveTextContent(/calendar month/);
  });

  it("writes both caps, the alert percent, the block switches and the enforcement boxes", async () => {
    const spy = vi.fn();
    render(
      <Harness
        spy={spy}
        initial={{
          [SPEND.mode]: "api",
          [SPEND.capReal]: 20,
          [SPEND.capEquivalent]: 100,
        }}
      />
    );
    await waitFor(() => expect(screen.getByTestId("cap-row-real")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId(`field-${SPEND.capReal}`), { target: { value: "35" } });
    expect(spy).toHaveBeenCalledWith("spend.caps.real_usd", 35);

    fireEvent.change(screen.getByTestId(`field-${SPEND.capEquivalent}`), { target: { value: "250" } });
    expect(spy).toHaveBeenCalledWith("spend.caps.equivalent_usd", 250);

    fireEvent.change(screen.getByTestId(`field-${SPEND.alertPercent}`), { target: { value: "90" } });
    expect(spy).toHaveBeenCalledWith("spend.alert_at_percent", 90);

    fireEvent.click(screen.getByTestId("block-real"));
    expect(spy).toHaveBeenCalledWith("spend.block.real", true);

    fireEvent.click(screen.getByTestId("block-equivalent"));
    expect(spy).toHaveBeenCalledWith("spend.block.equivalent", true);

    fireEvent.click(screen.getByTestId(`field-${SPEND.enforceBridges}`));
    expect(spy).toHaveBeenCalledWith("spend.enforce_on.bridges", false); // default was on

    fireEvent.click(screen.getByTestId(`field-${SPEND.enforceNewSessions}`));
    expect(spy).toHaveBeenCalledWith("spend.enforce_on.new_sessions", true); // default was off
  });

  it("defaults enforcement to bridges on, new sessions off", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("card-spend-enforce")).toBeInTheDocument());
    expect(screen.getByTestId(`field-${SPEND.enforceBridges}`)).toBeChecked();
    expect(screen.getByTestId(`field-${SPEND.enforceNewSessions}`)).not.toBeChecked();
    // The reason bridges are the default: a turn cap bounds turns, not dollars.
    expect(screen.getByTestId("card-spend-enforce")).toHaveTextContent(/turns, not dollars/);
  });
});

/**
 * THE INTERLOCK. Display is always API-equivalent; ENFORCEMENT keys on real
 * money until the owner flips to API billing.
 */
describe("SpendGuardrails — subscription / equivalent-block interlock", () => {
  it("disables the equivalent hard stop under subscription, with the reason in its title", async () => {
    render(<Harness spy={vi.fn()} initial={{ [SPEND.mode]: "subscription" }} />);
    await waitFor(() => expect(screen.getByTestId("block-equivalent")).toBeInTheDocument());

    const block = screen.getByTestId("block-equivalent");
    expect(block).toBeDisabled();
    expect(block).toHaveAttribute("title", expect.stringMatching(/costs nothing extra/i));
    expect(block.getAttribute("title")).toMatch(/API billing/);
    // And the same fact is visible, not title-only.
    expect(screen.getByTestId("block-footnote-equivalent")).toHaveTextContent(/Alerts only/);
  });

  it("does not write the equivalent block when its disabled switch is clicked", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.mode]: "subscription" }} />);
    await waitFor(() => expect(screen.getByTestId("block-equivalent")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("block-equivalent"));
    expect(spy).not.toHaveBeenCalledWith(SPEND.blockEquivalent, expect.anything());
  });

  it("enables the equivalent hard stop under api billing", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.mode]: "api" }} />);
    await waitFor(() => expect(screen.getByTestId("block-equivalent")).toBeInTheDocument());

    const block = screen.getByTestId("block-equivalent");
    expect(block).toBeEnabled();
    expect(block.getAttribute("title")).toMatch(/API billing/);
    expect(screen.queryByTestId("block-footnote-equivalent")).not.toBeInTheDocument();

    fireEvent.click(block);
    expect(spy).toHaveBeenCalledWith("spend.block.equivalent", true);
  });

  it("keeps the REAL-money hard stop enforceable in BOTH modes", async () => {
    const subSpy = vi.fn();
    const { unmount } = render(<Harness spy={subSpy} initial={{ [SPEND.mode]: "subscription" }} />);
    await waitFor(() => expect(screen.getByTestId("block-real")).toBeInTheDocument());
    expect(screen.getByTestId("block-real")).toBeEnabled();
    fireEvent.click(screen.getByTestId("block-real"));
    expect(subSpy).toHaveBeenCalledWith("spend.block.real", true);
    unmount();

    const apiSpy = vi.fn();
    render(<Harness spy={apiSpy} initial={{ [SPEND.mode]: "api" }} />);
    await waitFor(() => expect(screen.getByTestId("block-real")).toBeInTheDocument());
    expect(screen.getByTestId("block-real")).toBeEnabled();
    fireEvent.click(screen.getByTestId("block-real"));
    expect(apiSpy).toHaveBeenCalledWith("spend.block.real", true);
  });

  it("explains the consequence of the selected mode as a note", async () => {
    const { unmount } = render(<Harness spy={vi.fn()} initial={{ [SPEND.mode]: "subscription" }} />);
    await waitFor(() => expect(screen.getByTestId("mode-consequence")).toBeInTheDocument());
    expect(screen.getByTestId("mode-consequence")).toHaveAttribute("role", "note");
    expect(screen.getByTestId("mode-consequence")).toHaveTextContent(/warn but not block/);
    unmount();

    render(<Harness spy={vi.fn()} initial={{ [SPEND.mode]: "api" }} />);
    await waitFor(() => expect(screen.getByTestId("mode-consequence")).toBeInTheDocument());
    expect(screen.getByTestId("mode-consequence")).toHaveTextContent(/hard stop is available/);
  });
});

describe("SpendGuardrails — no-cap is explicit, and bad numbers are refused", () => {
  it("renders a visible No cap state rather than a blank field", async () => {
    const spy = vi.fn();
    render(
      <Harness spy={spy} initial={{ [SPEND.capReal]: null, [SPEND.capEquivalent]: null }} />
    );
    await waitFor(() => expect(screen.getByTestId("nocap-real")).toBeInTheDocument());

    expect(screen.getByTestId("nocap-real")).toHaveTextContent("No cap");
    expect(screen.getByTestId("nocap-equivalent")).toHaveTextContent("No cap");
    // There is no empty number box masquerading as "unset".
    expect(screen.queryByTestId(`field-${SPEND.capReal}`)).not.toBeInTheDocument();
    // And the switch reflects it.
    expect(screen.getByTestId("cap-enabled-real")).toHaveAttribute("aria-checked", "false");
  });

  it("the no-cap switch writes null, and turning it back on writes a number", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.capReal]: 20 }} />);
    await waitFor(() => expect(screen.getByTestId("cap-enabled-real")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("cap-enabled-real"));
    expect(spy).toHaveBeenCalledWith("spend.caps.real_usd", null);
    expect(screen.getByTestId("nocap-real")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cap-enabled-real"));
    const last = spy.mock.calls[spy.mock.calls.length - 1];
    expect(last[0]).toBe("spend.caps.real_usd");
    expect(typeof last[1]).toBe("number");
    expect(last[1]).toBeGreaterThan(0);
  });

  it("refuses a negative cap inline and writes nothing", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.capReal]: 20 }} />);
    await waitFor(() => expect(screen.getByTestId(`field-${SPEND.capReal}`)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId(`field-${SPEND.capReal}`), { target: { value: "-5" } });
    expect(screen.getByTestId("cap-error-real")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    // A good value clears the message and writes.
    fireEvent.change(screen.getByTestId(`field-${SPEND.capReal}`), { target: { value: "12" } });
    expect(spy).toHaveBeenCalledWith("spend.caps.real_usd", 12);
    expect(screen.queryByTestId("cap-error-real")).not.toBeInTheDocument();
  });

  it("refuses an out-of-range percent and an out-of-range reset day", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.period]: "monthly" }} />);
    await waitFor(() => expect(screen.getByTestId(`field-${SPEND.alertPercent}`)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId(`field-${SPEND.alertPercent}`), { target: { value: "140" } });
    expect(screen.getByTestId("percent-error")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalledWith(SPEND.alertPercent, expect.anything());

    fireEvent.change(screen.getByLabelText("Monthly reset day of month"), { target: { value: "31" } });
    expect(screen.getByTestId("reset-day-error")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalledWith(SPEND.resetDay, expect.anything());
  });

  it("defaults the alert threshold to 80 percent", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId(`field-${SPEND.alertPercent}`)).toBeInTheDocument());
    expect(screen.getByTestId(`field-${SPEND.alertPercent}`)).toHaveValue(80);
  });
});

describe("SpendGuardrails — live status card", () => {
  it("renders spent vs cap per class with the state on each meter", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("status-meter-real")).toBeInTheDocument());

    expect(screen.getByTestId("status-meter-real")).toHaveAttribute("data-state", "ok");
    expect(screen.getByTestId("status-meter-real")).toHaveTextContent("$4.50");
    expect(screen.getByTestId("status-meter-real")).toHaveTextContent("of $20.00");
    expect(screen.getByTestId("status-meter-equivalent")).toHaveAttribute("data-state", "over");
    // The resolved window from the status endpoint is shown.
    expect(screen.getByTestId("period-window")).toHaveTextContent("1–31 July 2026");
  });

  it("lists the server's blocking reasons verbatim", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/spend/status") {
        return jsonRes({
          ...STATUS,
          blocking: true,
          reasons: ["Real spend $21.40 exceeds the $20.00 cap", "Bridges are blocked"],
        });
      }
      return jsonRes({}, false, 404);
    });

    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("status-blocking")).toBeInTheDocument());
    const list = screen.getByTestId("status-reasons");
    expect(list).toHaveTextContent("Real spend $21.40 exceeds the $20.00 cap");
    expect(list).toHaveTextContent("Bridges are blocked");
  });

  it("still renders every control when /api/spend/status is missing", async () => {
    globalThis.fetch = vi.fn(() => jsonRes({ error: "not found" }, false, 404));

    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.capReal]: 20 }} />);
    await waitFor(() => expect(screen.getByTestId("status-unavailable")).toBeInTheDocument());

    // Controls all present and functional without the status endpoint.
    expect(screen.getByTestId("spend-mode")).toBeInTheDocument();
    expect(screen.getByTestId("spend-period")).toBeInTheDocument();
    expect(screen.getByTestId("cap-row-real")).toBeInTheDocument();
    expect(screen.getByTestId("cap-row-equivalent")).toBeInTheDocument();
    expect(screen.getByTestId("period-window")).toHaveTextContent("current window unknown");
    expect(screen.queryByTestId("status-meter-real")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("spend-mode-api"));
    expect(spy).toHaveBeenCalledWith("spend.mode", "api");
  });

  it("fetches the status once — no polling", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("status-meter-real")).toBeInTheDocument());
    const calls = globalThis.fetch.mock.calls.filter((c) => c[0] === "/api/spend/status");
    expect(calls).toHaveLength(1);
  });
});

/**
 * The status endpoint landed returning MORE than the originally pinned shape:
 * `caveats: string[]` and a per-class `enforcement_available: bool`. The backend
 * DOWNGRADES a hard block to an alert when the pricing behind a cap is not
 * trustworthy — so a toggle can be ON and still not protect you. Failing to say
 * so is the worst failure available to a spend cap, because it manufactures a
 * false sense of safety.
 *
 * LIVE_STATUS below is the owner's real payload, verbatim.
 */
const LIVE_STATUS = {
  period: { label: "2026-07-01 → 2026-08-01 (resets day 1)" },
  mode: "subscription",
  blocking: false,
  enforcement_available: true,
  real: { spent: 0.0, cap: null, percent: null, state: "ok", enforcement_available: false },
  equivalent: {
    spent: 11266.48,
    cap: null,
    percent: null,
    state: "ok",
    enforcement_available: false,
  },
  caveats: ["203 local model run(s) in this window are $0 and count toward neither cap."],
};

describe("SpendGuardrails — caveats and enforcement availability", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/spend/status") return jsonRes(LIVE_STATUS);
      return jsonRes({}, false, 404);
    });
  });

  it("renders every caveat VERBATIM as a note", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("status-caveats")).toBeInTheDocument());

    const caveat = screen.getByTestId("status-caveat-0");
    expect(caveat).toHaveAttribute("role", "note");
    // Exact string — no paraphrase, no truncation, no summary.
    expect(caveat).toHaveTextContent(
      "203 local model run(s) in this window are $0 and count toward neither cap."
    );
  });

  it("renders multiple caveats, each as its own note", async () => {
    const two = [
      "No OpenRouter price snapshots recorded, so a real-spend block cannot fire.",
      "203 local model run(s) in this window are $0 and count toward neither cap.",
    ];
    globalThis.fetch = vi.fn((url) =>
      url === "/api/spend/status" ? jsonRes({ ...LIVE_STATUS, caveats: two }) : jsonRes({}, false, 404)
    );

    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("status-caveats")).toBeInTheDocument());
    expect(screen.getByTestId("status-caveat-0")).toHaveTextContent(two[0]);
    expect(screen.getByTestId("status-caveat-1")).toHaveTextContent(two[1]);
  });

  it("an absent caveats key does not break the card", async () => {
    const { caveats, ...noCaveats } = LIVE_STATUS;
    expect(caveats).toBeDefined(); // the fixture really did have one to remove
    globalThis.fetch = vi.fn((url) =>
      url === "/api/spend/status" ? jsonRes(noCaveats) : jsonRes({}, false, 404)
    );

    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("status-meter-real")).toBeInTheDocument());
    expect(screen.queryByTestId("status-caveats")).not.toBeInTheDocument();
    // The rest of the card is intact.
    expect(screen.getByTestId("enforcement-scope")).toBeInTheDocument();
    expect(screen.getByTestId("status-meter-equivalent")).toBeInTheDocument();
  });

  it("marks a block that is ON but cannot fire as not enforcing, WITHOUT disabling it", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={{ [SPEND.mode]: "api", [SPEND.blockReal]: true }} />);
    await waitFor(() => expect(screen.getByTestId("cap-not-enforcing-real")).toBeInTheDocument());

    // Marked at the toggle and on the meter, in --cc-waiting.
    expect(screen.getByTestId("cap-not-enforcing-real")).toHaveTextContent(/not enforcing/i);
    expect(screen.getByTestId("not-enforcing-real")).toHaveTextContent(/hard stop not enforcing/i);
    expect(screen.getByTestId("not-enforcing-note-real")).toHaveAttribute("role", "note");
    // It points at the caveats rather than restating them.
    expect(screen.getByTestId("not-enforcing-note-real")).toHaveTextContent(/notes below/);

    // CRUCIALLY the toggle remains operable — this is status, not permission.
    const toggle = screen.getByTestId("block-real");
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(spy).toHaveBeenCalledWith("spend.block.real", false);
  });

  it("shows no not-enforcing marker when the block is OFF", async () => {
    render(<Harness spy={vi.fn()} initial={{ [SPEND.blockReal]: false }} />);
    await waitFor(() => expect(screen.getByTestId("status-meter-real")).toBeInTheDocument());
    // enforcement_available is false, but nothing is configured — so no alarm.
    expect(screen.queryByTestId("cap-not-enforcing-real")).not.toBeInTheDocument();
    expect(screen.queryByTestId("not-enforcing-real")).not.toBeInTheDocument();
  });

  it("shows no not-enforcing marker when enforcement IS available", async () => {
    globalThis.fetch = vi.fn((url) =>
      url === "/api/spend/status"
        ? jsonRes({
            ...LIVE_STATUS,
            real: { ...LIVE_STATUS.real, enforcement_available: true },
          })
        : jsonRes({}, false, 404)
    );

    render(<Harness spy={vi.fn()} initial={{ [SPEND.blockReal]: true }} />);
    await waitFor(() => expect(screen.getByTestId("status-meter-real")).toBeInTheDocument());
    expect(screen.queryByTestId("cap-not-enforcing-real")).not.toBeInTheDocument();
  });

  it("renders percent: null as an explicit no-cap state and NOT a 0% bar", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("status-meter-real")).toBeInTheDocument());

    const meter = screen.getByTestId("status-meter-real");
    expect(meter).toHaveAttribute("data-meter", "nocap");
    expect(screen.getByTestId("status-nocap-real")).toHaveTextContent(/unbounded/);
    expect(meter).toHaveTextContent("no cap set");
    // The bar is ABSENT, not present-at-zero-width: an empty bar would read as
    // "plenty of headroom", a different claim from "there is no limit".
    expect(screen.queryByTestId("status-bar-real")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-bar-equivalent")).not.toBeInTheDocument();
  });

  it("states what enforcement covers, from spend.enforce_on", async () => {
    const { unmount } = render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("enforcement-scope")).toBeInTheDocument());
    // Defaults: bridges on, new sessions off.
    let scope = screen.getByTestId("enforcement-scope");
    expect(scope).toHaveAttribute("role", "note");
    expect(scope).toHaveTextContent(/autonomous bridges and channels/);
    expect(scope).not.toHaveTextContent(/opening a new session/);
    expect(scope).toHaveTextContent(/never interrupted/);
    unmount();

    render(<Harness spy={vi.fn()} initial={{ [SPEND.enforceNewSessions]: true }} />);
    await waitFor(() => expect(screen.getByTestId("enforcement-scope")).toBeInTheDocument());
    scope = screen.getByTestId("enforcement-scope");
    expect(scope).toHaveTextContent(/autonomous bridges and channels and opening a new session/);
  });

  it("the scope line says caps can only alert when nothing is enforced", async () => {
    render(
      <Harness
        spy={vi.fn()}
        initial={{ [SPEND.enforceBridges]: false, [SPEND.enforceNewSessions]: false }}
      />
    );
    await waitFor(() => expect(screen.getByTestId("enforcement-scope")).toBeInTheDocument());
    expect(screen.getByTestId("enforcement-scope")).toHaveTextContent(/can only alert/);
  });
});

describe("SpendGuardrails — real-money scope depends on the billing mode", () => {
  it("excludes Anthropic from the real cap under subscription, includes it under api", async () => {
    const { unmount } = render(<Harness spy={vi.fn()} initial={{ [SPEND.mode]: "subscription" }} />);
    await waitFor(() => expect(screen.getByTestId("cap-row-real")).toBeInTheDocument());
    expect(screen.getByTestId("cap-row-real")).toHaveTextContent(
      /does NOT include your Anthropic turns on this plan/
    );
    expect(screen.getByTestId("mode-consequence")).toHaveTextContent(
      /OpenRouter and direct API keys only/
    );
    unmount();

    render(<Harness spy={vi.fn()} initial={{ [SPEND.mode]: "api" }} />);
    await waitFor(() => expect(screen.getByTestId("cap-row-real")).toBeInTheDocument());
    expect(screen.getByTestId("cap-row-real")).toHaveTextContent(/your Anthropic spend too/);
    expect(screen.getByTestId("mode-consequence")).toHaveTextContent(
      /counts toward the real-money cap/
    );
  });
});

describe("SpendGuardrails — new pure helpers", () => {
  it("meterRead never turns a null cap into a zero bar", () => {
    expect(meterRead({ spent: 0, cap: null, percent: null })).toEqual({ kind: "nocap", fraction: null });
    expect(meterRead({ spent: 5, cap: 10, percent: null })).toEqual({ kind: "nocap", fraction: null });
    expect(meterRead(undefined)).toEqual({ kind: "nocap", fraction: null });
    // Prefers the server's own percent so the two can never disagree.
    expect(meterRead({ spent: 5, cap: 10, percent: 50 })).toEqual({ kind: "bar", fraction: 0.5 });
    expect(meterRead({ spent: 99, cap: 10, percent: 812 })).toEqual({ kind: "bar", fraction: 1 });
  });

  it("isConfiguredNotEnforcing fires only when a block is on AND unavailable", () => {
    expect(isConfiguredNotEnforcing(true, { enforcement_available: false })).toBe(true);
    expect(isConfiguredNotEnforcing(false, { enforcement_available: false })).toBe(false);
    expect(isConfiguredNotEnforcing(true, { enforcement_available: true })).toBe(false);
    // An older payload with no such field must not be treated as unavailable.
    expect(isConfiguredNotEnforcing(true, {})).toBe(false);
    expect(isConfiguredNotEnforcing(true, undefined)).toBe(false);
  });

  it("enforcementScopeSentence reflects the enforce_on flags", () => {
    expect(enforcementScopeSentence(true, false)).toMatch(/autonomous bridges and channels/);
    expect(enforcementScopeSentence(true, false)).not.toMatch(/opening a new session/);
    expect(enforcementScopeSentence(true, true)).toMatch(/and opening a new session/);
    expect(enforcementScopeSentence(false, true)).toMatch(/^A hard stop can refuse opening a new/);
    expect(enforcementScopeSentence(false, false)).toMatch(/can only alert/);
    // Interactive typing is promised safe in every variant.
    expect(enforcementScopeSentence(true, true)).toMatch(/never interrupted/);
    expect(enforcementScopeSentence(false, false)).toMatch(/never blocked/);
  });
});

describe("SpendGuardrails — honesty", () => {
  it("says the figures are API-equivalent and an estimate under a subscription", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("spend-honesty")).toBeInTheDocument());

    const note = screen.getByTestId("spend-honesty");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/API-equivalent/);
    expect(note).toHaveTextContent(/recorded tokens multiplied/);
    expect(note).toHaveTextContent(/would/);
    expect(note).toHaveTextContent(/not money you were charged/);
  });

  it("uses radiogroup semantics for the segmented controls and switch roles for toggles", async () => {
    render(<Harness spy={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("spend-mode")).toBeInTheDocument());

    expect(screen.getByTestId("spend-mode")).toHaveAttribute("role", "radiogroup");
    expect(screen.getByTestId("spend-mode-api")).toHaveAttribute("role", "radio");
    expect(screen.getByTestId("spend-mode-subscription")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("spend-period")).toHaveAttribute("role", "radiogroup");
    expect(screen.getByTestId("block-real")).toHaveAttribute("role", "switch");
    expect(screen.getByTestId("block-real")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("cap-enabled-real")).toHaveAttribute("role", "switch");
  });
});
