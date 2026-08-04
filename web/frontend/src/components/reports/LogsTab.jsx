/**
 * Reports ▸ Logs — S26.
 *
 * THIS TAB USED TO SAY SOMETHING FALSE, AND THAT IS THE WHOLE FINDING.
 *
 * As Engine ▸ Logs it rendered an "honest empty state" whose first sentence was
 * *"Plexar Studio exposes no log endpoint, so there is nothing to stream into
 * this tab."* MEASURED 2026-08-03: that is not true and has not been true for
 * some time. `GET /api/logs?lines=N` exists in server.py, tails the rotating
 * file backwards in 64 KiB blocks, and REDACTS secrets on the way out. A full
 * viewer for it already ships in Settings ▸ Diagnostics.
 *
 * So the earlier reading of this row — "the lines exist and need a route" — was
 * itself wrong, and wrong in the expensive direction: the route existed too.
 * What was missing was a CONSUMER. The panel was not an honest empty state, it
 * was a confident denial of a shipped capability — the same defect class as
 * S-TRACES' pointer-to-a-tab-that-never-existed, inverted. An empty state is
 * only honest if the reason it gives is true.
 *
 * ⚠ OPEN, AND NOT DECIDED HERE: Settings ▸ Diagnostics renders this same data
 * with level controls and a reveal button. Two doors to one room is exactly what
 * S26 exists to remove, so which surface should OWN the log tail is a real
 * question — raised as ASK-STUDIO-LOGHOME rather than settled unilaterally,
 * because deleting a Settings pane Len uses is not a consolidation side effect.
 * Nothing is deleted here.
 */
import { useCallback, useEffect, useState } from "react";
import { ScrollText, RefreshCw } from "lucide-react";

import { Card, CardTitle, Btn, Note } from "../engine/ui.jsx";

const LINES = 300;

/** Where lines DO NOT come from. Kept from the old empty state, because the
 *  HTTP tail carries Plexar Studio's own loggers and the in-process broker but
 *  NOT vLLM, which logs inside its container. Dropping this would imply the
 *  tail is everything. */
const NOT_IN_THIS_TAIL = [
  {
    what: "vLLM",
    where:
      "the container's own log — `docker logs` on the managed vLLM container. It is a separate process with a separate sink, and none of it reaches this file.",
  },
];

/** Colour the level token so a stack of ERROR lines is findable by eye. */
function levelToken(line) {
  if (/\[(ERROR|CRITICAL)\]/.test(line)) return "var(--cc-error, #f87171)";
  if (/\[WARNING\]/.test(line)) return "var(--cc-waiting)";
  if (/\[DEBUG\]/.test(line)) return "var(--cc-muted)";
  return "var(--cc-dim)";
}

export default function LogsTab() {
  // `undefined` = not read yet, `null` = asked and could not read, [] = read and
  // the file is genuinely empty. Three states, never collapsed — an unreadable
  // log and a quiet one look identical on screen otherwise.
  const [state, setState] = useState({ lines: undefined, path: null, size: 0, fileLogging: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/logs?lines=${LINES}`);
      if (!r.ok) {
        setState((p) => ({ ...p, lines: null }));
        return;
      }
      const b = await r.json();
      setState({
        lines: Array.isArray(b.lines) ? b.lines : null,
        path: b.path || null,
        size: b.size_bytes || 0,
        fileLogging: b.file_logging !== false,
      });
    } catch {
      setState((p) => ({ ...p, lines: null }));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { lines } = state;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <Card
        testId="engine-logs-card"
        title={<CardTitle icon={ScrollText} token="var(--cc-dim)">Server log</CardTitle>}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {state.size > 0 && (
              <span style={{ fontSize: 10, color: "var(--cc-dim)" }}>
                {`${(state.size / 1024).toFixed(0)} KB on disk`}
              </span>
            )}
            <Btn
              label={busy ? "Reading…" : "Refresh"}
              icon={RefreshCw}
              disabled={busy}
              onClick={load}
              testId="logs-refresh"
            />
          </div>
        }
      >
        {lines === undefined ? (
          <Note testId="logs-loading">Reading the log file…</Note>
        ) : lines === null ? (
          <Note testId="logs-unreadable">
            The log file could not be read. That is &ldquo;unknown&rdquo;, not &ldquo;nothing was
            logged&rdquo; — the server may be writing to stderr only.
          </Note>
        ) : lines.length === 0 ? (
          <Note testId="logs-empty">
            The log file exists and is empty. Nothing has been logged at the current level yet — set a
            lower level in Settings ▸ Diagnostics if you expected lines here.
          </Note>
        ) : (
          <div
            data-testid="logs-tail"
            style={{
              maxHeight: 460,
              overflow: "auto",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 10.5,
              lineHeight: 1.55,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--cc-line, var(--cc-border))",
              background: "color-mix(in srgb, var(--cc-surface) 55%, transparent)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {lines.map((l, i) => (
              <div key={i} style={{ color: levelToken(l) }}>
                {l}
              </div>
            ))}
          </div>
        )}

        {state.path && (
          <Note testId="logs-path">
            {`Tailing the last ${LINES} lines of ${state.path}. Secrets are redacted server-side, before the lines leave the process.`}
          </Note>
        )}

        {!state.fileLogging && (
          <Note testId="logs-nofile">
            File logging is not active — the log directory could not be opened, so the server is
            writing to stderr only, and this tail will stay empty however much happens.
          </Note>
        )}

        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {NOT_IN_THIS_TAIL.map((row) => (
            <li key={row.what} style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", marginTop: 4 }}>
              <span style={{ fontWeight: 700, color: "var(--cc-fg)" }}>{`Not in this tail — ${row.what}`}</span>
              {` — ${row.where}`}
            </li>
          ))}
        </ul>

        <Note testId="engine-logs-note">
          These are real lines read from disk. Nothing here is sampled or synthesised: a fabricated
          log is indistinguishable from a real one, and you would debug against it.
        </Note>
      </Card>
    </div>
  );
}
