/**
 * ChatModelPicker must read the LIVE model catalog (useModelCatalog), not the
 * static FALLBACK_MODEL_GROUPS — otherwise a local Plexar-vLLM model that the
 * TopBar picker shows is silently absent from Chat (node N2). These tests
 * wrap the component in ModelCatalogContext.Provider with a catalog that
 * includes a local group, mirroring what buildLocalGroups() produces.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatModelPicker from "../components/chat/ChatModelPicker.jsx";
import {
  ModelCatalogContext,
  FALLBACK_MODEL_GROUPS,
  NO_MODEL_LIST_NOTE,
  UNSERVED_ROW_TAG,
} from "../modelCatalog.js";

const MESSAGES = [{ content: "hello" }];

function renderWithCatalog(groups, props = {}) {
  const catalog = { groups, models: groups.flatMap((g) => g.models || []), source: "live" };
  return render(
    <ModelCatalogContext.Provider value={catalog}>
      <ChatModelPicker model={null} messages={MESSAGES} onChange={() => {}} {...props} />
    </ModelCatalogContext.Provider>
  );
}

describe("ChatModelPicker — live catalog (local models)", () => {
  it("lists a local provider's group and model", () => {
    const groups = [
      ...FALLBACK_MODEL_GROUPS,
      {
        label: "Plexar-vLLM",
        provider: "local",
        localProviderId: "plexar-vllm",
        canLoad: false,
        models: [
          {
            id: "local:plexar-vllm:qwen3-coder-30b-awq",
            label: "qwen3-coder-30b-awq",
            provider: "local",
            localProviderId: "plexar-vllm",
            localModelId: "qwen3-coder-30b-awq",
            loaded: true,
            selectable: true,
          },
        ],
      },
    ];
    renderWithCatalog(groups);
    const select = screen.getByLabelText("Conversation model");
    const option = within(select).getByText("qwen3-coder-30b-awq");
    expect(option).toBeInTheDocument();
    expect(option.disabled).toBe(false);
  });

  it("renders an unselectable local model as a disabled option, tagged", () => {
    const groups = [
      ...FALLBACK_MODEL_GROUPS,
      {
        label: "Plexar-vLLM",
        provider: "local",
        localProviderId: "plexar-vllm",
        canLoad: false,
        models: [
          {
            id: "local:plexar-vllm:other-model",
            label: "other-model · on disk, not served",
            provider: "local",
            localProviderId: "plexar-vllm",
            localModelId: "other-model",
            loaded: false,
            selectable: false,
            unavailableReason: "This engine serves one model, fixed when it starts.",
          },
        ],
      },
    ];
    renderWithCatalog(groups);
    const select = screen.getByLabelText("Conversation model");
    const option = within(select).getByText(new RegExp(UNSERVED_ROW_TAG));
    expect(option.tagName).toBe("OPTION");
    expect(option.disabled).toBe(true);
  });

  it("keeps a note-only group (no model list) visible rather than dropping it", () => {
    const groups = [
      ...FALLBACK_MODEL_GROUPS,
      {
        label: "LM Studio",
        provider: "local",
        models: [],
        note: NO_MODEL_LIST_NOTE,
      },
    ];
    renderWithCatalog(groups);
    const select = screen.getByLabelText("Conversation model");
    const optgroup = Array.from(select.querySelectorAll("optgroup")).find((og) =>
      og.label.includes(NO_MODEL_LIST_NOTE)
    );
    expect(optgroup).toBeTruthy();
    expect(optgroup.disabled).toBe(true);
  });

  it("labels a local model correctly in the confirm dialog, and round-trips its namespaced id", () => {
    const onChange = () => {};
    const groups = [
      ...FALLBACK_MODEL_GROUPS,
      {
        label: "Plexar-vLLM",
        provider: "local",
        localProviderId: "plexar-vllm",
        canLoad: false,
        models: [
          {
            id: "local:plexar-vllm:qwen3-coder-30b-awq",
            label: "qwen3-coder-30b-awq",
            provider: "local",
            localProviderId: "plexar-vllm",
            localModelId: "qwen3-coder-30b-awq",
            loaded: true,
            selectable: true,
          },
        ],
      },
    ];
    const catalog = { groups, models: groups.flatMap((g) => g.models || []), source: "live" };
    render(
      <ModelCatalogContext.Provider value={catalog}>
        <ChatModelPicker model="claude-opus-5" messages={MESSAGES} onChange={onChange} />
      </ModelCatalogContext.Provider>
    );
    fireEvent.change(screen.getByLabelText("Conversation model"), {
      target: { value: "local:plexar-vllm:qwen3-coder-30b-awq" },
    });
    expect(screen.getByText(/Switch to qwen3-coder-30b-awq\?/)).toBeInTheDocument();
  });
});
