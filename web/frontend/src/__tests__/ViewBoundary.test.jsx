/**
 * S21 — per-view error boundaries.
 *
 * ── WHAT ACTUALLY WENT WRONG, WHICH IS WHAT THIS GATE MUST COVER ──────────
 * The app had exactly one boundary (`ErrorBoundary`, root, `main.jsx`). It is
 * full-screen and its `hasError` never resets. So when ONE panel threw:
 *   - the whole product went down until reload, and
 *   - every page visited afterwards showed the SAME stale error, which is how
 *     the fault came to be reported against Traces — a surface that had never
 *     rendered and was entirely innocent.
 *
 * Asserting "the broken view shows a fallback" would pass on the OLD root
 * boundary too. That is the trap. So each obligation gets an assertion that
 * the old design FAILS:
 *
 *   (a) CONTAINMENT — the siblings must still RENDER. Not "a fallback exists".
 *   (b) RESET       — navigating clears it. This is the one that cost us the
 *                     wrong-surface bug report, and no test would have caught
 *                     it, because the old boundary passed every fallback test.
 *   (c) NAMING      — the fallback says WHICH view. "Something went wrong"
 *                     makes the reader guess, and the guess was wrong.
 *
 * Plus a structural pin (S8/NoNativeDialogs shape): App.jsx must actually WRAP
 * its full-area views. A perfect ViewBoundary that nothing mounts is not a fix,
 * and a unit test of the component alone cannot tell the difference.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

import ViewBoundary from "../components/ViewBoundary";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JSX = path.join(HERE, "..", "App.jsx");

/** Throws on render when told to. A render-phase throw is the only kind a
 *  boundary catches — an async/handler throw is not, and pretending otherwise
 *  would make this suite claim more than it proves. */
function Boom({ explode, label }) {
  if (explode) throw new Error("boom in " + label);
  return <div data-testid={`ok-${label}`}>{label} is fine</div>;
}

let errSpy;
beforeEach(() => {
  // React logs caught boundary errors to console.error; silence, don't hide.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("(a) containment — a broken view must not take its siblings", () => {
  it("renders the fallback for the broken view AND keeps every sibling on screen", () => {
    render(
      <div>
        <ViewBoundary name="Reports" resetKey="reports">
          <Boom explode label="reports" />
        </ViewBoundary>
        <ViewBoundary name="Engine" resetKey="engine">
          <Boom label="engine" />
        </ViewBoundary>
        <div data-testid="shell-rail">rail</div>
      </div>,
    );

    // The broken one refused.
    expect(screen.getByTestId("view-boundary-fallback")).toBeTruthy();
    expect(screen.queryByTestId("ok-reports")).toBeNull();

    // THE ASSERTION THAT THE OLD ROOT BOUNDARY FAILS: the rest is still THERE
    // and still rendering its own content, not merely "not erroring".
    expect(screen.getByTestId("ok-engine").textContent).toBe("engine is fine");
    expect(screen.getByTestId("shell-rail")).toBeTruthy();

    // Exactly ONE fallback. Two would mean the throw escaped and something
    // above caught it — containment failing while looking like it worked.
    expect(screen.getAllByTestId("view-boundary-fallback")).toHaveLength(1);
  });

  it("the fallback is INLINE, never a full-screen overlay", () => {
    // `position: fixed; inset: 0` IS the containment defect — a fallback that
    // covers the shell is a whole-product outage regardless of where the
    // boundary sits in the tree.
    render(
      <ViewBoundary name="Reports" resetKey="reports">
        <Boom explode label="reports" />
      </ViewBoundary>,
    );
    const el = screen.getByTestId("view-boundary-fallback");
    expect(el.style.position).not.toBe("fixed");
    expect(el.style.inset).toBe("");
  });
});

