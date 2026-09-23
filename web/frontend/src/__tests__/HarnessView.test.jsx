/**
 * Tests for HarnessView (web/frontend/src/components/HarnessView.jsx).
 *
 * WebSocket is mocked with a minimal class that captures the most recently
 * created instance so tests can drive `onmessage`/`onclose` directly — the
 * same "capture the constructed instance" strategy other Cockpit test files
 * use for xterm/WS. fetch is mocked per-test.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import HarnessView from "../components/HarnessView";

let lastWs = null;

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    lastWs = this;
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  lastWs = null;
  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = vi.fn(async (url) => {
    if (typeof url === "string" && url.includes("/prompt")) {
      return { ok: true, status: 202, json: async () => ({ accepted: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSession(overrides = {}) {
  return {
    id: 1,
    name: "Test Session",
    workdir: "C:\\Code\\proj",
    harness: "plexar-harness",
    harnessSessionId: "sess-123",
    harnessConfigOptions: [],
    status: "running",
    ...overrides,
  };
}

describe("HarnessView", () => {
  it("streams agent_message_chunk into visible text", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    lastWs.emit({ type: "update", session_id: "sess-123", kind: "agent_message_chunk", payload: { text: "Hello " } });
    lastWs.emit({ type: "update", session_id: "sess-123", kind: "agent_message_chunk", payload: { text: "world" } });
    await waitFor(() => expect(screen.getByTestId("harness-answer-text")).toHaveTextContent("Hello world"));
  });

  it("renders a tool card for tool_call", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    lastWs.emit({
      type: "update",
      session_id: "sess-123",
      kind: "tool_call",
      payload: { id: "t1", name: "Read", status: "running", args: { path: "a.txt" } },
    });
    await waitFor(() => expect(screen.getByTestId("tool-card-t1")).toHaveTextContent("Read"));
  });

  it("renders the usage meter on usage_update", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    lastWs.emit({
      type: "update",
      session_id: "sess-123",
      kind: "usage_update",
      payload: { used_tokens: 50, context_window: 200 },
    });
    await waitFor(() => expect(screen.getByTestId("harness-usage-meter")).toHaveTextContent("25%"));
  });

  it("ignores unknown update kinds without error", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    expect(() =>
      lastWs.emit({ type: "update", session_id: "sess-123", kind: "some_future_kind", payload: { foo: "bar" } })
    ).not.toThrow();
  });

  it("disables the composer while a turn is in flight, re-enables on turn_end", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeDisabled());

    lastWs.emit({ type: "turn_end", session_id: "sess-123", stop_reason: "end_turn", error: null });
    await waitFor(() => expect(screen.getByLabelText("Message")).not.toBeDisabled());
  });

  it("shows the node_too_old friendly banner on a runtime_error frame", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    lastWs.emit({
      type: "runtime_error",
      session_id: "sess-123",
      reason: "node_too_old",
      exit_code: 1,
      message: "raw message",
    });
    await waitFor(() =>
      expect(screen.getByTestId("harness-error-banner")).toHaveTextContent(
        "Plexar Harness needs Node 22.19 or newer."
      )
    );
  });

  it("falls back to the frame's own message for an unrecognized reason", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    lastWs.emit({
      type: "turn_end",
      session_id: "sess-123",
      stop_reason: null,
      error: "some backend-specific failure text",
    });
    await waitFor(() =>
      expect(screen.getByTestId("harness-error-banner")).toHaveTextContent("some backend-specific failure text")
    );
  });

  it("a session that failed to start explains itself instead of rendering blank", () => {
    const onOpenSettings = vi.fn();
    render(
      <HarnessView
        session={{ ...makeSession(), harnessSessionId: null, status: "error",
          startError: { reason: "key_missing", message: "no PLEXAR_HARNESS_KEY configured" } }}
        onClose={() => {}}
        toast={() => {}}
        onOpenSettings={onOpenSettings}
      />
    );
    expect(screen.getByTestId("harness-error-banner")).toHaveTextContent("Add your Plexar Harness key in Settings.");
    expect(screen.queryByText("key_missing")).toBeNull();
    fireEvent.click(screen.getByText("Open Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeDisabled();
  });
});
