/**
 * S26 — REPORTS CONSOLIDATION, AND THE HONESTY THAT HAD TO SURVIVE IT.
 *
 * Engine ▸ Requests -> Reports ▸ Traces. Engine ▸ Logs -> Reports ▸ Logs.
 * Engine keeps Live / Models / API. Nothing was deleted; two panels changed
 * address.
 *
 * THE POINT OF THIS FILE IS THE SECOND HALF. Moving the trace panel MOVES AN
 * EMPTY PANEL. It is empty because the lane broker ships in shadow mode, so no
 * job is ever queued and a trace is written per queued job; and because Plexar,
 * the backend actually serving models here, does not declare the capability at
 * all. Both measured at the wire 2026-08-03:
 *
 *   GET /api/local/lmstudio-local/traces -> {"traces":[],"count":0}
 *   GET /api/local/plexar-vllm/traces    -> 404 capability not available
 *
 * A consolidation that quietly relocated the panel would LOOK like it fixed the
 * recorder, because the reader now finds the real renderer where a "not built"
 * stub used to be. It did not fix anything. So the copy that explained the
 * emptiness travels with the panel, and this test fails if it stops rendering.
 *
 * This file replaces ReportsView.tracesPointer.test.jsx, which held the old
 * "not built" pointer to account. That pointer is gone because the tab is no
 * longer a stub — but the obligation it encoded is not, so it moved here too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import LogsTab from "../components/reports/LogsTab.jsx";
import { ENGINE_TABS } from "../components/engine/ui.jsx";
import { REPORTS_TABS } from "../components/reports/format.js";

function mockFetch(routes) {
  return vi.fn(async (url) => {
    for (const [frag, body] of routes) {
      if (String(url).includes(frag)) {
        return { ok: true, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

const BROKER = { providers: [{ id: "lmstudio-local", label: "LM Studio", capabilities: ["traces"] }] };

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch([]));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("S26 — the tab map after consolidation", () => {
  it("leaves Engine with exactly Live, Models and API", () => {
    expect(ENGINE_TABS.map((t) => t.id)).toEqual(["live", "models", "api"]);
  });

  it("keeps the Logs destination and every tab it already had, and has NO traces tab", () => {
    const ids = REPORTS_TABS.map((t) => t.id);
    // T11: `traces` is gone -- the lane broker was its only producer.
    expect(ids).not.toContain("traces");
    expect(ids).toContain("logs");
    // NO DELETIONS: the four data tabs and Local engine are untouched.
    for (const id of ["overview", "sessions", "models", "tools", "local-engine"]) {
      expect(ids).toContain(id);
    }
  });

  /* The MOVED ids specifically must not survive in Engine — a stale tab beside
     its new Reports home is two doors to one room, which is the two-product
     illusion S22 counted. `models` legitimately appears in both sections and is
     NOT a violation: Engine ▸ Models is which model is loaded right now, Reports
     ▸ Models is spend by model over a range. Same word, different question. */
  it("leaves no stale Engine door open to a room that moved", () => {
    const engine = new Set(ENGINE_TABS.map((t) => t.id));
    expect(engine.has("requests")).toBe(false);
    expect(engine.has("logs")).toBe(false);
  });
});

describe("S26-LOGS — the moved log panel renders REAL lines, and the old copy was false", () => {
  /* The panel used to say "Plexar Studio exposes no log endpoint". GET /api/logs
     has existed all along, tailing the rotating file with secret redaction, and
     Settings ▸ Diagnostics already consumed it. What was missing was a consumer
     here, not a route. */
  it("renders the lines the server actually returned", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        [
          "/api/logs",
          {
            path: "C:/Users/x/.plexar-studio/logs/cockpit.log",
            lines: ["2026-08-03 21:00:00 [INFO] cockpit.server: started", "2026-08-03 21:00:01 [ERROR] cockpit.pty: boom"],
            size_bytes: 4096,
            file_logging: true,
          },
        ],
      ])
    );
    render(<LogsTab />);
    const tail = await screen.findByTestId("logs-tail");
    expect(tail).toHaveTextContent("cockpit.server: started");
    expect(tail).toHaveTextContent("cockpit.pty: boom");
    // ...and it names the file it read, so the reader can go find it.
    expect(await screen.findByTestId("logs-path")).toHaveTextContent(/cockpit\.log/);
  });

  it("never again claims no log endpoint exists", async () => {
    vi.stubGlobal("fetch", mockFetch([["/api/logs", { path: "x", lines: [], size_bytes: 0, file_logging: true }]]));
    const { container } = render(<LogsTab />);
    await screen.findByTestId("logs-empty");
    expect(container.textContent).not.toMatch(/no log endpoint/i);
    expect(container.textContent).not.toMatch(/no log stream yet/i);
  });

  it("distinguishes an UNREADABLE log from an EMPTY one", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<LogsTab />);
    await waitFor(() => expect(screen.getByTestId("logs-unreadable")).toBeInTheDocument());
    expect(screen.queryByTestId("logs-empty")).not.toBeInTheDocument();
  });

  it("still refuses to render sample lines, and says the tail is not everything", async () => {
    vi.stubGlobal("fetch", mockFetch([["/api/logs", { path: "x", lines: ["a"], size_bytes: 1, file_logging: true }]]));
    render(<LogsTab />);
    await screen.findByTestId("logs-tail");
    expect(screen.getByTestId("engine-logs-note")).toHaveTextContent(/fabricated log/i);
    // vLLM logs in its container and never reaches this file -- saying so keeps
    // the tail from implying it is the whole picture.
    expect(screen.getByTestId("engine-logs-card")).toHaveTextContent(/docker logs/);
  });

  it("says so when file logging is off rather than showing a silently empty tail", async () => {
    vi.stubGlobal("fetch", mockFetch([["/api/logs", { path: "x", lines: [], size_bytes: 0, file_logging: false }]]));
    render(<LogsTab />);
    await waitFor(() => expect(screen.getByTestId("logs-nofile")).toBeInTheDocument());
  });
});
