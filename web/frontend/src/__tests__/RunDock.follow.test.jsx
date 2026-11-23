import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import fs from "node:fs";
import RunDock from "../components/RunDock";
import { embedSessionUrl } from "../utils/orchRuns";

// Owner QA, 2.1.62: the run view could be closed but there was no way to bring it
// back, and no way to open it at all unless a run happened to be open. The top
// bar toggle opens the dock in "follow the focused session" mode.

const BASE = "http://127.0.0.1:8430";
afterEach(cleanup);

describe("run dock following a session", () => {
  it("builds the follow URL from the terminal id", () => {
    expect(embedSessionUrl(`${BASE}/`, "02a5 e5ba")).toBe(`${BASE}/embed?session=02a5%20e5ba`);
  });

  it("frames the focused session when no run was picked, and names it", () => {
    render(<RunDock base={BASE} runId={null} run={null} sessionId="02a5e5ba" sessionName="studio" onClose={() => {}} />);
    expect(screen.getByTitle("Orchestration run").getAttribute("src")).toBe(`${BASE}/embed?session=02a5e5ba`);
    expect(screen.getByText("studio")).toBeInTheDocument();
    expect(screen.queryByText(/Run closed/)).toBeNull();
  });

  it("a picked run still wins over the focused session", () => {
    render(<RunDock base={BASE} runId="r1" run={{ run_id: "r1", stage: "workers", task: "t" }}
      sessionId="02a5e5ba" sessionName="studio" onClose={() => {}} />);
    expect(screen.getByTitle("Orchestration run").getAttribute("src")).toBe(`${BASE}/embed?run=r1`);
  });

  it("with nothing focused it says what to do instead of showing an empty frame", () => {
    render(<RunDock base={BASE} runId={null} run={null} sessionId={null} onClose={() => {}} />);
    expect(screen.queryByTitle("Orchestration run")).toBeNull();
    expect(screen.getByText(/Focus a session/)).toBeInTheDocument();
  });

  it("the top bar carries the way back, beside the inspector's", () => {
    const top = fs.readFileSync("src/components/TopBar.jsx", "utf8");
    expect(top.includes('aria-label="Toggle run view"')).toBe(true);
    expect(top.split("{runDockToggle}{inspectorToggle}").length - 1).toBe(2);
  });
});
