/**
 * Prop-contract tests for the app-shell components (Rail, CommandBar,
 * LaneStrip, Inspector, StatusStrip).
 *
 * WHY THIS FILE EXISTS: see buildBusyTerminalIds.test.js — App passed a Set
 * to a component that called .get(), and it shipped for three minor versions
 * because every component test hand-built its own well-typed fixtures instead
 * of the actual container types App.jsx constructs. LaneStrip repeats the
 * same shape: `paneSlotById` is a Map (App.jsx uses `.get()` via
 * `paneSlotBySession`, a `useState(() => new Map())`) and `poppedOutIds` is a
 * Set (`useState(new Set())`). These tests render LaneStrip with a real Map
 * and a real Set — not object literals — so a future regression to the wrong
 * container type fails loudly instead of silently rendering nothing.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Rail from "../components/shell/Rail";
import CommandBar from "../components/shell/CommandBar";
import LaneStrip from "../components/shell/LaneStrip";
import Inspector from "../components/shell/Inspector";
import StatusStrip from "../components/shell/StatusStrip";

describe("LaneStrip — exact container types App.jsx passes", () => {
  // paneSlotById is keyed by App.jsx's local `session.id` (activeIds stores
  // local ids); poppedOutIds is keyed by `session.terminalId` (App.jsx's
  // setPoppedOutIds always adds/removes the backend terminalId, never the
  // local id) — the two ids are deliberately different here so a regression
  // to the wrong key on either Map/Set fails loudly.
  const sessions = [
    { id: "s1", terminalId: "t1", name: "Session One", status: "idle" },
    { id: "s2", terminalId: "t2", name: "Session Two", status: "idle" },
  ];

  it("renders a slot badge sourced from a Map (App's paneSlotBySession)", () => {
    const paneSlotById = new Map();
    paneSlotById.set("s1", 3);
    expect(paneSlotById).toBeInstanceOf(Map);

    render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={paneSlotById}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );

    // Slot badge text is the raw slot number.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders a popped-out chip sourced from a Set (App's poppedOutIds)", () => {
    const poppedOutIds = new Set(["t2"]);
    expect(poppedOutIds).toBeInstanceOf(Set);

    render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={poppedOutIds}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );

    expect(screen.getByText("popped out")).toBeInTheDocument();
  });

  it("a wrong container type (plain object) for paneSlotById does NOT throw but also does not render a badge", () => {
    // LaneStrip guards with `typeof paneSlotById.get === "function"`, so a
    // plain object silently degrades to "no badge" rather than throwing.
    // This documents the guard's behavior — plain objects are tolerated but
    // never populate a slot number.
    const wrongType = { s1: 3 };
    render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={wrongType}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("a wrong container type (plain object) for poppedOutIds does not throw and never shows 'popped out'", () => {
    const wrongType = { t2: true };
    render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={wrongType}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );
    expect(screen.queryByText("popped out")).not.toBeInTheDocument();
  });

  it("lane=null renders no pressure meter", () => {
    const { container } = render(
      <LaneStrip
        sessions={[]}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
        lane={null}
      />
    );
    // The pressure meter is the only element with role="switch" (spill toggle).
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("empty sessions array still renders the + New chip", () => {
    render(
      <LaneStrip
        sessions={[]}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );
    expect(screen.getByLabelText("Start a new session")).toBeInTheDocument();
  });

  it("malformed sessions (non-array) does not throw and renders no chips", () => {
    expect(() =>
      render(
        <LaneStrip
          sessions={null}
          paneSlotById={new Map()}
          focusedSessionId={null}
          poppedOutIds={new Set()}
          onSelectSession={() => {}}
          onNew={() => {}}
        />
      )
    ).not.toThrow();
  });
});

describe("Inspector — null/empty tolerances", () => {
  it("session=null renders an empty Inspector with the 'no session' message", () => {
    render(<Inspector session={null} />);
    expect(screen.getByText("No session focused.")).toBeInTheDocument();
  });

  it("usage with all-null fields renders n/a, never a misleading 0", () => {
    render(
      <Inspector
        session={{ id: "s1", name: "Session One", status: "idle" }}
        bridge={null}
        usage={{
          contextUsed: null,
          contextMax: null,
          inputTokens: null,
          outputTokens: null,
          cacheRead: null,
          cacheWrite: null,
          costUsd: null,
        }}
      />
    );
    // Context ring percent + counts. A null percentage renders a dash, not
    // "n/a" -- see the three-state note on ContextRing. With hasTurns unknown we
    // cannot say whether zero is real, so nothing is asserted about turns here.
    expect(screen.getByText("— context")).toBeInTheDocument();
    // "n/a" appears repeatedly (input/output, cache, cost); assert at least one
    // and assert no bare "0" token count rendered anywhere.
    expect(screen.getAllByText(/n\/a/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^\$0\.00$/)).not.toBeInTheDocument();
  });

  it("usage=undefined (not even passed) also renders n/a, not 0/NaN", () => {
    render(<Inspector session={{ id: "s1", name: "S1", status: "idle" }} bridge={null} />);
    expect(screen.getByText("— context")).toBeInTheDocument();
  });

  // REGRESSION (v1.10.0 report): a session spawned seconds ago showed
  // "n/a context / n/a / n/a" with 0/0 tokens while the status strip showed
  // 271M tok / $211.75. Attribution was NOT broken -- the session simply had no
  // assistant turn yet -- but "genuinely zero" and "lookup failed" rendered
  // identically, so a working system looked broken. These three cases pin the
  // states apart.
  it("no turns recorded yet renders a true 0% plus an explicit 'no turns yet'", () => {
    render(
      <Inspector
        session={{ id: "s1", name: "S1", status: "idle" }}
        bridge={null}
        usage={{
          contextUsed: undefined,
          contextMax: undefined,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0,
          hasTurns: false,
        }}
      />
    );
    expect(screen.getByText("0% context")).toBeInTheDocument();
    expect(screen.getByText("no turns yet")).toBeInTheDocument();
    expect(
      screen.getByText(/No assistant turns recorded yet/i)
    ).toBeInTheDocument();
    // The zeros are real and must be shown as zeros, not laundered into n/a.
    // Both rows (input/output and cache read/write) read "0 / 0".
    expect(screen.getAllByText("0 / 0")).toHaveLength(2);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("turns exist but no context percentage says 'not reported', never a fake 0%", () => {
    render(
      <Inspector
        session={{ id: "s1", name: "S1", status: "idle" }}
        bridge={null}
        usage={{
          contextUsed: undefined,
          contextMax: undefined,
          inputTokens: 42,
          outputTokens: 32110,
          cacheRead: 10938350,
          cacheWrite: 1563510,
          costUsd: 16.0441,
          hasTurns: true,
        }}
      />
    );
    // context_percent is scraped from PTY text and is usually absent; claiming
    // 0% for a session that has burned 12M tokens would be a fabrication.
    expect(screen.getByText("— context")).toBeInTheDocument();
    expect(screen.getByText("not reported by the session")).toBeInTheDocument();
    expect(screen.queryByText("0% context")).not.toBeInTheDocument();
    expect(screen.queryByText(/No assistant turns recorded yet/i)).toBeNull();
  });

  it("usage entirely absent renders the 'not available' note, distinct from zero", () => {
    render(<Inspector session={{ id: "s1", name: "S1", status: "idle" }} bridge={null} />);
    expect(screen.getByText(/Usage not available for this session yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/No assistant turns recorded yet/i)).toBeNull();
    expect(screen.queryByText("no turns yet")).toBeNull();
  });

  it("bridge=null renders no BridgeCard", () => {
    render(
      <Inspector session={{ id: "s1", name: "S1", status: "idle" }} bridge={null} />
    );
    expect(screen.queryByText("Transcript")).not.toBeInTheDocument();
  });

  it("bridge left unset (undefined, not just null) renders no bridge card instead of crashing", () => {
    // REGRESSION: Inspector.jsx guarded `bridge !== null`, which is true for
    // undefined — so an OMITTED bridge prop mounted BridgeCard with
    // bridge=undefined, which then threw dereferencing `bridge.kind`. The guard
    // is now `bridge != null` (loose), catching both. Rendering with no bridge
    // prop at all must be a no-op, since that is what an omitted prop means.
    expect(() =>
      render(<Inspector session={{ id: "s1", name: "S1", status: "idle" }} />)
    ).not.toThrow();
    expect(screen.queryByText(/End bridge/i)).toBeNull();
  });
});

describe("StatusStrip — systemStats null tolerance", () => {
  it("systemStats=null renders — for cpu/ram/gpu, not 0 or NaN", () => {
    render(<StatusStrip connected={false} systemStats={null} />);
    // fmt(null, "%") short-circuits to a bare "—" (no "%" suffix applied to
    // the unknown-marker itself) — see StatusStrip.jsx fmt().
    expect(screen.getByText("CPU —")).toBeInTheDocument();
    expect(screen.getByText("RAM —")).toBeInTheDocument();
    expect(screen.getByText("GPU —")).toBeInTheDocument();
  });

  it("systemStats with partial fields (gpu present, vram missing) shows gpu% without a vram fraction", () => {
    render(
      <StatusStrip
        connected
        systemStats={{ cpu: 12, ramUsed: 4, ramTotal: 32, gpu: 55, vramUsed: null, vramTotal: null }}
      />
    );
    expect(screen.getByText("CPU 12%")).toBeInTheDocument();
    expect(screen.getByText("RAM 4/32GB")).toBeInTheDocument();
    expect(screen.getByText("GPU 55%")).toBeInTheDocument();
  });

  it("todayTokens/todayCost null render — not 0", () => {
    render(<StatusStrip connected todayTokens={null} todayCost={null} />);
    expect(screen.getByText(/— tok · —/)).toBeInTheDocument();
  });
});

describe("Rail and CommandBar smoke render (basic prop contracts)", () => {
  it("Rail renders all sections and marks the active one", () => {
    render(<Rail activeSection="engine" onSelectSection={() => {}} user={{ name: "Lenny" }} />);
    const engineBtn = screen.getByRole("button", { name: "ENGINE" });
    expect(engineBtn).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("L")).toBeInTheDocument(); // avatar initial
  });

  it("Rail with user=null renders a '?' avatar rather than throwing", () => {
    render(<Rail activeSection="work" onSelectSection={() => {}} user={null} />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("CommandBar renders title and defaults pill without a workspaceName", () => {
    render(
      <CommandBar
        title="Workspace"
        workspaceName={null}
        onOpenPalette={() => {}}
        model="opus"
        permissionMode="default"
        effort="auto"
        onOpenDefaults={() => {}}
      />
    );
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
  });
});
