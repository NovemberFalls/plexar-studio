/**
 * Tests for App.jsx's createSession() -> POST /api/terminals body shape when
 * an OpenRouter model is selected (see task brief: OpenRouter model levers).
 *
 * App.jsx is a large root component with heavy backend/localStorage/timer
 * dependencies, so — following the same isolation strategy already used by
 * App.renameSession.test.jsx — we replicate the exact createSession() body
 * (App.jsx, "Create a new terminal session" block) inside a minimal harness
 * component, importing the REAL getModelProvider from TopBar.jsx so the
 * provider-detection logic under test is not a re-implementation.
 *
 * Contract:
 *   POST /api/terminals body always includes `model: <id as-is>` (backend
 *   ignores it for openrouter sessions), and additionally includes
 *   `provider: "openrouter"` + `providerModel: <id>` when
 *   getModelProvider(id) === "openrouter". Anthropic selections get neither
 *   extra field.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getModelProvider } from "../components/TopBar.jsx";
import { parseLocalModelId } from "../modelCatalog.js";
import { DEFAULT_SPAWN_COLS, DEFAULT_SPAWN_ROWS } from "../utils/terminalFit.js";

const { useState, useCallback } = React;

let nextLocalId = 1;

/**
 * Minimal harness replicating App.jsx's createSession() body construction.
 */
function CreateSessionHarness({ toast }) {
  const [sessions, setSessions] = useState([]);
  const permissionMode = "default";
  const effort = "";
  const fast = false;

  // Mirrors App.jsx's createSession body exactly (spawn-time fields only).
  const createSession = useCallback(
    async (name, workdir, sessionModel) => {
      const localId = nextLocalId++;
      const sessionName = name || `Session ${localId}`;
      const dir = workdir || "C:\\Code";
      const useModel = sessionModel;

      const isOpus =
        useModel === "opus" ||
        useModel === "claude-opus-4-6[1m]" ||
        useModel === "claude-opus-4-7" ||
        useModel === "claude-opus-4-7[1m]" ||
        useModel === "claude-opus-4-8" ||
        useModel === "claude-opus-4-8[1m]";

      const body = {
        name: sessionName,
        model: useModel,
        workdir: dir,
        cols: DEFAULT_SPAWN_COLS,
        rows: DEFAULT_SPAWN_ROWS,
        permissionMode,
        effort,
        fast: isOpus && fast,
        ...(getModelProvider(useModel) === "openrouter"
          ? { provider: "openrouter", providerModel: useModel }
          : {}),
        ...(getModelProvider(useModel) === "local"
          ? (() => {
              const parsed = parseLocalModelId(useModel);
              return parsed
                ? { provider: "local", providerModel: `${parsed.providerId}::${parsed.modelId}` }
                : {};
            })()
          : {}),
      };

      try {
        const res = await fetch("/api/terminals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.error) {
          toast(data.error, "error");
          return;
        }
        setSessions((prev) => [
          ...prev,
          { id: localId, name: sessionName, terminalId: data.id, model: useModel },
        ]);
      } catch (_err) {
        toast("Failed to create session", "error");
      }
    },
    [toast, fast]
  );

  return (
    <div>
      {sessions.map((s) => (
        <span key={s.id} data-testid={`session-${s.id}`}>
          {s.name}:{s.model}
        </span>
      ))}
      <button onClick={() => createSession("Alpha", "C:\\proj", "deepseek/deepseek-v4-pro")}>
        create-openrouter
      </button>
      <button onClick={() => createSession("Bravo", "C:\\proj", "sonnet")}>
        create-anthropic
      </button>
      <button
        onClick={() =>
          createSession("Charlie", "C:\\proj", "local:lmstudio-local:qwen3-coder-30b-awq")
        }
      >
        create-local
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("App.jsx createSession contract — OpenRouter provider fields", () => {
  it("POSTs provider + providerModel for an OpenRouter selection, and keeps model as the slug", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ id: "term-1" }),
    });
    const toast = vi.fn();
    render(<CreateSessionHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("create-openrouter"));
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals",
        expect.objectContaining({ method: "POST" })
      );
    });

    const [, options] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.provider).toBe("openrouter");
    expect(body.providerModel).toBe("deepseek/deepseek-v4-pro");
    expect(body.model).toBe("deepseek/deepseek-v4-pro");
    expect(body.effort).toBe("");
    expect(body.fast).toBe(false);
  });

  it("does NOT add provider/providerModel for an Anthropic selection", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ id: "term-2" }),
    });
    const toast = vi.fn();
    render(<CreateSessionHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("create-anthropic"));
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const [, options] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.provider).toBeUndefined();
    expect(body.providerModel).toBeUndefined();
    expect(body.model).toBe("sonnet");
    // createSession must always send integer cols/rows to the backend.
    expect(Number.isInteger(body.cols)).toBe(true);
    expect(Number.isInteger(body.rows)).toBe(true);
  });

  it("POSTs provider + providerModel (double-colon joined) for a local selection, and keeps model as the picker id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ id: "term-3" }),
    });
    const toast = vi.fn();
    render(<CreateSessionHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("create-local"));
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals",
        expect.objectContaining({ method: "POST" })
      );
    });

    const [, options] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.provider).toBe("local");
    expect(body.providerModel).toBe("lmstudio-local::qwen3-coder-30b-awq");
    expect(body.model).toBe("local:lmstudio-local:qwen3-coder-30b-awq");
  });
});