describe("(b) reset — hasError MUST NOT latch across navigation", () => {
  function Nav() {
    const [view, setView] = useState("reports");
    return (
      <div>
        <button onClick={() => setView("engine")}>go engine</button>
        <ViewBoundary name={view} resetKey={view}>
          {/* Only "reports" throws. "engine" is healthy — and under the old
              latching boundary it would STILL have shown reports' error, which
              is precisely the false evidence this test exists to forbid. */}
          <Boom explode={view === "reports"} label={view} />
        </ViewBoundary>
      </div>
    );
  }

  it("a healthy view rendered after a broken one shows ITSELF, not the old error", () => {
    render(<Nav />);
    expect(screen.getByTestId("view-boundary-fallback")).toBeTruthy();

    fireEvent.click(screen.getByText("go engine"));

    // THE REGRESSION THAT PRODUCED S21.
    expect(screen.queryByTestId("view-boundary-fallback")).toBeNull();
    expect(screen.getByTestId("ok-engine").textContent).toBe("engine is fine");
  });

  it("a changed resetKey does NOT swallow an error thrown on that same render", () => {
    // The subtle way to break (b): reset on every gDSFP pass, including the
    // one React runs right after getDerivedStateFromError. That would make the
    // boundary catch nothing at all — a boundary that never trips reads as
    // "no bugs" and is the worst outcome of the three.
    const { rerender } = render(
      <ViewBoundary name="A" resetKey="a">
        <Boom label="a" />
      </ViewBoundary>,
    );
    expect(screen.getByTestId("ok-a")).toBeTruthy();

    rerender(
      <ViewBoundary name="B" resetKey="b">
        <Boom explode label="b" />
      </ViewBoundary>,
    );
    expect(screen.getByTestId("view-boundary-fallback")).toBeTruthy();
  });

  it("Try again clears the error in place, without reloading the window", () => {
    // The root boundary's only exit is window.location.reload(), which costs
    // the user every live terminal. A transient failure must not.
    function Retryable() {
      const [broken, setBroken] = useState(true);
      return (
        <div>
          <button onClick={() => setBroken(false)}>fix it</button>
          <ViewBoundary name="Reports" resetKey="reports">
            <Boom explode={broken} label="reports" />
          </ViewBoundary>
        </div>
      );
    }
    render(<Retryable />);
    expect(screen.getByTestId("view-boundary-fallback")).toBeTruthy();
    fireEvent.click(screen.getByText("fix it"));
    fireEvent.click(screen.getByTestId("view-boundary-retry"));
    expect(screen.getByTestId("ok-reports")).toBeTruthy();
  });
});

describe("(c) naming — the fallback must say WHICH view failed", () => {
  it("renders the view name verbatim in the heading and on the element", () => {
    render(
      <ViewBoundary name="Engine ▸ logs" resetKey="engine:logs">
        <Boom explode label="logs" />
      </ViewBoundary>,
    );
    expect(screen.getByTestId("view-boundary-title").textContent).toContain("Engine ▸ logs");
    expect(screen.getByTestId("view-boundary-fallback").getAttribute("data-view")).toBe(
      "Engine ▸ logs",
    );
  });

  it("surfaces the error message rather than a generic apology", () => {
    render(
      <ViewBoundary name="Reports" resetKey="reports">
        <Boom explode label="reports" />
      </ViewBoundary>,
    );
    expect(screen.getByTestId("view-boundary-error").textContent).toContain("boom in reports");
  });
});

describe("structural — the boundaries are actually MOUNTED", () => {
  const src = fs.readFileSync(APP_JSX, "utf8");

  it("App.jsx imports ViewBoundary", () => {
    expect(src).toMatch(/import ViewBoundary from ".\/components\/ViewBoundary"/);
  });

  it("wraps all FOUR full-area views", () => {
    // A count, not a spot check: adding a fifth destination without a boundary
    // is the way this regresses, and it should cost a red suite.
    const opens = src.match(/<ViewBoundary\b/g) || [];
    expect(opens.length).toBe(4);
    expect((src.match(/<\/ViewBoundary>/g) || []).length).toBe(4);
  });

  it("every boundary passes both a name and a resetKey", () => {
    // A boundary with no resetKey latches — the original bug, re-shipped. A
    // boundary with no name is "Something went wrong" — the original wrong
    // bug report, re-shipped.
    for (const tag of src.match(/<ViewBoundary\b[\s\S]{0,240}?>/g) || []) {
      expect(tag).toMatch(/\bname=/);
      expect(tag).toMatch(/\bresetKey=/);
    }
  });
});
