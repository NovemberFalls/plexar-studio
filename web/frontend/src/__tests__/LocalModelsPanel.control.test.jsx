import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LocalModelsPanel from "../components/LocalModelsPanel";

const models = {
  reachable: true,
  models: [
    { id: "loaded-model", state: "loaded", arch: "qwen", quantization: "awq" },
    { id: "cold-model", state: "not-loaded", arch: "llama", quantization: "q4" },
  ],
};

describe("LocalModelsPanel control face", () => {
  it("renders no control buttons when controlEnabled is false", () => {
    render(<LocalModelsPanel models={models} controlEnabled={false} />);
    expect(screen.queryByRole("button", { name: /load/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /unload/i })).toBeNull();
  });

  it("shows Unload on a loaded model and Load on an unloaded one", () => {
    render(<LocalModelsPanel models={models} controlEnabled />);
    expect(screen.getByRole("button", { name: "Unload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load" })).toBeTruthy();
  });

  it("calls onLoad / onUnload with the model id", () => {
    const onLoad = vi.fn();
    const onUnload = vi.fn();
    render(<LocalModelsPanel models={models} controlEnabled onLoad={onLoad} onUnload={onUnload} />);
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onLoad).toHaveBeenCalledWith("cold-model");
    fireEvent.click(screen.getByRole("button", { name: "Unload" }));
    expect(onUnload).toHaveBeenCalledWith("loaded-model");
  });

  it("shows a busy indicator and disables the button while busyModelId matches", () => {
    render(<LocalModelsPanel models={models} controlEnabled busyModelId="cold-model" />);
    // the busy row's button reads "…" and is disabled
    const busyBtn = screen.getByRole("button", { name: "…" });
    expect(busyBtn.disabled).toBe(true);
    // the other row is still actionable
    expect(screen.getByRole("button", { name: "Unload" }).disabled).toBe(false);
  });
});
