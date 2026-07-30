/**
 * KeybindingsSettings — Settings ▸ Keybindings page, plus the shared registry.
 *
 * The contract under test:
 *   - EVERY entry in KEYBINDINGS renders, with its label and its chord split
 *     into semantic <kbd> caps (and its alternate chord when it has one)
 *   - every non-empty group renders
 *   - the read-only / not-remappable note is present, because a list that
 *     implies remapping works would be a lie
 *   - setField is NEVER called. This is the load-bearing assertion: keybinding
 *     ids contain dots and `system.keybindings` is a REPLACE-not-merge leaf, so
 *     a stray narrow write is either dropped or destroys every sibling binding.
 *   - the registry itself is well-formed: unique ids, known groups, non-empty
 *     chords — a shortcut list that lies is worse than no list at all.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import KeybindingsSettings from "../components/settings/KeybindingsSettings.jsx";
import {
  KEYBINDINGS,
  KEYBINDING_GROUPS,
  groupedKeybindings,
  splitChord,
} from "../utils/keybindings.js";

function makeShell() {
  return {
    get: (path, fallback) => fallback,
    setField: vi.fn(),
    deleteField: vi.fn(),
    isDirty: () => false,
  };
}

function setup() {
  const props = makeShell();
  render(<KeybindingsSettings {...props} />);
  return { props };
}

describe("keybindings registry", () => {
  it("has unique ids", () => {
    const ids = KEYBINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every binding a non-empty chord, label, known group and scope", () => {
    const groupIds = new Set(KEYBINDING_GROUPS.map((g) => g.id));
    KEYBINDINGS.forEach((b) => {
      expect(typeof b.keys).toBe("string");
      expect(b.keys.length).toBeGreaterThan(0);
      expect(b.label.length).toBeGreaterThan(0);
      expect(groupIds.has(b.group)).toBe(true);
      expect(["Global", "Terminal", "Dialog"]).toContain(b.scope);
    });
  });

  it("records the shortcuts App.jsx actually handles", () => {
    const byId = Object.fromEntries(KEYBINDINGS.map((b) => [b.id, b]));
    expect(byId["session.new"].keys).toBe("Ctrl+Shift+N");
    expect(byId["projects.toggle"].keys).toBe("Ctrl+Shift+E");
    expect(byId["projects.toggle"].alsoKeys).toContain("Ctrl+Shift+B");
    expect(byId["palette.open"].keys).toBe("Ctrl+K");
    expect(byId["zoom.in"].keys).toBe("Ctrl+=");
    expect(byId["zoom.out"].keys).toBe("Ctrl+-");
    expect(byId["zoom.reset"].keys).toBe("Ctrl+0");
    for (let i = 1; i <= 8; i += 1) {
      expect(byId[`layout.${i}`].keys).toBe(`Ctrl+Shift+${i}`);
      expect(byId[`pane.focus.${i}`].keys).toBe(`Ctrl+${i}`);
    }
  });

  it("does not claim a global Escape interrupt", () => {
    const esc = KEYBINDINGS.find((b) => b.keys === "Esc");
    expect(esc.scope).toBe("Dialog");
    expect(esc.note).toMatch(/does NOT interrupt/i);
  });

  it("buckets bindings into groups and drops empty ones", () => {
    const groups = groupedKeybindings();
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((g) => expect(g.bindings.length).toBeGreaterThan(0));
    const total = groups.reduce((n, g) => n + g.bindings.length, 0);
    expect(total).toBe(KEYBINDINGS.length);
  });

  it("splits chords into caps, including a literal + key", () => {
    expect(splitChord("Ctrl+Shift+N")).toEqual(["Ctrl", "Shift", "N"]);
    expect(splitChord("Ctrl++")).toEqual(["Ctrl", "+"]);
    expect(splitChord("Ctrl+-")).toEqual(["Ctrl", "-"]);
    expect(splitChord("Esc")).toEqual(["Esc"]);
    expect(splitChord("")).toEqual([]);
  });
});

describe("KeybindingsSettings", () => {
  it("renders a row for EVERY registered binding, with its label", () => {
    setup();
    KEYBINDINGS.forEach((b) => {
      expect(screen.getByTestId(`binding-${b.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`binding-${b.id}`)).toHaveTextContent(b.label);
    });
  });

  it("renders every chord as semantic kbd caps", () => {
    setup();
    KEYBINDINGS.forEach((b) => {
      const chord = screen.getByTestId(`chord-${b.id}`);
      expect(chord).toHaveAttribute("aria-label", b.keys);
      const caps = chord.querySelectorAll("kbd");
      expect(caps.length).toBe(splitChord(b.keys).length);
      splitChord(b.keys).forEach((part, i) => {
        expect(caps[i]).toHaveTextContent(part);
      });
    });
  });

  it("renders alternate chords too", () => {
    setup();
    KEYBINDINGS.filter((b) => b.alsoKeys).forEach((b) => {
      b.alsoKeys.forEach((alt) => {
        expect(screen.getByTestId(`chord-${b.id}-alt-${alt}`)).toHaveAttribute("aria-label", alt);
      });
    });
  });

  it("renders every non-empty group", () => {
    setup();
    groupedKeybindings().forEach((g) => {
      expect(screen.getByTestId(`keybinding-group-${g.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`keybinding-group-${g.id}`)).toHaveTextContent(g.label);
    });
  });

  it("says plainly that these are read-only and remapping is not available", () => {
    setup();
    const note = screen.getByTestId("readonly-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/remapping is not available/i);
  });

  it("renders no rebind inputs — not even disabled ones", () => {
    const { container } = render(<KeybindingsSettings {...makeShell()} />);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("select")).toHaveLength(0);
  });

  it("NEVER calls setField — the dot-key trap makes a stray write destructive", () => {
    const { props } = setup();
    expect(props.setField).not.toHaveBeenCalled();
  });

  it("explains the scopes so a Terminal chord that did nothing is explicable", () => {
    setup();
    const note = screen.getByTestId("scope-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/focused terminal/i);
  });
});
