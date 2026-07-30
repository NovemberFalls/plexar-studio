/**
 * TokensByDayChart — "Tokens per day, by class" (spec §8, card 2).
 *
 * A CSS stacked column chart: one column per `by_day` entry, five stacked
 * segments (input / output / cache read / cache write / local). No charting
 * library, no image — plain divs sized in px against the tallest day.
 *
 * `by_day` is gap-filled by the server, so idle days arrive as rows of zeros
 * and MUST still be drawn and labelled — a missing column would read as "no
 * such day" instead of "nothing happened that day". A zero day therefore
 * renders its label and a baseline rule with no segments above it. A one-day
 * range is the same code path with a single column.
 */

import { DAY_SERIES, dayLabel, dayTotal, fmtCost, fmtCount, num } from "./format.js";

const PLOT_H = 150; // px of drawable column height
const MIN_SEGMENT_H = 2; // a nonzero class stays visible even when tiny

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  overflow: "hidden",
  minWidth: 0,
};

function Legend() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {DAY_SERIES.map((s) => (
        <span
          key={s.key}
          data-testid={`legend-${s.key}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--cc-muted)" }}
        >
          <span
            aria-hidden="true"
            style={{ width: 8, height: 8, borderRadius: 4, background: s.color, flexShrink: 0 }}
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function DayColumn({ day, max }) {
  const total = dayTotal(day);
  const isZero = !total; // covers 0 and null alike — both draw as an empty column
  const segments = DAY_SERIES.map((s) => {
    const v = num(day?.[s.key]) ?? 0;
    const h = max > 0 && v > 0 ? Math.max(MIN_SEGMENT_H, (v / max) * PLOT_H) : 0;
    return { ...s, value: v, height: h };
  }).filter((s) => s.height > 0);

  const label = dayLabel(day?.day);
  const title = `${label}: ${fmtCount(total, "no tokens")} tokens · ${fmtCost(day?.cost, "cost not reported")}`;

  return (
    <div
      data-testid={`day-col-${day?.day || label}`}
      data-zero={isZero ? "true" : "false"}
      role="group"
      aria-label={title}
      title={title}
      style={{
        flex: "1 1 0",
        minWidth: 22,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 4,
        minHeight: 0,
      }}
    >
      <div
        className="tabular-nums"
        style={{
          fontSize: 9,
          fontWeight: 700,
          textAlign: "center",
          color: isZero ? "var(--cc-muted)" : "var(--cc-dim)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {fmtCount(total, "0")}
      </div>
      <div
        style={{
          height: PLOT_H,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          borderBottom: "1px solid var(--cc-line)",
        }}
      >
        {/* Stack renders top-down in visual terms, so reverse the series order
            to keep `input` sitting on the baseline. */}
        {segments
          .slice()
          .reverse()
          .map((s) => (
            <div
              key={s.key}
              data-testid={`seg-${day?.day || label}-${s.key}`}
              style={{ height: s.height, background: s.color, flexShrink: 0 }}
            />
          ))}
      </div>
      <div
        style={{
          fontSize: 9,
          textAlign: "center",
          color: "var(--cc-muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
    </div>
  );
}

export default function TokensByDayChart({ byDay, note }) {
  const days = Array.isArray(byDay) ? byDay : [];
  const max = days.reduce((acc, d) => Math.max(acc, dayTotal(d) ?? 0), 0);

  return (
    <div style={CARD} data-testid="tokens-by-day">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "var(--cc-dim)",
          }}
        >
          Tokens per day, by class
        </span>
        <Legend />
      </div>

      <div style={{ padding: "14px 16px 12px" }}>
        {days.length === 0 ? (
          <div
            style={{
              height: PLOT_H,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "var(--cc-muted)",
            }}
          >
            No days in this range.
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, minWidth: 0 }}>
            {days.map((d, i) => (
              <DayColumn key={d?.day || i} day={d} max={max} />
            ))}
          </div>
        )}
        {note ? (
          <div
            role="note"
            style={{ fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.5, marginTop: 10 }}
          >
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}
