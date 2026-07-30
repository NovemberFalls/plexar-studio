import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
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
    expect(screen.getByRole("button", { name: "Unload loaded-model" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load cold-model" })).toBeTruthy();
    // The VISIBLE text stays short — only the accessible name is qualified.
    expect(screen.getByRole("button", { name: "Load cold-model" })).toHaveTextContent("Load");
  });

  /**
   * ACCESSIBILITY: the visible label is just "Load" / "Unload", so without an
   * aria-label a screen reader hears eight identical buttons with no way to tell
   * which model each one acts on.
   */
  it("names the model in each control's accessible name", () => {
    render(<LocalModelsPanel models={models} controlEnabled />);
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Unload loaded-model", "Load cold-model"]);
  });

  it("calls onLoad / onUnload with the model id", () => {
    const onLoad = vi.fn();
    const onUnload = vi.fn();
    render(<LocalModelsPanel models={models} controlEnabled onLoad={onLoad} onUnload={onUnload} />);
    fireEvent.click(screen.getByRole("button", { name: "Load cold-model" }));
    expect(onLoad).toHaveBeenCalledWith("cold-model");
    fireEvent.click(screen.getByRole("button", { name: "Unload loaded-model" }));
    expect(onUnload).toHaveBeenCalledWith("loaded-model");
  });

  it("shows a busy indicator and disables the button while busyModelId matches", () => {
    render(<LocalModelsPanel models={models} controlEnabled busyModelId="cold-model" />);
    // the busy row's button reads "…" and is disabled — and ANNOUNCES what it is
    // doing, since "…" is nothing to a screen reader.
    const busyBtn = screen.getByRole("button", { name: "Loading cold-model" });
    expect(busyBtn).toHaveTextContent("…");
    expect(busyBtn.disabled).toBe(true);
    expect(busyBtn).toHaveAttribute("aria-busy", "true");
    // the other row is still actionable
    expect(screen.getByRole("button", { name: "Unload loaded-model" }).disabled).toBe(false);
  });
});

/**
 * Offline-face coverage relocated verbatim from the deleted
 * LocalBrokerView.modelsFolder.test.jsx and LocalBrokerView.restartPicker.test.jsx.
 *
 * LocalModelsPanel is LIVE (rendered by engine/EngineModels.jsx), so these
 * assertions cover shipping behaviour — they only lived in those files because
 * LocalBrokerView used to be the panel's host. Nothing here is weakened; the
 * props and expectations are the originals.
 */
describe("LocalModelsPanel offline faces", () => {
  it("still lists disk-only models with an offline note instead of the empty state", () => {
    render(
      <LocalModelsPanel
        models={{ reachable: false, models: [{ id: "/models/foo", state: "available" }] }}
        controlEnabled
      />
    );
    expect(screen.queryByText("Provider offline — no models data.")).not.toBeInTheDocument();
    expect(screen.getByText(/models found on disk/i)).toBeInTheDocument();
    expect(screen.getByText("/models/foo")).toBeInTheDocument();
  });

  it("shows LM Studio 'lms server start' guidance when reason is unreachable", () => {
    render(
      <LocalModelsPanel
        models={{ reachable: false, reason: "unreachable", models: [] }}
        providerKind="lmstudio"
      />
    );
    expect(screen.getByText(/lms server start/i)).toBeInTheDocument();
  });

  it("shows vLLM container guidance when reason is unreachable", () => {
    render(
      <LocalModelsPanel
        models={{ reachable: false, reason: "unreachable", models: [] }}
        providerKind="vllm"
      />
    );
    expect(screen.getByText(/container isn't running/i)).toBeInTheDocument();
  });

  it("still lists disk-only models when reason is server_offline_disk_only", () => {
    render(
      <LocalModelsPanel
        models={{
          reachable: false,
          reason: "server_offline_disk_only",
          models: [{ id: "/models/foo", state: "available" }],
        }}
        providerKind="vllm"
        controlEnabled
      />
    );
    expect(screen.getByText(/found on disk/i)).toBeInTheDocument();
    expect(screen.getByText("/models/foo")).toBeInTheDocument();
  });
});
