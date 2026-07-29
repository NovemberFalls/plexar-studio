import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import useReportingData from "../components/localReporting/useReportingData.js";

describe("useReportingData — /api/reporting/models", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        if (String(url).includes("/api/reporting/models")) {
          return Promise.reject(new Error("network error"));
        }
        return Promise.resolve({ ok: false });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades gracefully (reachable:false) when the fetch fails, never throws", async () => {
    const { result } = renderHook(() =>
      useReportingData("lmstudio-local", { enabled: true, window: "lifetime" }),
    );
    await waitFor(() => {
      expect(result.current.modelsReport).toEqual({ reachable: false });
    });
  });

  it("does not poll /api/reporting/models when disabled", async () => {
    renderHook(() => useReportingData("lmstudio-local", { enabled: false, window: "lifetime" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/reporting/models"), expect.anything());
  });
});
