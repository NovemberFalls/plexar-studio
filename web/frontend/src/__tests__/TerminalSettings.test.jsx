/**
 * TerminalSettings — Settings ▸ Terminal.
 *
 * The contract under test:
 *   - each field writes its correct dotted path under terminal.*
 *   - an out-of-range or non-numeric font size / scrollback is REJECTED inline
 *     (role="alert") and is NOT written — the draft must never hold a value the
 *     backend or xterm would choke on
 *   - the Ctrl+C description matches the real implementation: copies when text
 *     is selected, interrupt only with no selection
 *   - the "not read yet" note is present, and no control claims live effect
 *   - the copy/paste card ships no switches (it is described, not configurable)
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MIN_ZOOM, MAX_ZOOM } from "../utils/terminalFit";
import TerminalSettings, {
  DEFAULT_MONO_STACK,
  FONT_PRESETS,
  CURSOR_STYLES,
  SCROLLBACK_MIN,
  SCROLLBACK_MAX,
} from "../components/settings/TerminalSettings.jsx";

function makeShell({ draft = {}, dirtyPaths = [] } = {}) {
  return {
    get: (path, fallback) => (path in draft ? draft[path] : fallback),
    setField: vi.fn(),
    isDirty: (path) => dirtyPaths.some((p) => p === path || p.startsWith(`${path}.`)),
  };
}

describe("TerminalSettings — paths", () => {
  it("writes the font stack to terminal.font_family from the dropdown", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    const preset = FONT_PRESETS[1].value;
    fireEvent.change(screen.getByTestId("field-terminal.font_family"), {
      target: { value: preset },
    });
    expect(shell.setField).toHaveBeenCalledWith("terminal.font_family", preset);
  });

  it("writes the font stack to terminal.font_family from the free-text override", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    const text = screen.getByLabelText("Custom stack");
    fireEvent.change(text, { target: { value: "'Iosevka', monospace" } });
    expect(shell.setField).toHaveBeenCalledWith("terminal.font_family", "'Iosevka', monospace");
  });

  it("writes an in-range font size to terminal.font_size", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.change(screen.getByTestId("field-terminal.font_size"), { target: { value: "16" } });
    expect(shell.setField).toHaveBeenCalledWith("terminal.font_size", 16);
  });

  it("writes an in-range scrollback to terminal.scrollback", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.change(screen.getByTestId("field-terminal.scrollback"), {
      target: { value: "20000" },
    });
    expect(shell.setField).toHaveBeenCalledWith("terminal.scrollback", 20000);
  });

  it("writes the cursor style to terminal.cursor_style", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.change(screen.getByTestId("field-terminal.cursor_style"), {
      target: { value: "block" },
    });
    expect(shell.setField).toHaveBeenCalledWith("terminal.cursor_style", "block");
    expect(CURSOR_STYLES.map((c) => c.value).sort()).toEqual(["bar", "block", "underline"]);
  });

  it("writes cursor blink to terminal.cursor_blink", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.click(screen.getByLabelText("Cursor blink: On"));
    expect(shell.setField).toHaveBeenCalledWith("terminal.cursor_blink", true);
  });

  it("offers Cockpit's real mono stack as the default preset", () => {
    expect(FONT_PRESETS[0].value).toBe(DEFAULT_MONO_STACK);
    expect(DEFAULT_MONO_STACK).toContain("JetBrains Mono");
    expect(DEFAULT_MONO_STACK).toContain("monospace");
  });
});

describe("TerminalSettings — out-of-range values are refused, not stored", () => {
  it("rejects a font size above the zoom range", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.change(screen.getByTestId("field-terminal.font_size"), {
      target: { value: String(MAX_ZOOM + 5) },
    });
    const alert = screen.getByTestId("invalid-terminal.font_size");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.textContent).toMatch(/Not saved/);
    expect(shell.setField).not.toHaveBeenCalled();
  });

  it("rejects a font size below the zoom range", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.change(screen.getByTestId("field-terminal.font_size"), {
      target: { value: String(MIN_ZOOM - 1) },
    });
    expect(screen.getByTestId("invalid-terminal.font_size")).toBeInTheDocument();
    expect(shell.setField).not.toHaveBeenCalled();
  });

  it("rejects a scrollback above the ceiling", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.change(screen.getByTestId("field-terminal.scrollback"), {
      target: { value: String(SCROLLBACK_MAX + 1) },
    });
    const alert = screen.getByTestId("invalid-terminal.scrollback");
    expect(alert.textContent).toMatch(new RegExp(`between ${SCROLLBACK_MIN} and ${SCROLLBACK_MAX}`));
    expect(shell.setField).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric scrollback", () => {
    const shell = makeShell();
    render(<TerminalSettings {...shell} />);
    fireEvent.change(screen.getByTestId("field-terminal.scrollback"), {
      target: { value: "lots" },
    });
    expect(screen.getByTestId("invalid-terminal.scrollback")).toBeInTheDocument();
    expect(shell.setField).not.toHaveBeenCalled();
  });

  it("marks the invalid input aria-invalid and clears the buffer on blur", () => {
    const shell = makeShell({ draft: { "terminal.scrollback": 10000 } });
    render(<TerminalSettings {...shell} />);
    const input = screen.getByTestId("field-terminal.scrollback");
    fireEvent.change(input, { target: { value: "1" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(input.value).toBe("10000");
    expect(shell.setField).not.toHaveBeenCalled();
  });

  it("states the memory cost of a large scrollback across 8 panes", () => {
    render(<TerminalSettings {...makeShell({ draft: { "terminal.scrollback": 50000 } })} />);
    const note = screen.getByTestId("scrollback-cost");
    expect(note.textContent).toMatch(/per pane/i);
    expect(note.textContent).toMatch(/8 panes/);
    expect(screen.getByTestId("scrollback-estimate").textContent).toMatch(/MB across 8 panes/);
  });
});

describe("TerminalSettings — copy/paste is described, not configurable", () => {
  it("describes Ctrl+C as copying when text is selected", () => {
    render(<TerminalSettings {...makeShell()} />);
    const row = screen.getByTestId("behaviour-ctrl-c");
    expect(row.textContent).toMatch(/Copies when text is selected/i);
    // and the interrupt only in the absence of a selection
    expect(row.textContent).toMatch(/no selection/i);
    expect(row.textContent).toMatch(/x03/);
  });

  it("describes the paste interception and the image upload route", () => {
    render(<TerminalSettings {...makeShell()} />);
    expect(screen.getByTestId("behaviour-ctrl-v").textContent).toMatch(/before xterm sees it/i);
    expect(screen.getByTestId("behaviour-ctrl-v").textContent).toMatch(/bracketed paste/i);
    expect(screen.getByTestId("behaviour-paste-image").textContent).toMatch(/\/api\/upload/);
  });

  it("ships no toggle on the clipboard card", () => {
    render(<TerminalSettings {...makeShell()} />);
    const card = screen.getByTestId("card-terminal-clipboard");
    expect(card.querySelectorAll("button, input, select").length).toBe(0);
    expect(screen.getByTestId("clipboard-readonly").textContent).toMatch(/read-only/i);
  });
});

describe("TerminalSettings — honesty", () => {
  it("says the stored terminal values are not in force yet", () => {
    render(<TerminalSettings {...makeShell()} />);
    const note = screen.getByTestId("not-read-terminal");
    expect(note).toHaveAttribute("role", "note");
    expect(note.textContent).toMatch(/not in force yet/i);
  });

  it("warns that the settings file has no terminal section yet", () => {
    render(<TerminalSettings {...makeShell()} />);
    const note = screen.getByTestId("terminal-section-new");
    expect(note.textContent).toMatch(/unknown settings section/i);
    expect(note.textContent).toMatch(/nothing at all is written/i);
  });

  it("says these options belong to Cockpit's emulator, not to Claude Code", () => {
    render(<TerminalSettings {...makeShell()} />);
    const note = screen.getByTestId("who-owns-this");
    expect(note.textContent).toMatch(/xterm\.js/);
    expect(note.textContent).toMatch(/never sees them/i);
  });

  it("explains how the font size relates to the live zoom stepper", () => {
    render(<TerminalSettings {...makeShell()} />);
    const note = screen.getByTestId("zoom-relation");
    expect(note.textContent).toMatch(/zoom/i);
    expect(note.textContent).toMatch(new RegExp(`${MIN_ZOOM}.${MAX_ZOOM}px`));
  });

  it("marks dirty fields", () => {
    render(<TerminalSettings {...makeShell({ dirtyPaths: ["terminal.scrollback"] })} />);
    expect(screen.getByTestId("field-terminal.scrollback")).toHaveAttribute("data-dirty", "true");
  });
});
