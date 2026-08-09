/**
 * The Inspector's collapse used to be a ONE-WAY DOOR: `Inspector` had an
 * `onCollapse` that set `inspectorOpen` false, and nothing anywhere set it back
 * true. The only recovery was reloading the app — and once the value is
 * persisted (it now is), a reload would not have recovered it either. That is
 * the bug this file exists to keep closed.
 *
 * The assertion that matters is the ROUND TRIP: hide, then show again from the
 * same control. A test that only checks the button renders would still pass if
 * the handler were wired to a setter that never re-opened it.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
// TopBar calls useTheme(), which needs a provider — same wrapper TopBar.test.jsx uses.
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";

// The model picker fetches a live catalog; the toggle under test does not care.
beforeEach(() => {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  );
});

/** Minimal host that owns `inspectorOpen` exactly the way App.jsx does. */
function Host() {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  return (
    <ThemeProvider>
      <TopBar
        model="claude-opus-5"
        setModel={() => {}}
        permissionMode="default"
        setPermissionMode={() => {}}
        effort="medium"
        setEffort={() => {}}
        fast={false}
        setFast={() => {}}
        sidebarOpen
        setSidebarOpen={() => {}}
        inspectorOpen={inspectorOpen}
        setInspectorOpen={setInspectorOpen}
        user={null}
        onToast={() => {}}
      />
      {inspectorOpen && <div data-testid="inspector">inspector</div>}
    </ThemeProvider>
  );
}

describe("Inspector toggle in the TopBar", () => {
  it("hides AND re-shows the inspector — the collapse is not one-way", () => {
    render(<Host />);

    const toggle = screen.getByLabelText("Toggle inspector");
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    // The half that was missing before this fix.
    fireEvent.click(toggle);
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("renders no toggle when the host does not wire one up", () => {
    render(
      <ThemeProvider>
        <TopBar
        model="claude-opus-5"
        setModel={() => {}}
        permissionMode="default"
        setPermissionMode={() => {}}
        effort="medium"
        setEffort={() => {}}
        fast={false}
        setFast={() => {}}
        sidebarOpen
        setSidebarOpen={() => {}}
        user={null}
          onToast={() => {}}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByLabelText("Toggle inspector")).not.toBeInTheDocument();
  });
});
