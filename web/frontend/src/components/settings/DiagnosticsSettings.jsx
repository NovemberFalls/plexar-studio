/* eslint-disable react-refresh/only-export-components -- parseLogLine,
   levelToken, filterLines and formatBytes are pure helpers unit-tested
   directly; none is a component. */
/**
 * DiagnosticsSettings — the Settings ▸ Diagnostics & logs page.
 *
 * The owner's requirement was "viewable from here and EASY TO READ", so the log
 * body is a real viewer rather than a dump:
 *   - monospace on --cc-term, one row per line, newest at the BOTTOM, and
 *     scrolled to the bottom on every load — a fresh problem is the last line.
 *   - each row is coloured by the level parsed out of the standard
 *     `<ts> [LEVEL] <logger>: <message>` format that logging_config installs.
 *   - a line that does NOT match that format is rendered VERBATIM in a neutral
 *     colour. Nothing is ever dropped: a traceback body is exactly the part you
 *     need, and it never matches the header format.
 *   - a level filter and a text filter, both purely client-side over the tail
 *     that was fetched — stated on screen, because "no matches" over a 500-line
 *     tail must not read as "that string is not in the log file".
 *
 * Routes (all landed; see CLAUDE.md / the logs contract):
 *   GET  /api/logs?lines=N   → {path, lines, truncated, size_bytes, rotation, file_logging}
 *   GET  /api/logs/level     → {level, levels}
 *   PUT  /api/logs/level     → {ok, level}   ← applies LIVE, not a draft
 *   POST /api/logs/reveal    → {ok, path, error?}  (always 200)
 *
 * Two things this page deliberately does NOT do:
 *   - it does not re-implement redaction. The server already strips key-shaped
 *     strings before the lines leave it; doing it again client-side would either
 *     be redundant or would quietly hide something the server chose to show. The
 *     page instead SAYS that redaction happened, which is what the owner needs to
 *     know before pasting a screenshot into a chat.
 *   - it does not poll on its own. A follow toggle exists, defaults to OFF, and
 *     its interval is cleared on unmount and the moment it is switched off.
 *
 * `file_logging: false` is NOT an empty log. It means the rotating file handler
 * could not be installed (unwritable home, typically) and everything is going to
 * stderr, so there is no file to show. That earns its own --cc-waiting callout
 * and suppresses the "log is empty" message, which would be a wrong diagnosis.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  FileText,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

// ── tokens / shared style fragments (same idiom as ProvidersSettings) ──
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

const LABEL = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];
const LINE_COUNTS = [200, 500, 1000, 2000];
const DEFAULT_LINES = 500;
const FOLLOW_MS = 3000;

/**
 * The format logging_config._formatter() writes:
 *   2026-07-30 12:34:56 [INFO] cockpit.server: message
 * CRITICAL is matched too even though the level selector does not offer it —
 * the logger tree can still emit one and it must not fall through to "unparsed".
 */
const LINE_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:,\d+)? \[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\] ([^:]+): ([\s\S]*)$/;

/**
 * Parse one raw log line. Returns `{level: null, raw}` for anything that does
 * not match — the caller renders that verbatim rather than discarding it.
 */
export function parseLogLine(raw) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const m = LINE_RE.exec(text);
  if (!m) return { level: null, ts: null, logger: null, message: text, raw: text };
  return { level: m[2], ts: m[1], logger: m[3], message: m[4], raw: text };
}

/** Level → colour token. `null` (unparsed) gets a neutral, never an error tint. */
export function levelToken(level) {
  switch (level) {
    case "ERROR":
    case "CRITICAL":
      return "var(--cc-error)";
    case "WARNING":
      return "var(--cc-waiting)";
    case "INFO":
      return "var(--cc-fg)";
    case "DEBUG":
      return "var(--cc-dim)";
    default:
      return "var(--cc-muted)";
  }
}

/**
 * Client-side narrowing over the ALREADY-FETCHED tail.
 *
 * A level filter drops lines with no parseable level, because they carry no
 * level to match. That is a real consequence and the UI says so out loud rather
 * than letting a traceback vanish without explanation.
 */
