/**
 * VoiceButton — the four availability reasons voice_service.py separates
 * must render DISTINGUISHABLY, because they imply different fixes. See
 * components/chat/VoiceButton.jsx for why the button is never enabled.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import VoiceButton from "../components/chat/VoiceButton.jsx";

const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

afterEach(() => vi.restoreAllMocks());

const CASES = [
  ["not_installed", "Not installed", { detail: "Python package(s) not installed: faster_whisper." }],
  ["model_missing", "Model not downloaded", { detail: "Model file(s) not downloaded yet: kokoro." }],
  ["unsupported", "Not supported in this build", { detail: "Voice support is not bundled in this desktop build." }],
  ["check_failed", "Could not check", { detail: "Could not determine whether onnxruntime is installed." }],
];

describe("VoiceButton", () => {
  it.each(CASES)("renders %s distinguishably from the other reasons", async (reason, label, { detail }) => {
    globalThis.fetch = vi.fn(() => ok({ available: false, reason, detail, components: {} }));
    render(<VoiceButton />);
    const mic = await screen.findByLabelText("Voice input");
    expect(mic).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(mic.title).toContain(label));
    fireEvent.click(mic);
    expect(await screen.findByText(label, { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it("never renders a 0-state that looks like ready — available:true still stays disabled with its own note", async () => {
    globalThis.fetch = vi.fn(() => ok({
      available: true, reason: null,
      detail: "Speech-to-text, voice activity detection and text-to-speech are ready.",
      components: {},
    }));
    render(<VoiceButton />);
    const mic = await screen.findByLabelText("Voice input");
    expect(mic).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(mic);
    expect(await screen.findByText(/capture pipeline wired/i)).toBeInTheDocument();
  });
});
