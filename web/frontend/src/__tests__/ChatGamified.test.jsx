/**
 * Model picker + gamified strip.
 *
 * Two rules under test, and both are about not lying to the user:
 *
 *   · switching model RE-SENDS the whole thread, which costs money and may not
 *     fit — so it is confirmed, never silent;
 *   · every gamified number is a real measurement. A streak with a hole in it
 *     is not a streak, and a counter that rewards nothing teaches people to
 *     ignore the counter.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatModelPicker from "../components/chat/ChatModelPicker.jsx";
import ChatStreak from "../components/chat/ChatStreak.jsx";
import { computeStreak, depthTier } from "../components/chat/streak.js";

const MESSAGES = [{ content: "x".repeat(4000) }, { content: "y".repeat(4000) }];

describe("ChatModelPicker", () => {
  it("does not switch until the user confirms", () => {
    const onChange = vi.fn();
    render(<ChatModelPicker model="claude-opus-5" messages={MESSAGES} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Conversation model"),
                     { target: { value: "claude-sonnet-5" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /confirm model change/i })).toBeInTheDocument();
  });

  it("spells out the three consequences a dropdown cannot convey", () => {
    render(<ChatModelPicker model="claude-opus-5" messages={MESSAGES} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Conversation model"),
                     { target: { value: "claude-sonnet-5" } });

    expect(screen.getByText(/entire conversation is re-sent/i)).toBeInTheDocument();
    expect(screen.getByText(/cache warmth is lost/i)).toBeInTheDocument();
    expect(screen.getByText(/smaller context window, it may not fit/i)).toBeInTheDocument();
  });

  it("labels the token figure as approximate rather than stating it as fact", () => {
    render(<ChatModelPicker model="claude-opus-5" messages={MESSAGES} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Conversation model"),
                     { target: { value: "claude-sonnet-5" } });
    expect(screen.getByText(/approximate/i)).toBeInTheDocument();
  });

  it("applies the change only on confirm", () => {
    const onChange = vi.fn();
    render(<ChatModelPicker model="claude-opus-5" messages={MESSAGES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Conversation model"),
                     { target: { value: "claude-sonnet-5" } });
    fireEvent.click(screen.getByText("Switch and re-inject"));
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-5");
  });

  it("cancelling leaves the model alone", () => {
    const onChange = vi.fn();
    render(<ChatModelPicker model="claude-opus-5" messages={MESSAGES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Conversation model"),
                     { target: { value: "claude-sonnet-5" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("streak maths", () => {
  const day = (offset) => {
    const d = new Date("2026-08-01T12:00:00Z");
    d.setDate(d.getDate() - offset);
    return { last_message_at: d.toISOString(), message_count: 1 };
  };
  const NOW = new Date("2026-08-01T12:00:00Z");

  it("counts consecutive days ending today", () => {
    expect(computeStreak([day(0), day(1), day(2)], NOW)).toBe(3);
  });

  it("STOPS at a gap rather than bridging it", () => {
    // A streak with a hole in it is not a streak. Bridging would make the
    // number a decoration instead of a fact.
    expect(computeStreak([day(0), day(1), day(3), day(4)], NOW)).toBe(2);
  });

  it("keeps the streak alive when today has nothing yet", () => {
    // Otherwise it reads as broken every morning until you chat.
    expect(computeStreak([day(1), day(2)], NOW)).toBe(2);
  });

  it("is zero with no history, never a flattering default", () => {
    expect(computeStreak([], NOW)).toBe(0);
    expect(computeStreak([{ message_count: 3 }], NOW)).toBe(0);
  });

  it("ignores unparseable timestamps instead of counting them", () => {
    expect(computeStreak([{ last_message_at: "not-a-date" }], NOW)).toBe(0);
  });

  it("awards a depth tier only once its threshold is really passed", () => {
    expect(depthTier(4)).toBeNull();
    expect(depthTier(5).label).toBe("Warmed up");
    expect(depthTier(120).label).toBe("Epic");
  });
});

describe("ChatStreak", () => {
  it("renders nothing on a first run rather than a row of zeroes", () => {
    const { container } = render(<ChatStreak conversations={[]} activeMessageCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows real totals drawn from the conversations", () => {
    render(<ChatStreak
      conversations={[{ message_count: 12, last_message_at: new Date().toISOString() },
                      { message_count: 3, last_message_at: new Date().toISOString() }]}
      activeMessageCount={0} />);
    expect(screen.getByText("15")).toBeInTheDocument();   // total messages
    expect(screen.getByText("12")).toBeInTheDocument();   // longest thread
  });
});
