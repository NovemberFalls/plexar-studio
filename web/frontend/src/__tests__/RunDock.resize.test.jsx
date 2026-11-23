import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import RunDock from "../components/RunDock";
import { clampDockWidth, DOCK_MIN_WIDTH, DOCK_WIDTH_KEY } from "../utils/orchRuns";

// Owner QA, 2.1.62: "I found it, but I cannot resize it."

const BASE = "http://127.0.0.1:8430";
const mount = () => render(
  <div style={{ display: "flex" }}>
    <RunDock base={BASE} runId="r1" run={{ run_id: "r1", stage: "workers", task: "t" }} onClose={() => {}} />
  </div>,
);
// jsdom has no PointerEvent, so the library's pointer helpers drop clientX. A
// MouseEvent with the pointer event's name carries it and reaches React the same way.
const pointer = (el, type, clientX) => fireEvent(el, new MouseEvent(type, { bubbles: true, clientX }));
const box = (el, rect) => { el.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...rect }); };

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("clampDockWidth", () => {
  it("holds a width between the floor and three quarters of the row", () => {
    expect(clampDockWidth(500.4, 2000)).toBe(500);
    expect(clampDockWidth(100, 2000)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(5000, 2000)).toBe(1500);
    expect(clampDockWidth(NaN, 2000)).toBe(DOCK_MIN_WIDTH);
  });

  it("never drops below the floor on a narrow row, and has no ceiling when the row is unknown", () => {
    expect(clampDockWidth(900, 400)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(900, 0)).toBe(900);
  });
});

describe("run dock resize handle", () => {
  it("starts at the default share of the row", () => {
    mount();
    expect(screen.getByTestId("run-dock").style.width).toBe("42%");
  });

  it("dragging the edge sets and remembers a pixel width, and the frame stops taking the pointer meanwhile", () => {
    mount();
    const dock = screen.getByTestId("run-dock");
    const handle = screen.getByTestId("run-dock-resizer");
    box(dock, { right: 2000, width: 840 });
    box(dock.parentElement, { width: 2000 });
    pointer(handle, "pointerdown", 1160);
    expect(screen.getByTitle("Orchestration run").style.pointerEvents).toBe("none");
    pointer(handle, "pointermove", 1400);
    expect(dock.style.width).toBe("600px");
    pointer(handle, "pointermove", 1990);
    expect(dock.style.width).toBe(`${DOCK_MIN_WIDTH}px`);
    pointer(handle, "pointerup", 1990);
    expect(screen.getByTitle("Orchestration run").style.pointerEvents).toBe("auto");
    expect(localStorage.getItem(DOCK_WIDTH_KEY)).toBe(String(DOCK_MIN_WIDTH));
    pointer(handle, "pointermove", 1000);
    expect(dock.style.width).toBe(`${DOCK_MIN_WIDTH}px`); // not dragging any more
  });

  it("opens at the remembered width, and a double-click goes back to the default", () => {
    localStorage.setItem(DOCK_WIDTH_KEY, "720");
    mount();
    const dock = screen.getByTestId("run-dock");
    expect(dock.style.width).toBe("720px");
    fireEvent.doubleClick(screen.getByTestId("run-dock-resizer"));
    expect(dock.style.width).toBe("42%");
    expect(localStorage.getItem(DOCK_WIDTH_KEY)).toBeNull();
  });

  it("ignores a stored width that is not usable, and arrow keys nudge it", () => {
    localStorage.setItem(DOCK_WIDTH_KEY, "banana");
    mount();
    const dock = screen.getByTestId("run-dock");
    expect(dock.style.width).toBe("42%");
    box(dock, { right: 2000, width: 800 });
    box(dock.parentElement, { width: 2000 });
    fireEvent.keyDown(screen.getByTestId("run-dock-resizer"), { key: "ArrowLeft" });
    expect(dock.style.width).toBe("824px");
    box(dock, { right: 2000, width: 824 });
    fireEvent.keyDown(screen.getByTestId("run-dock-resizer"), { key: "ArrowRight" });
    expect(dock.style.width).toBe("800px");
  });
});
