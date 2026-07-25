/**
 * RoutingTimeline — "Where the work went · per hour" card (SPEC #5).
 *
 * Stacked per-bucket bars from data.timeseries.buckets, segments bottom-up:
 * local backend(s) first (so the local/remote boundary reads as one line),
 * then spilled, then API direct. Degrades gracefully when timeseries isn't
 * populated yet (backend prerequisite not shipped) or has <1 bucket.
 */
import { fmtInt, seriesColor } from "./format";

function CardHeader({ title, right }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        padding: "11px 16px 9px",
        borderBottom: "1px solid var(--cc-border)",
      }}
    >
      <div
        className="text-[11px] uppercase"
        style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)" }}
      >
        {title}
      </div>
      {right != null && (
        <div style={{ fontSize: 10, color: "var(--cc-muted)" }}>{right}</div>
      )}
    </div>
  );
}

// Providers considered "local" for stacking purposes: any by_provider key
// that isn't one of the reserved role names.
const RESERVED_KEYS = new Set(["spill", "spilled", "api", "anthropic", "anthropic-api"]);

function bucketLocalKeys(buckets) {
  const keys = new Set();
  for (const b of buckets || []) {
    const byProvider = b?.by_provider || {};
    for (const k of Object.keys(byProvider)) {
      if (!RESERVED_KEYS.has(String(k).toLowerCase())) keys.add(k);
    }
  }
  return Array.from(keys);
}

function bucketValue(bucket, key) {
  const row = bucket?.by_provider?.[key];
  return typeof row?.runs === "number" && isFinite(row.runs) ? row.runs : 0;
}

function spilledValue(bucket) {
  // Sum any reserved "spilled"-shaped entries, or a bucket-level field.
  if (typeof bucket?.spilled === "number") return bucket.spilled;
  let sum = 0;
  const byProvider = bucket?.by_provider || {};
  for (const k of Object.keys(byProvider)) {
    if (["spill", "spilled"].includes(String(k).toLowerCase())) {
      sum += byProvider[k]?.runs || 0;
    }
    if (typeof byProvider[k]?.spilled === "number") sum += byProvider[k].spilled;
  }
  return sum;
}

function apiDirectValue(bucket) {
  const byProvider = bucket?.by_provider || {};
  for (const k of Object.keys(byProvider)) {
    if (["api", "anthropic", "anthropic-api"].includes(String(k).toLowerCase())) {
      return byProvider[k]?.runs || 0;
    }
  }
  return 0;
}

