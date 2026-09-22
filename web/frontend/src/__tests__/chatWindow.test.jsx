/**
 * Plexar Chat is a SECTION — it lights in the rail and replaces the content
 * area exactly as Settings does — rendered by a Tauri child webview, never an
 * iframe.
 *
 * WHY A CHILD WEBVIEW, MEASURED 2026-09-22 against the live deployments:
 *
 *   Chat:   content-security-policy: … frame-ancestors 'none'
 *   Studio: csp: "default-src 'self'; …"   (no frame-src)
 *
 * TWO INDEPENDENT REFUSALS. An iframe needs both relaxed, and relaxing Chat's
 * would spend a public product's clickjacking defence so one desktop client can
 * embed it — with Studio's origin being `http://localhost:8420`, that would let
 * any page served from localhost on a user's machine frame Chat. A child webview
 * is a top-level browsing context, so neither header is in play.
 *
 * NOTE ON HISTORY, because this file previously asserted the OPPOSITE: the first
 * build made CHAT an action that opened a separate window and could never light.
 * That was green and it was the wrong product — the owner wants it to replace
 * the panes like Settings, with the Projects drawer hidden to reclaim space.
 * These tests pin the corrected contract; the inversion is deliberate.
 */

import fs from "node:fs";

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import Rail from "../components/shell/Rail.jsx";
import ChatView from "../components/ChatView.jsx";

const CHAT_URL_FALLBACK = "https://plexar-chat.boord-its.com";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ── CHAT is a real destination ────────────────────────────

describe("the CHAT rail item is a destination", () => {
  it("lights when it is the active section", () => {
    render(<Rail activeSection="chat" onSelectSection={() => {}} />);
    expect(screen.getByLabelText("CHAT")).toHaveAttribute("aria-current", "page");
  });

  it("does not light when another section is active", () => {
    // The twin: a Rail that lit everything would pass the case above.
    render(<Rail activeSection="engine" onSelectSection={() => {}} />);
    expect(screen.getByLabelText("CHAT")).not.toHaveAttribute("aria-current");
    expect(screen.getByLabelText("ENGINE")).toHaveAttribute("aria-current", "page");
  });

  it("PROJECTS still tracks the drawer, not activeSection", () => {
    // The one rail item that is NOT a destination. Guards against a change that
    // makes every item behave alike.
    render(<Rail activeSection="chat" onSelectSection={() => {}} projectsDrawerOpen />);
    expect(screen.getByLabelText("PROJECTS")).toHaveAttribute("aria-current", "page");
  });

  it("reports the click to the parent", () => {
    const onSelect = vi.fn();
    render(<Rail activeSection="work" onSelectSection={onSelect} />);
    fireEvent.click(screen.getByLabelText("CHAT"));
    expect(onSelect).toHaveBeenCalledWith("chat");
  });
});

// ── the App wiring, read structurally ─────────────────────
//
// Structural rather than behavioural: mounting App drags in the terminal stack,
// every poller and a WebSocket, and the facts under test are three one-line
// decisions. `modelHonesty.test.jsx` already uses this shape for the same reason
// — a rule that must hold at a specific site is checked at that site.

describe("App wires chat as a section", () => {
  const app = () => fs.readFileSync("src/App.jsx", "utf8");

  it("SECTION_TITLES has a chat entry", () => {
    // It IS a section now. Without a title the command bar renders blank.
    expect(/const SECTION_TITLES = \{[^}]*chat: "Plexar Chat"/s.test(app())).toBe(true);
  });

  it("selectSection does NOT early-return for chat", () => {
    // The inverse of the first build. An early return here would light the rail
    // and never change the content area.
    expect(/if \(section === "chat"\)/.test(app())).toBe(false);
  });

  it("the Projects drawer is hidden while in chat", () => {
    expect(/sidebarOpen && activeSection !== "chat"/.test(app())).toBe(true);
  });

  it("leaving chat RESTORES the drawer — sidebarOpen is never cleared for it", () => {
    // Forcing the drawer shut would silently discard the user's layout. The
    // condition must be a render-time test, not a state mutation.
    expect(/setSidebarOpen\(false\)[^\n]*chat|chat[^\n]*setSidebarOpen\(false\)/.test(app())).toBe(false);
  });

  it("renders ChatView, not an iframe", () => {
    expect(app().includes("<ChatView")).toBe(true);
    expect(app().toLowerCase().includes("<iframe")).toBe(false);
  });
});

// ── the capability grant ──────────────────────────────────
//
// The code calls these at runtime. Tauri denies an ungranted command, which a
// unit test cannot see — the app would build, ship, and fail on first click.

describe("Tauri capabilities grant what ChatView calls", () => {
  const NEEDED = [
    "core:webview:allow-create-webview",
    "core:webview:allow-set-webview-position",
    "core:webview:allow-set-webview-size",
    "core:webview:allow-webview-hide",
    "core:webview:allow-webview-show",
    "core:webview:allow-webview-close",
  ];
  const caps = (f) =>
    JSON.parse(fs.readFileSync(`src-tauri/capabilities/${f}`, "utf8"));

  it.each(["default.json", "main.json"])("%s grants every child-webview permission", (f) => {
    const perms = caps(f).permissions;
    for (const n of NEEDED) expect(perms).toContain(n);
  });

  it("does NOT hand Chat's origin the Tauri command surface", () => {
    // `remote.urls` is who may CALL Tauri commands. Adding a third-party page
    // there would give it the app's own API, which Chat neither needs nor
    // should have.
    const urls = caps("default.json").remote?.urls ?? [];
    expect(urls.join(" ")).not.toMatch(/plexar-chat/);
  });
});

// ── ChatView outside Tauri ────────────────────────────────

describe("ChatView degrades honestly in a browser", () => {
  it("explains itself instead of rendering a blank area", () => {
    // vitest is not Tauri, so this is the real fallback path.
    render(<ChatView url={CHAT_URL_FALLBACK} />);
    expect(screen.getByTestId("chat-view")).toBeInTheDocument();
    expect(screen.getByText(/opens in the desktop app/i)).toBeInTheDocument();
  });

  it("offers the address rather than swallowing it", () => {
    render(<ChatView url={CHAT_URL_FALLBACK} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", CHAT_URL_FALLBACK);
  });

  it("states WHY there is no iframe fallback", () => {
    // A blank panel with no explanation is the failure this replaces.
    render(<ChatView url={CHAT_URL_FALLBACK} />);
    expect(screen.getByText(/frame-ancestors 'none'/)).toBeInTheDocument();
  });
});

// ── the drift guard ───────────────────────────────────────

describe("the default address is written once", () => {
  it("App.jsx's fallback equals settings_store's default", () => {
    // Two spellings of one default is the drift DEFAULT_MODEL_ID exists to
    // prevent. Read BOTH files and require them equal.
    const fromApp = fs.readFileSync("src/App.jsx", "utf8")
      .match(/const CHAT_URL_FALLBACK = "([^"]+)"/)?.[1];
    const fromStore = fs.readFileSync("../settings_store.py", "utf8")
      .match(/"chat":\s*\{"url":\s*"([^"]+)"\}/)?.[1];
    expect(fromApp).toBeTruthy();
    expect(fromStore).toBeTruthy();
    expect(fromApp).toBe(fromStore);
  });
});
