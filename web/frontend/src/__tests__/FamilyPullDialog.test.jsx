import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import FamilyPullDialog from "../components/FamilyPullDialog";

function setup(props = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <FamilyPullDialog open parentName="Lead" count={3} onConfirm={onConfirm} onCancel={onCancel} {...props} />,
  );
  return { onConfirm, onCancel };
}

describe("FamilyPullDialog", () => {
  it("renders nothing when closed", () => {
    render(<FamilyPullDialog open={false} parentName="Lead" count={3} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the parent and the worker count", () => {
    setup();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Open Lead's 3 workers too?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open all 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Just this session" })).toBeInTheDocument();
  });

  it("uses the singular for one worker", () => {
    setup({ count: 1 });
    expect(screen.getByText("Open Lead's 1 worker too?")).toBeInTheDocument();
  });

  it("confirm calls onConfirm only", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open all 3" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("'Just this session' cancels", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Just this session" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