export function filterLines(parsed, level, text) {
  const needle = (text || "").trim().toLowerCase();
  return parsed.filter((row) => {
    if (level && level !== "ALL") {
      if (level === "ERROR" ? row.level !== "ERROR" && row.level !== "CRITICAL" : row.level !== level) {
        return false;
      }
    }
    if (needle && !row.raw.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── primitives ────────────────────────────────────────────

function CardHeader({ icon: Icon, token, name, children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        paddingBottom: 10,
        marginBottom: 4,
        borderBottom: "1px solid var(--cc-line)",
      }}
    >
      {Icon && (
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: token,
            background: tint(token, 8),
            border: `1px solid ${tint(token, 30)}`,
            flexShrink: 0,
          }}
        >
          <Icon size={12} />
        </span>
      )}
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>{name}</span>
      {children}
    </div>
  );
}

function Callout({ token = "var(--cc-waiting)", icon: Icon = TriangleAlert, children, testId, alert }) {
  return (
    <div
      data-testid={testId}
      role={alert ? "alert" : "note"}
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      <Icon size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

function ActionButton({ label, onClick, disabled, title, accent, testId, icon: Icon, pressed }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      aria-pressed={typeof pressed === "boolean" ? pressed : undefined}
      className="rounded transition-colors hover-bg-elevated"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 10px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 7,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: accent && !disabled ? ACCENT_FG : "var(--cc-fg)",
        border: `1px solid ${accent && !disabled ? "transparent" : "var(--cc-border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {Icon && <Icon size={12} aria-hidden="true" />}
      {label}
    </button>
  );
}

/** Segmented selector used for the line-count control. */
function Segmented({ label, options, value, onChange, format, testIdPrefix }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: "inline-flex",
        overflow: "hidden",
        borderRadius: 8,
        background: "var(--cc-elev)",
        border: "1px solid var(--cc-border)",
      }}
    >
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label}: ${format ? format(opt) : opt}`}
            data-testid={`${testIdPrefix}-${opt}`}
            onClick={() => onChange(opt)}
            className="transition-colors hover-bg-surface"
            style={{
              height: 22,
              padding: "0 10px",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".06em",
              border: "none",
              background: active ? "var(--cc-accent)" : "transparent",
              color: active ? ACCENT_FG : "var(--cc-dim)",
              cursor: "pointer",
            }}
          >
            {format ? format(opt) : opt}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One log row. Module scope + memo-friendly: the parent memoises the filtered
 * array so typing in the text filter does not re-parse 2000 lines.
 */
function LogRow({ row, index }) {
  const token = levelToken(row.level);
  return (
    <div
      data-testid={`log-row-${index}`}
      data-level={row.level || "unparsed"}
      style={{
        display: "flex",
        gap: 8,
        padding: "1px 8px",
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        background: row.level === "ERROR" || row.level === "CRITICAL" ? tint("var(--cc-error)", 6) : "none",
      }}
    >
      {row.level ? (
        <>
          <span style={{ color: "var(--cc-muted)", flexShrink: 0 }}>{row.ts}</span>
          <span style={{ fontWeight: 700, flexShrink: 0, width: 64 }}>{row.level}</span>
          <span style={{ color: "var(--cc-muted)", flexShrink: 0 }}>{row.logger}</span>
          <span style={{ minWidth: 0 }}>{row.message}</span>
        </>
      ) : (
        // Verbatim. No timestamp to invent, no level to guess.
        <span style={{ minWidth: 0 }}>{row.raw}</span>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function DiagnosticsSettings() {
  const [payload, setPayload] = useState(undefined); // undefined = reading, null = unreachable
  const [lineCount, setLineCount] = useState(DEFAULT_LINES);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState("ALL");
  const [textFilter, setTextFilter] = useState("");
  const [follow, setFollow] = useState(false);

  const [logLevel, setLogLevel] = useState(null);
  const [levelChoices, setLevelChoices] = useState(LEVELS);
  const [levelBusy, setLevelBusy] = useState(false);
  const [levelError, setLevelError] = useState(null);
  const [revealError, setRevealError] = useState(null);

  const bodyRef = useRef(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async (count) => {
    try {
      const res = await fetch(`/api/logs?lines=${encodeURIComponent(count)}`);
      const data = res.ok ? await res.json() : null;
      setPayload(data);
    } catch {
      setPayload(null); // best-effort; the offline state is rendered, not thrown
    }
  }, []);

  // Initial read + any line-count change. setLoading lives in the click path,
  // never synchronously in an effect body.
  useEffect(() => {
    load(lineCount);
  }, [load, lineCount]);

  // The live logger level. Intent-free: this is server truth, read once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/logs/level");
        const data = res.ok ? await res.json() : null;
        if (cancelled || !data) return;
        if (typeof data.level === "string") setLogLevel(data.level);
        if (Array.isArray(data.levels) && data.levels.length) setLevelChoices(data.levels);
      } catch {
        // level stays null → the selector says "unknown"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow/tail. OFF by default; the interval only exists while it is on, and
  // is torn down by this effect's cleanup on unmount or on switching off.
  useEffect(() => {
    if (!follow) return undefined;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(lineCount);
    }, FOLLOW_MS);
    return () => clearInterval(id);
  }, [follow, load, lineCount]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await load(lineCount);
    } finally {
      setLoading(false);
    }
  }, [load, lineCount]);

  const changeLevel = useCallback(async (next) => {
    setLevelBusy(true);
    setLevelError(null);
    try {
      const res = await fetch("/api/logs/level", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setLevelError(data?.error || "The server refused the new log level.");
        return;
      }
      setLogLevel(typeof data.level === "string" ? data.level : next);
    } catch (err) {
      setLevelError(`Could not reach Cockpit's server: ${err.message}`);
    } finally {
      setLevelBusy(false);
    }
  }, []);

  const reveal = useCallback(async () => {
    setRevealError(null);
    try {
      const res = await fetch("/api/logs/reveal", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) setRevealError(data?.error || "Cockpit could not open the log folder.");
    } catch (err) {
      setRevealError(`Could not reach Cockpit's server: ${err.message}`);
    }
  }, []);

  // Memoised so its identity only changes when a fetch replaces the payload —
  // a fresh `[]` on every render would re-parse the whole tail per keystroke,
  // which is precisely what the memo below exists to avoid.
  const rawLines = useMemo(
    () => (Array.isArray(payload?.lines) ? payload.lines : []),
    [payload]
  );

  // Parse ONCE per fetch. Typing in the text filter must not re-parse the tail.
  const parsed = useMemo(() => rawLines.map(parseLogLine), [rawLines]);
  const visible = useMemo(
    () => filterLines(parsed, levelFilter, textFilter),
    [parsed, levelFilter, textFilter]
  );
  const rows = useMemo(
    () => visible.map((row, i) => <LogRow key={i} row={row} index={i} />),
    [visible]
  );

  // Newest is last, so the bottom is where a fresh problem is. We only force the
  // scroll while the user is already parked at the bottom — otherwise a follow
  // tick would yank them away from the line they were reading.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows]);

  const onScroll = useCallback((e) => {
    const el = e.currentTarget;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const fileLogging = payload ? payload.file_logging !== false : true;
  const rotation = payload?.rotation || null;
  const filtering = levelFilter !== "ALL" || textFilter.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      {/* ── Log level (live, not a draft) ──────────────── */}
      <div style={CARD} data-testid="card-log-level">
        <CardHeader icon={Bug} token="var(--cc-accent)" name="Log level" />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "200px 1fr",
            gap: 8,
            alignItems: "center",
            padding: "6px 0",
          }}
        >
          <div>
            <div style={LABEL}>Verbosity</div>
            <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 2 }}>
              applies immediately
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <select
              value={logLevel || ""}
              onChange={(e) => changeLevel(e.target.value)}
              disabled={levelBusy}
              aria-label="Log level"
              data-testid="log-level-select"
              className="rounded"
              style={{
                height: 26,
                padding: "0 8px",
                fontSize: 11,
                borderRadius: 7,
                background: "var(--cc-elev)",
                border: "1px solid var(--cc-border)",
                color: "var(--cc-fg)",
                outline: "none",
              }}
            >
              {!logLevel && <option value="">unknown</option>}
              {levelChoices.map((lv) => (
                <option key={lv} value={lv}>
                  {lv}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>
              {logLevel ? `Cockpit is logging at ${logLevel}.` : "Cockpit did not report its level."}
            </span>
          </div>
        </div>

        <div
          role="note"
          data-testid="log-level-note"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 4 }}
        >
          This is <strong>not</strong> a draft setting — changing it takes effect on the running
          server straight away and does not wait for <em>Save changes</em>. It is also not
          persisted, so the level returns to its startup value when Cockpit restarts.
        </div>

        {levelError && (
          <Callout token="var(--cc-error)" testId="log-level-error" alert>
            {levelError}
          </Callout>
        )}
      </div>

      {/* ── Log file ───────────────────────────────────── */}
      <div style={CARD} data-testid="card-logs">
        <CardHeader icon={FileText} token="var(--cc-type)" name="Log file">
          <span style={{ marginLeft: "auto" }} />
          <ActionButton
            label={loading ? "Refreshing…" : "Refresh"}
            icon={RefreshCw}
            onClick={refresh}
            disabled={loading}
            testId="logs-refresh"
            title="Re-read the tail of the log file now"
          />
          <ActionButton
            label={follow ? "Following" : "Follow"}
            onClick={() => setFollow((v) => !v)}
            pressed={follow}
            accent={follow}
            testId="logs-follow"
            title={
              follow
                ? "Re-reading the tail every 3 seconds — click to stop"
                : "Re-read the tail every 3 seconds while this page is open"
            }
          />
          <ActionButton
            label="Reveal"
            icon={FolderOpen}
            onClick={reveal}
            testId="logs-reveal"
            title="Open the folder containing the log file"
          />
        </CardHeader>

        <div
          data-testid="logs-meta"
          style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", padding: "6px 0 2px" }}
        >
          <div>
            <span style={{ color: "var(--cc-muted)" }}>file: </span>
            <span data-testid="logs-path" style={{ fontFamily: "var(--font-mono, monospace)" }}>
              {payload?.path || "unknown"}
            </span>
          </div>
          <div>
            <span style={{ color: "var(--cc-muted)" }}>size: </span>
            <span data-testid="logs-size">{formatBytes(payload?.size_bytes)}</span>
            <span style={{ color: "var(--cc-muted)" }}> · showing </span>
            <span data-testid="logs-shown">{rawLines.length}</span>
            <span style={{ color: "var(--cc-muted)" }}> lines</span>
            {payload?.truncated === true && (
              <span data-testid="logs-truncated" style={{ color: "var(--cc-waiting)", marginLeft: 6 }}>
                tail only — earlier lines are in the file but were not loaded
              </span>
            )}
            {payload?.truncated === false && (
              <span data-testid="logs-whole-file" style={{ color: "var(--cc-muted)", marginLeft: 6 }}>
                (the whole file)
              </span>
            )}
          </div>
          {rotation && (
            <div data-testid="logs-rotation">
              <span style={{ color: "var(--cc-muted)" }}>history kept: </span>
              up to {formatBytes(rotation.max_total_bytes)} total —{" "}
              {formatBytes(rotation.max_bytes)} per file plus {rotation.backup_count} rotated
              {rotation.backup_count === 1 ? " copy" : " copies"}. Anything older than that ceiling
              is already gone.
            </div>
          )}
        </div>

        {/* ── controls ─────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "8px 0",
            borderTop: "1px solid var(--cc-line)",
            marginTop: 8,
          }}
        >
          <span style={LABEL}>Load</span>
          <Segmented
            label="Lines to load"
            options={LINE_COUNTS}
            value={lineCount}
            onChange={setLineCount}
            testIdPrefix="logs-lines"
          />

          <span style={LABEL}>Level</span>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            aria-label="Filter by level"
            data-testid="logs-level-filter"
            className="rounded"
            style={{
              height: 26,
              padding: "0 8px",
              fontSize: 11,
              borderRadius: 7,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
              outline: "none",
            }}
          >
            <option value="ALL">All levels</option>
            {LEVELS.map((lv) => (
              <option key={lv} value={lv}>
                {lv} only
              </option>
            ))}
          </select>

          <input
            type="text"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Filter text…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Filter log text"
            data-testid="logs-text-filter"
            className="rounded"
            style={{
              flex: 1,
              minWidth: 120,
              height: 26,
              padding: "0 8px",
              fontSize: 11,
              borderRadius: 7,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
              outline: "none",
            }}
          />
          <span data-testid="logs-visible-count" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
            {visible.length} of {rawLines.length} shown
          </span>
        </div>

        {/* ── the viewer ───────────────────────────────── */}
        {!fileLogging ? (
          <Callout testId="logs-no-file-sink">
            File logging is <strong>not active</strong>. Cockpit could not open its log file (most
            often an unwritable home folder), so everything is going to standard error only and
            there is no file to show here. This is not an empty log — the messages exist, just not
            on disk. Run Cockpit from a terminal to see them.
          </Callout>
        ) : (
          <>
            <div
              ref={bodyRef}
              onScroll={onScroll}
              data-testid="logs-body"
              tabIndex={0}
              role="log"
              aria-label="Cockpit log tail"
              style={{
                marginTop: 4,
                height: 420,
                overflow: "auto",
                borderRadius: 9,
                background: "var(--cc-term)",
                border: "1px solid var(--cc-border)",
                fontFamily: "var(--font-mono, monospace)",
                padding: "6px 0",
              }}
            >
              {payload === undefined ? (
                <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--cc-muted)" }}>
                  Reading the log file…
                </div>
              ) : payload === null ? (
                <div
                  data-testid="logs-unreachable"
                  role="alert"
                  style={{ padding: "6px 10px", fontSize: 11, color: "var(--cc-error)" }}
                >
                  Cockpit&apos;s server did not answer, so the log could not be read. This says
                  nothing about what is in the file.
                </div>
              ) : rawLines.length === 0 ? (
                <div
                  data-testid="logs-empty"
                  style={{ padding: "6px 10px", fontSize: 11, color: "var(--cc-muted)" }}
                >
                  The log file is empty.
                </div>
              ) : visible.length === 0 ? (
                <div
                  data-testid="logs-no-matches"
                  style={{ padding: "6px 10px", fontSize: 11, color: "var(--cc-muted)" }}
                >
                  No lines in the loaded tail match these filters.
                </div>
              ) : (
                rows
              )}
            </div>

            <div
              role="note"
              data-testid="logs-filter-scope-note"
              style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 8 }}
            >
              Both filters apply to the <strong>loaded tail only</strong> — the{" "}
              {rawLines.length} newest lines fetched above, not the whole file. An empty result
              means the text is not in this tail; load more lines before concluding it is not in the
              log at all. Newest lines are at the bottom.
              {filtering && (
                <>
                  {" "}
                  While a level filter is active, lines with no recognisable level (tracebacks and
                  continuation lines) are hidden — switch back to <em>All levels</em> to see them.
                </>
              )}
            </div>
          </>
        )}

        <div
          role="note"
          data-testid="logs-redaction-note"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--cc-muted)",
            paddingTop: 8,
          }}
        >
          <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <span>
            Cockpit&apos;s server redacts key-shaped strings (Anthropic and OpenRouter keys, and{" "}
            <code>Bearer</code> tokens) before these lines reach this page, so a screenshot of this
            view will not leak them. It cannot redact a secret that was never key-shaped — file
            paths, project names and prompts appear verbatim.
          </span>
        </div>

        {revealError && (
          <Callout token="var(--cc-error)" testId="logs-reveal-error" alert>
            {revealError}
          </Callout>
        )}
      </div>
    </div>
  );
}
