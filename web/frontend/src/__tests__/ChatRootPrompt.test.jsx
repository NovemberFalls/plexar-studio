/**
 * The per-conversation root prompt. Four rules, each with a cost behind it.
 *
 * 1. NO SILENT DEFAULT — the location is always displayed.
 * 2. ASKED ONCE — every button is an answer that gets recorded.
 * 3. A FAILED SAVE IS SAID OUT LOUD AND THE DIALOG STAYS OPEN.
 * 4. AN INVALID ROOT IS REFUSED AT THE CONTROL, not at the write.
 *
 * Rule 3 is not hypothetical: the rig shipped a one-shot copy control today
 * whose visible symptom was "it doesn't turn green" and whose real cost was a
 * credential lost forever — no feedback, an optional-chain silently yielding
 * undefined, and an unawaited promise. This dialog decides where a person's
 * transcripts live and has the same failure surface.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatRootPrompt from "../components/chat/ChatRootPrompt";

const DEFAULT_PATH = "C:\\Users\\lenbo\\.plexar-studio\\chat-workspace";

/** `validate` answers per-path so a test can drive good and bad inputs. */
function mockApi({ verdicts = {}, defaultPath = DEFAULT_PATH } = {}) {
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const u = String(url);
    if (u.includes("/root/default")) {
      return Promise.resolve({ ok: true, json: async () => ({ path: defaultPath }) });
    }
    if (u.includes("/root/validate")) {
      const root = JSON.parse(opts.body).root;
      const v = verdicts[root] || { ok: false, resolved: null, error: "No such folder." };
      return Promise.resolve({ ok: true, json: async () => v });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ChatRootPrompt", () => {
  it("RULE 1 — states the default location instead of implying one", async () => {
    mockApi();
    render(<ChatRootPrompt onChoose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-root-default-path")).toHaveTextContent(DEFAULT_PATH));
    // And it comes from the server, not a literal in the component — one
    // resolver owns where data lives.
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/chat/root/default");
  });

  it("RULE 1 — says so rather than showing a blank when it cannot read it", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline")));
    render(<ChatRootPrompt onChoose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-root-default-path"))
        .toHaveTextContent(/could not read/i));
  });

  it("RULE 2 — the three answers are DISTINCT and each is recorded", async () => {
    const calls = [];
    const onChoose = vi.fn(async (choice, root) => { calls.push([choice, root]); });
    mockApi({ verdicts: { "C:\\proj": { ok: true, resolved: "C:\\proj", error: null } } });

    const { rerender } = render(<ChatRootPrompt onChoose={onChoose} />);
    await waitFor(() => screen.getByTestId("chat-root-default-path"));

    fireEvent.click(screen.getByTestId("chat-root-use-default"));
    await waitFor(() => expect(calls).toHaveLength(1));

    rerender(<ChatRootPrompt onChoose={onChoose} />);
    fireEvent.click(screen.getByTestId("chat-root-decline"));
    await waitFor(() => expect(calls).toHaveLength(2));

    fireEvent.change(screen.getByTestId("chat-root-input"), { target: { value: "C:\\proj" } });
    await waitFor(() =>
      expect(screen.getByTestId("chat-root-save-custom")).not.toBeDisabled(), { timeout: 2000 });
    fireEvent.click(screen.getByTestId("chat-root-save-custom"));
    await waitFor(() => expect(calls).toHaveLength(3));

    // PAIRWISE (R10) with a declared set (R19): three answers, all different.
    // "declined" and "default" both send a null root and MUST still differ,
    // because that difference is the only thing stopping the prompt returning
    // to a user who already said no.
    expect(calls).toEqual([
      ["default", null],
      ["declined", null],
      ["custom", "C:\\proj"],
    ]);
    expect(new Set(calls.map((c) => c[0])).size).toBe(3);
    expect(calls[0]).not.toEqual(calls[1]);
  });

  it("RULE 3 — a failed save is SHOWN and the dialog does NOT close", async () => {
    const onChoose = vi.fn(async () => { throw new Error("Disk is read-only."); });
    mockApi();
    render(<ChatRootPrompt onChoose={onChoose} />);
    await waitFor(() => screen.getByTestId("chat-root-default-path"));

    fireEvent.click(screen.getByTestId("chat-root-use-default"));

    await waitFor(() =>
      expect(screen.getByTestId("chat-root-save-error")).toHaveTextContent("Disk is read-only."));
    // Still open. A dialog that closes over a failed write leaves the user
    // believing they chose a location they did not.
    expect(screen.getByTestId("chat-root-prompt")).toBeInTheDocument();
    // And usable again rather than stuck in "Saving…".
    expect(screen.getByTestId("chat-root-use-default")).not.toBeDisabled();
  });

  it("RULE 4 — an invalid root is refused AT THE CONTROL, with the reason", async () => {
    mockApi({ verdicts: { "C:\\good": { ok: true, resolved: "C:\\good", error: null } } });
    render(<ChatRootPrompt onChoose={vi.fn()} />);
    await waitFor(() => screen.getByTestId("chat-root-default-path"));

    const input = screen.getByTestId("chat-root-input");
    fireEvent.change(input, { target: { value: "C:\\bad" } });
    await waitFor(() =>
      expect(screen.getByTestId("chat-root-validation-error")).toHaveTextContent("No such folder."),
      { timeout: 2000 });
    expect(screen.getByTestId("chat-root-save-custom")).toBeDisabled();

    fireEvent.change(input, { target: { value: "C:\\good" } });
    await waitFor(() =>
      expect(screen.getByTestId("chat-root-save-custom")).not.toBeDisabled(), { timeout: 2000 });
  });

  it("a verdict from a PREVIOUS keystroke cannot enable Save for the current text", async () => {
    // The defect the react-hooks lint rule pointed at, which turned out to be
    // real: validate one string, save another. Without `forValue` the button
    // stays enabled from the good verdict while the box now reads something
    // else entirely.
    mockApi({ verdicts: { "C:\\good": { ok: true, resolved: "C:\\good", error: null } } });
    render(<ChatRootPrompt onChoose={vi.fn()} />);
    await waitFor(() => screen.getByTestId("chat-root-default-path"));

    const input = screen.getByTestId("chat-root-input");
    fireEvent.change(input, { target: { value: "C:\\good" } });
    await waitFor(() =>
      expect(screen.getByTestId("chat-root-save-custom")).not.toBeDisabled(), { timeout: 2000 });

    fireEvent.change(input, { target: { value: "C:\\good\\deeper" } });
    // Immediately — before the debounce fires — the stale verdict must not count.
    expect(screen.getByTestId("chat-root-save-custom")).toBeDisabled();
  });

  it("'Ask me later' does NOT record an answer — it is not a fourth choice", async () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    mockApi();
    render(<ChatRootPrompt onChoose={onChoose} onCancel={onCancel} />);
    await waitFor(() => screen.getByTestId("chat-root-default-path"));

    fireEvent.click(screen.getByTestId("chat-root-later"));
    expect(onCancel).toHaveBeenCalled();
    // Crucially: nothing was stored. "Later" leaves root_choice NULL so the
    // question returns on a future launch, which is honest. Recording it would
    // silently become a fourth answer the user never gave.
    expect(onChoose).not.toHaveBeenCalled();
  });
});
