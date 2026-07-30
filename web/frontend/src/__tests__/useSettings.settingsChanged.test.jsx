/**
 * useSettings — reacting to a settings write that did NOT come through this hook.
 *
 * The rail's theme popover persists token overrides directly (useTheme's
 * persistTokenOverrides) so that clearing an override survives a restart. That
 * leaves this hook holding a stale `settings` copy, and the next `Save changes`
 * would happily resurrect the override the user just cleared. So a
 * `cockpit:settings-changed` event triggers a refetch.
 *
 * THE PRECEDENCE UNDER TEST: refetch ONLY when the draft is clean. A user with
 * unsaved edits must never have their pending work clobbered by a background
 * sync — their explicit Save wins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import useSettings from "../hooks/useSettings.js";

const EVENT = "cockpit:settings-changed";

/** Each GET answers with the next queued payload (the last one repeats). */
function mockGets(payloads) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const body = payloads[Math.min(i, payloads.length - 1)];
    i += 1;
    return { ok: true, json: async () => body };
  });
}

const withOverride = {
  path: "/s.json",
  settings: { appearance: { token_overrides: { "--cc-accent": "#ff0000" } } },
};
const cleared = { path: "/s.json", settings: { appearance: { token_overrides: {} } } };

describe("useSettings and cockpit:settings-changed", () => {
  beforeEach(() => {
    mockGets([withOverride, cleared]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refetches when the draft is clean, adopting the server's new state", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.get("appearance.token_overrides")).toEqual({ "--cc-accent": "#ff0000" });

    await act(async () => {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { section: "appearance" } }));
    });

    await waitFor(() =>
      expect(result.current.get("appearance.token_overrides")).toEqual({})
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("IGNORES the event while dirty, leaving the user's draft untouched", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setField("appearance.glow_size", 44));
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { section: "appearance" } }));
    });

    // No second GET, and the pending edit plus the original values both survive.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.get("appearance.glow_size")).toBe(44);
    expect(result.current.get("appearance.token_overrides")).toEqual({ "--cc-accent": "#ff0000" });
    expect(result.current.dirty).toBe(true);
  });

  it("resumes honouring the event once the draft is reverted to clean", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setField("appearance.glow_size", 44));
    act(() => result.current.revert());
    expect(result.current.dirty).toBe(false);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { section: "appearance" } }));
    });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
  });

  it("stops listening after unmount", async () => {
    const { result, unmount } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { section: "appearance" } }));
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
