/**
 * "Make featured" row in the pane actions popover.
 *
 * The featured cell of the 3/5/7 layouts used to follow focus, so clicking a
 * pane promoted it. Now it moves only on an explicit gesture: dropping a pane
 * into the featured cell, or this row — the keyboard-reachable path, for users
 * who cannot or would rather not drag.
 *
 * The row is rendered ONLY when App supplies `onMakeFeatured`, which it does
 * only for a 3/5/7 layout where the pane is not already featured. So its
 * absence in a 4-pane layout is the contract, not an oversight.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../modelCatalog", () => ({
  useModelCatalog: () => ({ groups: [] }),
  isOpusModel: () => false,
}));

import PaneActionsMenu from "../components/PaneActionsMenu";

const session = { terminalId: "term-1", name: "Alpha", model: "sonnet" };

function open(props = {}) {
  return render(
    <PaneActionsMenu
      session={session}
      busy={false}
      toast={vi.fn()}
      onClose={props.onClose || vi.fn()}
      onStartRename={vi.fn()}
      onMakeFeatured={props.onMakeFeatured}
    />,
  );
}

describe("PaneActionsMenu — Make featured", () => {
  it("is hidden when the parent supplies no handler (non-featured layout, or already featured)", () => {
    open();
    expect(screen.queryByText("Make featured")).not.toBeInTheDocument();
  });

  it("renders with an aria-label naming the session", () => {
    open({ onMakeFeatured: vi.fn() });
    expect(
      screen.getByRole("menuitem", { name: 'Make "Alpha" the featured pane' }),
    ).toBeInTheDocument();
  });

  it("invokes the handler and closes the menu", () => {
    const onMakeFeatured = vi.fn();
    const onClose = vi.fn();
    open({ onMakeFeatured, onClose });

    fireEvent.click(screen.getByText("Make featured"));

    expect(onMakeFeatured).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is NOT busy-gated — it is a layout action and sends nothing to the PTY", () => {
    const onMakeFeatured = vi.fn();
    render(
      <PaneActionsMenu
        session={session}
        busy
        toast={vi.fn()}
        onClose={vi.fn()}
        onStartRename={vi.fn()}
        onMakeFeatured={onMakeFeatured}
      />,
    );
    const row = screen.getByRole("menuitem", { name: 'Make "Alpha" the featured pane' });
    expect(row).not.toBeDisabled();

    globalThis.fetch = vi.fn();
    fireEvent.click(row);
    expect(onMakeFeatured).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
