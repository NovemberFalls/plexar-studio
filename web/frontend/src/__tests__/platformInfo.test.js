/**
 * Tests for web/frontend/src/utils/platformInfo.js — the cached
 * GET /api/platform fetch and the buildWindowsPtyOption() shape guard used to
 * decide whether xterm's Terminal is constructed with `windowsPty`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("buildWindowsPtyOption", () => {
  it("returns the windowsPty shape for win32 + conpty + numeric build_number", async () => {
    const { buildWindowsPtyOption } = await import("../utils/platformInfo.js");
    expect(
      buildWindowsPtyOption({ platform: "win32", pty_backend: "conpty", build_number: 19045 })
    ).toEqual({ backend: "conpty", buildNumber: 19045 });
  });

  it("returns the windowsPty shape for win32 + winpty + numeric build_number", async () => {
    const { buildWindowsPtyOption } = await import("../utils/platformInfo.js");
    expect(
      buildWindowsPtyOption({ platform: "win32", pty_backend: "winpty", build_number: 17763 })
    ).toEqual({ backend: "winpty", buildNumber: 17763 });
  });

  it("omits the option on linux", async () => {
    const { buildWindowsPtyOption } = await import("../utils/platformInfo.js");
    expect(
      buildWindowsPtyOption({ platform: "linux", pty_backend: "unix", build_number: null })
    ).toBeUndefined();
  });

  it("omits the option on darwin", async () => {
    const { buildWindowsPtyOption } = await import("../utils/platformInfo.js");
    expect(
      buildWindowsPtyOption({ platform: "darwin", pty_backend: "unix", build_number: null })
    ).toBeUndefined();
  });

  it("omits the option when build_number is null", async () => {
    const { buildWindowsPtyOption } = await import("../utils/platformInfo.js");
    expect(
      buildWindowsPtyOption({ platform: "win32", pty_backend: "conpty", build_number: null })
    ).toBeUndefined();
  });

  it("omits the option when pty_backend is unrecognized", async () => {
    const { buildWindowsPtyOption } = await import("../utils/platformInfo.js");
    expect(
      buildWindowsPtyOption({ platform: "win32", pty_backend: "unix", build_number: 19045 })
    ).toBeUndefined();
  });

  it("omits the option when info is null (fetch failed)", async () => {
    const { buildWindowsPtyOption } = await import("../utils/platformInfo.js");
    expect(buildWindowsPtyOption(null)).toBeUndefined();
  });
});

describe("getPlatformInfo", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches /api/platform and caches the result across calls", async () => {
    const json = vi.fn().mockResolvedValue({
      platform: "win32",
      pty_backend: "conpty",
      build_number: 19045,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json });
    vi.stubGlobal("fetch", fetchMock);

    const { getPlatformInfo } = await import("../utils/platformInfo.js");
    const first = await getPlatformInfo();
    const second = await getPlatformInfo();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/platform", expect.any(Object));
    expect(first).toEqual({ platform: "win32", pty_backend: "conpty", build_number: 19045 });
    expect(second).toBe(first);
  });

  it("resolves to null when the fetch rejects (network error)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { getPlatformInfo } = await import("../utils/platformInfo.js");
    await expect(getPlatformInfo()).resolves.toBeNull();
  });

  it("resolves to null when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    const { getPlatformInfo } = await import("../utils/platformInfo.js");
    await expect(getPlatformInfo()).resolves.toBeNull();
  });

  it("resolves to null when fetch itself is unavailable", async () => {
    vi.stubGlobal("fetch", undefined);

    const { getPlatformInfo } = await import("../utils/platformInfo.js");
    await expect(getPlatformInfo()).resolves.toBeNull();
  });
});