function fmtTs(ts) {
  if (typeof ts !== "number" && typeof ts !== "string") return "—";
  const d = new Date(typeof ts === "number" ? ts * (ts < 1e12 ? 1000 : 1) : ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

// eslint-disable-next-line no-unused-vars -- actions kept for prop-contract parity; no interactions in v1
export default function RoutingTimeline({ data, view, actions }) {
  const timeseries = data?.timeseries;
  const offline = !timeseries || timeseries.reachable === false;
  const buckets = Array.isArray(timeseries?.buckets) ? timeseries.buckets : [];
  const hidden = view?.hiddenBackends || {};

  const localKeys = bucketLocalKeys(buckets).filter((k) => !hidden[k]);
  const showSpilled = !hidden.spilled && !hidden.spill;
  const showApi = !hidden.api;

  const segments = [
    ...localKeys.map((k, i) => ({ id: k, label: k, color: seriesColor(k, i), get: (b) => bucketValue(b, k) })),
    ...(showSpilled ? [{ id: "spilled", label: "spilled → API", color: seriesColor("spilled"), get: spilledValue }] : []),
    ...(showApi ? [{ id: "api", label: "API direct", color: seriesColor("api"), get: apiDirectValue }] : []),
  ];

  const totals = buckets.map((b) => segments.reduce((sum, s) => sum + (s.get(b) || 0), 0));
  const maxTotal = Math.max(1, ...totals);

  const footerTotals = segments.map((s) => {
    const count = buckets.reduce((sum, b) => sum + (s.get(b) || 0), 0);
    return { ...s, count };
  });
  const grandTotal = footerTotals.reduce((sum, s) => sum + s.count, 0) || 1;

  return (
    <div
      style={{
        border: "1px solid var(--cc-border)",
        borderRadius: 12,
        background: "var(--cc-surface)",
        overflow: "hidden",
      }}
    >
      <CardHeader
        title="Where the work went · per hour"
        right={
          segments.length > 0 ? (
            <div style={{ display: "flex", gap: 14 }}>
              {segments.map((s) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: s.color,
                      display: "inline-block",
                    }}
                  />
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          ) : null
        }
      />

      {offline ? (
        <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "14px 16px" }}>
          Broker offline — no routing data for this window.
        </div>
      ) : buckets.length === 0 || segments.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "14px 16px" }}>
          No routing data for this window yet.
        </div>
      ) : (
        <>
          <div
            style={{ padding: "14px 16px 10px" }}
            role="img"
            aria-label={`Routing timeline over ${buckets.length} buckets, ${segments
              .map((s) => s.label)
              .join(", ")}`}
          >
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 132 }}>
              {buckets.map((b, bi) => {
                const total = totals[bi];
                const parts = segments.map((s) => ({ ...s, val: s.get(b) || 0 }));
                const titleParts = parts.map((p) => `${p.label} ${fmtInt(p.val)}`).join(", ");
                return (
                  <div
                    key={b?.ts ?? bi}
                    title={`${fmtTs(b?.ts)} · ${fmtInt(total)} runs — ${titleParts}`}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-end",
                      gap: 1,
                      height: "100%",
                    }}
                  >
                    {/* Render bottom-up: reverse so local backends land at the bottom in the DOM's visual stack (flex-direction column, justify flex-end). */}
                    {[...parts].reverse().map((p, pi) => {
                      const heightPct = (p.val / maxTotal) * 100;
                      const isTop = pi === 0;
                      const isBottom = pi === parts.length - 1;
                      return (
                        <div
                          key={p.id}
                          style={{
                            height: `${heightPct}%`,
                            background: p.color,
                            borderRadius: `${isTop ? "2px 2px" : "0 0"} ${isBottom ? "2px 2px" : "0 0"}`,
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              {(() => {
                const n = Math.min(5, buckets.length);
                if (n === 0) return null;
                const idxs = Array.from({ length: n }, (_, i) =>
                  Math.round((i * (buckets.length - 1)) / Math.max(1, n - 1)),
                );
                return idxs.map((idx, i) => (
                  <span
                    key={idx + "-" + i}
                    className="tabular-nums"
                    style={{ fontSize: 9.5, color: "var(--cc-muted)" }}
                  >
                    {fmtTs(buckets[idx]?.ts)}
                  </span>
                ));
              })()}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${footerTotals.length}, 1fr)`,
              borderTop: "1px solid var(--cc-line)",
            }}
          >
            {footerTotals.map((s, i) => {
              const share = grandTotal > 0 ? (s.count / grandTotal) * 100 : 0;
              return (
                <div
                  key={s.id}
                  style={{
                    padding: "10px 16px",
                    borderRight: i === footerTotals.length - 1 ? "none" : "1px solid var(--cc-line)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: s.color,
                        display: "inline-block",
                      }}
                    />
                    <span style={{ fontSize: 10.5, color: "var(--cc-dim)" }}>{s.label}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
                    <span
                      className="tabular-nums"
                      style={{ fontSize: 17, fontWeight: 700, color: "var(--cc-fg)" }}
                    >
                      {fmtInt(s.count)}
                    </span>
                    <span
                      className="tabular-nums"
                      style={{ fontSize: 11, color: "var(--cc-muted)" }}
                    >
                      {fmtInt(Math.round(share))}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
