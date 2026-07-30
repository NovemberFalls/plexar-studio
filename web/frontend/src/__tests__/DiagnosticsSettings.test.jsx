/**
 * Tests for Settings ▸ Diagnostics & logs.
 *
 * The rules under test:
 *   - lines render newest-LAST, coloured per parsed level, and a line that does
 *     not match the log format still renders VERBATIM (never dropped)
 *   - the level filter and the text filter each narrow the list, and the page
 *     says they apply to the LOADED TAIL only
 *   - the line-count control refetches with the right ?lines= value
 *   - file_logging:false gets its own callout and suppresses "log is empty"
 *   - truncated + size_bytes + the rotation ceiling are surfaced
 *   - a level change PUTs, and a refusal surfaces as role="alert"
 *   - Reveal POSTs
 *   - the redaction note is present
 *   - nothing polls unless Follow is on
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import DiagnosticsSettings, {
  parseLogLine,
  levelToken,
  filterLines,
  formatBytes,
} from "../components/settings/DiagnosticsSettings.jsx";

const LINES = [
  "2026-07-30 09:00:01 [DEBUG] cockpit.pty: spawn probe alpha",
  "2026-07-30 09:00:02 [INFO] cockpit.server: listening on 8420",
  "2026-07-30 09:00:03 [WARNING] cockpit.bridge: target still busy",
  "2026-07-30 09:00:04 [ERROR] cockpit.server: write failed alpha",
  "Traceback (most recent call last):", // unparseable — must survive verbatim
  '  File "server.py", line 12, in handler',
];

const LOGS = {
  path: "C:\\Users\\x\\.claude-cockpit\\logs\\cockpit.log",
  lines: LINES,
  truncated: true,
  size_bytes: 2_600_000,
  rotation: { max_bytes: 2_097_152, backup_count: 3, max_total_bytes: 8_388_608 },
  file_logging: true,
};

const LEVEL = { level: "INFO", levels: ["DEBUG", "INFO", "WARNING", "ERROR"] };

let logsPayload;
let levelPayload;
let putResponse;
let revealResponse;
let calls;

function install() {
  calls = [];
  globalThis.fetch = vi.fn((url, opts) => {
    calls.push({ url: String(url), method: opts?.method || "GET", body: opts?.body });
    const u = String(url);
    if (u.startsWith("/api/logs/level")) {
      if (opts?.method === "PUT") return Promise.resolve(putResponse());
      return Promise.resolve({ ok: true, json: () => Promise.resolve(levelPayload) });
    }
    if (u.startsWith("/api/logs/reveal")) return Promise.resolve(revealResponse());
    if (u.startsWith("/api/logs")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(logsPayload) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  logsPayload = { ...LOGS };
  levelPayload = { ...LEVEL };
  putResponse = () => ({ ok: true, json: () => Promise.resolve({ ok: true, level: "DEBUG" }) });
  revealResponse = () => ({ ok: true, json: () => Promise.resolve({ ok: true, path: LOGS.path }) });
  install();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const logsGets = () => calls.filter((c) => c.method === "GET" && /^\/api\/logs\?/.test(c.url));

describe("pure helpers", () => {
  it("parseLogLine extracts ts/level/logger/message", () => {
    const row = parseLogLine(LINES[3]);
    expect(row).toMatchObject({
      level: "ERROR",
      ts: "2026-07-30 09:00:04",
      logger: "cockpit.server",
      message: "write failed alpha",
    });
  });

  it("parseLogLine keeps an unparseable line verbatim with a null level", () => {
    const row = parseLogLine("Traceback (most recent call last):");
    expect(row.level).toBeNull();
    expect(row.raw).toBe("Traceback (most recent call last):");
  });

  it("levelToken maps each level to its own token and never errors on unknown", () => {
    expect(levelToken("ERROR")).toBe("var(--cc-error)");
    expect(levelToken("CRITICAL")).toBe("var(--cc-error)");
    expect(levelToken("WARNING")).toBe("var(--cc-waiting)");
    expect(levelToken("INFO")).toBe("var(--cc-fg)");
    expect(levelToken("DEBUG")).toBe("var(--cc-dim)");
    expect(levelToken(null)).toBe("var(--cc-muted)");
  });

  it("filterLines narrows by level and by text", () => {
    const parsed = LINES.map(parseLogLine);
    expect(filterLines(parsed, "ALL", "")).toHaveLength(6);
    expect(filterLines(parsed, "ERROR", "")).toHaveLength(1);
    expect(filterLines(parsed, "ALL", "alpha")).toHaveLength(2);
    expect(filterLines(parsed, "ERROR", "alpha")).toHaveLength(1);
  });

  it("formatBytes says 'unknown' rather than 0 for a missing size", () => {
    expect(formatBytes(undefined)).toBe("unknown");
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2_097_152)).toBe("2.0 MB");
  });
});

describe("DiagnosticsSettings — the viewer", () => {
  it("renders every loaded line, newest last, including the unparseable ones", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-row-0")).toBeInTheDocument());

    const body = screen.getByTestId("logs-body");
    const rows = Array.from(body.querySelectorAll("[data-testid^='log-row-']"));
    expect(rows).toHaveLength(6);
    // Newest-last: the payload order is preserved, so the file's last line is
    // the last row in the DOM.
    expect(rows[0]).toHaveTextContent("spawn probe alpha");
    expect(rows[rows.length - 1]).toHaveTextContent('File "server.py", line 12, in handler');
  });

  it("colours each row by its parsed level", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-row-0")).toBeInTheDocument());
    const at = (i) => screen.getByTestId(`log-row-${i}`);
    expect(at(0)).toHaveAttribute("data-level", "DEBUG");
    expect(at(0).style.color).toBe("var(--cc-dim)");
    expect(at(1).style.color).toBe("var(--cc-fg)");
    expect(at(2).style.color).toBe("var(--cc-waiting)");
    expect(at(3).style.color).toBe("var(--cc-error)");
  });

  it("renders an unparseable line verbatim, not dropped and not mislabelled", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-row-4")).toBeInTheDocument());
    const row = screen.getByTestId("log-row-4");
    expect(row).toHaveAttribute("data-level", "unparsed");
    expect(row).toHaveTextContent("Traceback (most recent call last):");
    expect(row.style.color).toBe("var(--cc-muted)");
  });

  it("the level filter narrows the rendered list", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-row-0")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("logs-level-filter"), { target: { value: "ERROR" } });
    const body = screen.getByTestId("logs-body");
    expect(body.querySelectorAll("[data-testid^='log-row-']")).toHaveLength(1);
    expect(body).toHaveTextContent("write failed alpha");
    expect(screen.getByTestId("logs-visible-count")).toHaveTextContent("1 of 6 shown");
  });

  it("the text filter narrows the rendered list", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-row-0")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("logs-text-filter"), { target: { value: "alpha" } });
    const body = screen.getByTestId("logs-body");
    expect(body.querySelectorAll("[data-testid^='log-row-']")).toHaveLength(2);
    expect(screen.getByTestId("logs-visible-count")).toHaveTextContent("2 of 6 shown");
  });

  it("an empty filter result says it is about the loaded tail, not the file", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-row-0")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("logs-text-filter"), { target: { value: "zzz-nope" } });
    expect(screen.getByTestId("logs-no-matches")).toHaveTextContent(/loaded tail/i);
    const note = screen.getByTestId("logs-filter-scope-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/loaded tail only/i);
    expect(note).toHaveTextContent(/not the whole file/i);
  });

  it("filtering does not refetch — it is client-side over what was loaded", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-row-0")).toBeInTheDocument());
    const before = logsGets().length;
    fireEvent.change(screen.getByTestId("logs-text-filter"), { target: { value: "alpha" } });
    fireEvent.change(screen.getByTestId("logs-level-filter"), { target: { value: "ERROR" } });
    expect(logsGets()).toHaveLength(before);
  });
});

describe("DiagnosticsSettings — tail size and meta", () => {
  it("fetches the default 500-line tail on mount", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(logsGets().length).toBeGreaterThan(0));
    expect(logsGets()[0].url).toBe("/api/logs?lines=500");
  });

  it("the line-count control refetches with the chosen count", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(logsGets().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId("logs-lines-2000"));
    await waitFor(() => expect(logsGets().length).toBe(2));
    expect(logsGets()[1].url).toBe("/api/logs?lines=2000");
  });

  it("surfaces size, truncation and the rotation ceiling", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("logs-size")).toHaveTextContent("2.5 MB"));
    expect(screen.getByTestId("logs-truncated")).toHaveTextContent(/tail only/i);
    expect(screen.getByTestId("logs-rotation")).toHaveTextContent("8.0 MB");
    expect(screen.getByTestId("logs-rotation")).toHaveTextContent("3 rotated copies");
    expect(screen.getByTestId("logs-path")).toHaveTextContent("cockpit.log");
  });

  it("says so when the whole file is loaded rather than implying a tail", async () => {
    logsPayload = { ...LOGS, truncated: false };
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("logs-whole-file")).toBeInTheDocument());
    expect(screen.queryByTestId("logs-truncated")).not.toBeInTheDocument();
  });

  it("Refresh re-reads the tail", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(logsGets().length).toBe(1));
    fireEvent.click(screen.getByTestId("logs-refresh"));
    await waitFor(() => expect(logsGets().length).toBe(2));
  });
});

describe("DiagnosticsSettings — file sink not active", () => {
  it("renders its own callout and NOT an empty-log message", async () => {
    logsPayload = { ...LOGS, lines: [], file_logging: false };
    render(<DiagnosticsSettings />);
    const callout = await screen.findByTestId("logs-no-file-sink");
    expect(callout).toHaveAttribute("role", "note");
    expect(callout).toHaveTextContent(/not active/i);
    expect(callout).toHaveTextContent(/standard error/i);
    expect(screen.queryByTestId("logs-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("logs-body")).not.toBeInTheDocument();
  });

  it("an empty log with a live file sink says the file is empty instead", async () => {
    logsPayload = { ...LOGS, lines: [], file_logging: true };
    render(<DiagnosticsSettings />);
    expect(await screen.findByTestId("logs-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("logs-no-file-sink")).not.toBeInTheDocument();
  });
});

describe("DiagnosticsSettings — log level", () => {
  it("reads the current level and says the change is live, not a draft", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-level-select")).toHaveValue("INFO"));
    const note = screen.getByTestId("log-level-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/not.*a draft setting/i);
  });

  it("PUTs the new level and adopts the server's echo", async () => {
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-level-select")).toHaveValue("INFO"));
    fireEvent.change(screen.getByTestId("log-level-select"), { target: { value: "DEBUG" } });
    await waitFor(() => expect(screen.getByTestId("log-level-select")).toHaveValue("DEBUG"));
    const put = calls.find((c) => c.method === "PUT");
    expect(put.url).toBe("/api/logs/level");
    expect(JSON.parse(put.body)).toEqual({ level: "DEBUG" });
  });

  it("a refused level change surfaces as an alert and keeps the old level", async () => {
    putResponse = () => ({
      ok: false,
      json: () => Promise.resolve({ error: "level must be one of DEBUG, INFO, WARNING, ERROR" }),
    });
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(screen.getByTestId("log-level-select")).toHaveValue("INFO"));
    fireEvent.change(screen.getByTestId("log-level-select"), { target: { value: "ERROR" } });
    const alert = await screen.findByTestId("log-level-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("level must be one of");
    expect(screen.getByTestId("log-level-select")).toHaveValue("INFO");
  });
});

describe("DiagnosticsSettings — reveal + redaction", () => {
  it("Reveal POSTs to /api/logs/reveal", async () => {
    render(<DiagnosticsSettings />);
    fireEvent.click(await screen.findByTestId("logs-reveal"));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/logs/reveal")).toBe(true)
    );
    expect(screen.queryByTestId("logs-reveal-error")).not.toBeInTheDocument();
  });

  it("a failed reveal surfaces the server's reason", async () => {
    revealResponse = () => ({ ok: true, json: () => Promise.resolve({ ok: false, error: "no explorer" }) });
    render(<DiagnosticsSettings />);
    fireEvent.click(await screen.findByTestId("logs-reveal"));
    const alert = await screen.findByTestId("logs-reveal-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("no explorer");
  });

  it("states that key-shaped strings were redacted server-side", async () => {
    render(<DiagnosticsSettings />);
    const note = await screen.findByTestId("logs-redaction-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/redacts key-shaped strings/i);
    expect(note).toHaveTextContent(/Bearer/);
  });
});

describe("DiagnosticsSettings — polling", () => {
  it("installs no interval while Follow is off", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    render(<DiagnosticsSettings />);
    await waitFor(() => expect(logsGets().length).toBe(1));
    // waitFor itself installs a 50ms poll, so assert on OUR cadence only.
    const ours = spy.mock.calls.filter(([, ms]) => ms === 3000);
    expect(ours).toHaveLength(0);
  });

  it("Follow polls, and switching it off clears the interval", async () => {
    vi.useFakeTimers();
    render(<DiagnosticsSettings />);
    await act(async () => {});
    const before = logsGets().length;

    fireEvent.click(screen.getByTestId("logs-follow"));
    expect(screen.getByTestId("logs-follow")).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(logsGets().length).toBe(before + 1);

    fireEvent.click(screen.getByTestId("logs-follow"));
    const after = logsGets().length;
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(logsGets().length).toBe(after);
  });

  it("unmounting stops a running Follow", async () => {
    vi.useFakeTimers();
    const view = render(<DiagnosticsSettings />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("logs-follow"));
    view.unmount();
    const after = logsGets().length;
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(logsGets().length).toBe(after);
  });
});
