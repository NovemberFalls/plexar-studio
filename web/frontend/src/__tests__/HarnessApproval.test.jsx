/**
 * Tests for HarnessApprovalDialog (web/frontend/src/components/HarnessApprovalDialog.jsx)
 * and its queueing behaviour as driven by HarnessView.
 *
 * No window.confirm/prompt/alert usage is asserted repo-wide by
 * __tests__/NoNativeDialogs.test.jsx; this file does not duplicate that scan.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import HarnessView from "../components/HarnessView";
import HarnessApprovalDialog from "../components/HarnessApprovalDialog";

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
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
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

describe("HarnessApprovalDialog standalone", () => {
  it("renders tool name/params and posts the right option_id per button", () => {
    const onResolve = vi.fn();
    render(
      <HarnessApprovalDialog
        request={{ request_id: "r1", session_id: "sess-123", params: { tool_name: "Bash", command: "ls" } }}
        onResolve={onResolve}
      />
    );
    expect(screen.getByTestId("harness-approval-tool")).toHaveTextContent("Bash");
    expect(screen.getByTestId("harness-approval-params")).toHaveTextContent("ls");

    fireEvent.click(screen.getByTestId("harness-approval-allow"));
    expect(onResolve).toHaveBeenCalledWith("allow-once");

    fireEvent.click(screen.getByTestId("harness-approval-reject"));
    expect(onResolve).toHaveBeenCalledWith("reject-once");
  });
});

describe("HarnessApprovalDialog via HarnessView (permission frame + queue)", () => {
  it("opens the modal on a permission frame and posts to the permissions route", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());

    lastWs.emit({
      type: "permission",
      request_id: "req-1",
      session_id: "sess-123",
      params: { tool_name: "Write", path: "a.txt" },
    });

    await waitFor(() => expect(screen.getByTestId("harness-approval-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("harness-approval-tool")).toHaveTextContent("Write");

    fireEvent.click(screen.getByTestId("harness-approval-allow"));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/harness/permissions/req-1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ option_id: "allow-once" }),
        })
      )
    );
  });

  it("shows the next queued permission request after the first resolves", async () => {
    render(<HarnessView session={makeSession()} onClose={() => {}} toast={() => {}} />);
    await waitFor(() => expect(lastWs).not.toBeNull());

    lastWs.emit({ type: "permission", request_id: "req-1", session_id: "sess-123", params: { tool_name: "Write" } });
    lastWs.emit({ type: "permission", request_id: "req-2", session_id: "sess-123", params: { tool_name: "Bash" } });

    await waitFor(() => expect(screen.getByTestId("harness-approval-tool")).toHaveTextContent("Write"));

    fireEvent.click(screen.getByTestId("harness-approval-reject"));

    await waitFor(() => expect(screen.getByTestId("harness-approval-tool")).toHaveTextContent("Bash"));
  });
});
