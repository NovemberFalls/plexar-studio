import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge } from "lucide-react";

/**
 * Anthropic subscription limits — the 5-hour / weekly bars from `claude /status`.
 *
 * These are REAL server-reported percentages, not an estimate derived from
 * locally-tracked tokens. The backend (`/api/anthropic/usage`) either returns
 * true utilization or reports `available: false` with a reason; this component
 * renders the reason rather than an empty bar, because a 0% bar and "we could
 * not read your usage" look identical and mean opposite things.
 *
 * Owns its own poll. It is the only consumer of this endpoint, the payload is
 * tiny, and the server caches for 60s — so a shared store (as `/models` needs)
 * would be ceremony without a second reader to justify it.
 */

// 5 minutes. A 60s poll earned repeated HTTP 429s from Anthropic: this endpoint
// is built for a human running /status occasionally, not a poller. Utilization
// moves slowly enough that 5 minutes loses nothing, and opening the popover
// forces a fresh read anyway.
const POLL_MS = 300_000;

/** Bar colour by how close to the cap we are. Severity comes from the API. */
function toneFor(percent, severity) {
  if (severity === "critical" || percent >= 90) return "var(--cc-error, var(--error))";
  if (severity === "warning" || percent >= 75) return "var(--cc-waiting, var(--warning))";
  return "var(--cc-accent, var(--accent))";
}

/** "4h 12m" / "3d 2h" — how long until the window resets. */
function untilReset(resetsAt) {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

/** Local wall-clock time of the reset, matching how the CLI presents it. */
function resetClock(resetsAt) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function LimitBar({ limit }) {
  const pct = Math.max(0, Math.min(100, limit.percent));
  const tone = toneFor(pct, limit.severity);
  const remaining = untilReset(limit.resets_at);
  const clock = resetClock(limit.resets_at);

  return (
    <div style={{ padding: "9px 12px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <span style={{ fontSize: 12, color: "var(--cc-fg, var(--text-primary))", fontWeight: 600 }}>
          {limit.label}
        </span>
        <span style={{ fontSize: 12, color: tone, fontWeight: 700, whiteSpace: "nowrap" }}>
          {Math.round(limit.percent)}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${limit.label} usage`}
        aria-valuenow={Math.round(limit.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          borderRadius: 999,
          backgroundColor: "var(--bg-surface, rgba(127,127,127,.25))",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            backgroundColor: tone,
            borderRadius: 999,
            transition: "width .3s ease",
          }}
        />
      </div>
      {clock && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Resets {clock}
          {remaining ? ` · in ${remaining}` : ""}
        </div>
      )}
    </div>
  );
}

export default function UsageLimitsPill({ open, onToggle, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Held in a ref so the poll effect does not re-subscribe on every fetch.
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/anthropic/usage${force ? "?refresh=true" : ""}`);
      if (!res.ok) return;
      setData(await res.json());
    } catch {
      // Best-effort background read — a failed poll keeps the last known
      // state rather than blanking a panel the user may be reading.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Opening the popover is an explicit "show me now" — bypass the server cache.
  useEffect(() => {
    if (open) load(true);
  }, [open, load]);

  const limits = data?.available ? data.limits : [];
  // The pill shows the tightest constraint, since that is the one that will
  // actually stop work.
  const peak = limits.length ? Math.max(...limits.map((l) => l.percent)) : null;
  const peakSeverity =
    limits.find((l) => l.percent === peak)?.severity || "normal";

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="flex items-center transition-colors hover-bg-surface"
        style={{
          gap: 5,
          padding: peak === null ? 5 : "4px 9px",
          borderRadius: peak === null ? 7 : 999,
          color:
            peak === null
              ? "var(--cc-dim, var(--text-secondary))"
              : toneFor(peak, peakSeverity),
          border: peak === null ? "none" : "1px solid var(--border-color)",
        }}
        title="Claude subscription limits — session & weekly"
        aria-label="Claude subscription usage limits"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Gauge size={15} />
        {peak !== null && (
          <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>
            {Math.round(peak)}%
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
          <div
            role="dialog"
            aria-label="Claude subscription limits"
            className="absolute right-0 mt-1 rounded-lg z-50"
            style={{
              width: 300,
              maxHeight: "70vh",
              overflowY: "auto",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-color)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-color)",
              }}
            >
              <span
                className="text-[11px] uppercase tracking-wider"
                style={{ color: "var(--text-secondary)", fontWeight: 600 }}
              >
                Claude Limits
              </span>
            </div>

            {loading && !data ? (
              <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)" }}>
                Loading…
              </div>
            ) : data?.available && limits.length > 0 ? (
              <>
                {limits.map((limit) => (
                  <LimitBar key={limit.kind} limit={limit} />
                ))}
                {data.extra_usage && (
                  <div
                    style={{
                      padding: "8px 12px",
                      borderTop: "1px solid var(--border-color)",
                      fontSize: 11,
                      color: "var(--text-muted)",
                    }}
                  >
                    Extra usage enabled
                    {data.extra_usage.spend_limit_reached ? " · spend limit reached" : ""}
                  </div>
                )}
                <div
                  style={{
                    padding: "8px 12px",
                    borderTop: "1px solid var(--border-color)",
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  Reported by Anthropic for this account — the same figures as
                  <code style={{ margin: "0 3px" }}>/status</code>.
                </div>
              </>
            ) : (
              /* Never render an empty bar here: "we could not read your usage"
                 and "0% used" look identical and mean opposite things. */
              <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)" }}>
                {data?.detail || "Usage limits are unavailable."}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
