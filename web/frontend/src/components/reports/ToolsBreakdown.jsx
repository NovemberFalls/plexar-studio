/**
 * ToolsBreakdown — the Reports ▸ Tools tab, built from `by_tool`.
 *
 * Deliberately the same shape as SpendByModel (labelled row, value, share, one
 * bar, a footer note) so the two tabs read as one system rather than as two
 * people's work. The bar is scaled against the largest row's call count, not
 * against the share, so a long tail is still visible.
 *
 * `by_tool` arrives sorted by calls descending, and that order is preserved —
 * re-sorting client-side would silently disagree with the server on ties.
 *
 * The card owns no honesty note of its own: coverage is a property of the RANGE,
 * not of any one tool, so the caller passes the same note ReportsView renders on
 * Overview. Rendering it in both places is intentional — the Tools tab is
 * reachable directly and must not be the one screen that omits the caveat.
 */

import { fmtCount, fmtPct } from "./format.js";

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  minWidth: 0,
  // THE FOURTH DEFECT ON THIS PANEL (owner, twice: "MCP_Branchive_repo_file ...
  // collided with 'ool calls have only been recorded'").
  //
  // ReportsView's body is a COLUMN FLEX BOX that scrolls. A flex item defaults
  // to `flex-shrink: 1`, so this card was being COMPRESSED to the viewport
  // instead of overflowing it and being scrolled to. Compressed, the rows
  // region (which carried `minHeight: 0`, i.e. "you may collapse below your
  // content") did exactly that, its rows overflowed their box, and because the
  // footer note is a LATER SIBLING in the same stacking context the note
  // painted on top of the last row. The longest tool name is bottom-most, so
  // the collision is worst exactly where he saw it.
  //
  // The three earlier fixes here were defects OF A ROW (the bar clamp, the
  // fabricated 0.0%, the 30 repeated captions). This is a defect OF THE BOX,
  // which is why none of them touched it, and it is invisible to a short
  // fixture -- five rows fit, so nothing is ever compressed. Do not remove
  // this line; `ToolsBreakdown.footerCollision.test.jsx` fails if you do.
  flexShrink: 0,
};

function ToolBar({ row, maxCalls }) {
  const name = row?.tool_name || "unknown tool";
  const calls = typeof row?.calls === "number" && Number.isFinite(row.calls) ? row.calls : null;
  // MEASURED 2026-08-03 on the live 7d report: 30 tools, 3679 calls down to 1.
  // The old `Math.max(1, ...)` floor put every row below ~1% of the leader --
  // 23 of the 30 -- on the SAME 1% stub, so the whole bottom of the card drew
  // as a column of identical ticks claiming figures that differ 37-fold are
  // equal. A floor that lies is worse than a bar too small to see.
  //
  // So: no floor. A genuinely tiny share draws as a hairline, which is the
  // truth, and `minWidth: 1px` in the style keeps it from vanishing entirely
  // without overstating its size.
  const width = maxCalls > 0 && calls !== null ? (calls / maxCalls) * 100 : 0;

  return (
    <div data-testid={`tool-row-${name}`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--cc-fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
          title={name}
        >
          {name}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="tabular-nums"
          style={{ fontSize: 11, fontWeight: 700, color: "var(--cc-fg)", flexShrink: 0 }}
        >
          {fmtCount(calls, "—")}
        </span>
        <span
          className="tabular-nums"
          style={{ fontSize: 10, color: "var(--cc-muted)", flexShrink: 0, minWidth: 42, textAlign: "right" }}
        >
          {fmtPct(row?.share, "—")}
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 5,
          background: "color-mix(in srgb, var(--cc-fg) 6%, transparent)",
          overflow: "hidden",
        }}
      >
        <div
          data-testid={`tool-bar-${name}`}
          style={{
            width: `${width}%`,
            minWidth: calls ? 1 : 0,
            height: "100%",
            background: "var(--cc-accent)",
            borderRadius: 5,
          }}
        />
      </div>
      {/* The per-row sentence that used to sit here -- "N calls of the tool
          calls in this range" -- is GONE. It was ungrammatical, it restated
          the count and the share already on the row, and repeating it under
          all 30 rows at 9px is what turned the bottom of this card into
          noise. The card's header already scopes everything to the range. */}
    </div>
  );
}

export default function ToolsBreakdown({ byTool, note }) {
  const rows = Array.isArray(byTool) ? byTool : [];
  const maxCalls = rows.reduce(
    (acc, r) => (typeof r?.calls === "number" && Number.isFinite(r.calls) ? Math.max(acc, r.calls) : acc),
    0
  );
  const total = rows.reduce(
    (acc, r) => acc + (typeof r?.calls === "number" && Number.isFinite(r.calls) ? r.calls : 0),
    0
  );

  return (
    <div style={{ ...CARD, maxWidth: 640 }} data-testid="tools-breakdown">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
          flexShrink: 0,
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
          Which tools ran
        </span>
        <span className="tabular-nums" style={{ fontSize: 10, color: "var(--cc-muted)" }}>
          {rows.length === 0
            ? "no tools"
            : `${fmtCount(rows.length)} ${rows.length === 1 ? "tool" : "tools"} · ${fmtCount(total)} calls`}
        </span>
      </div>

      <div
        data-testid="tools-rows"
        style={{
          // `minHeight: 0` USED TO BE HERE and it is half of the collision
          // above: it is the instruction that permits this box to collapse
          // below its 30 rows. The list is not independently scrollable -- the
          // Reports body scrolls -- so this region must simply be as tall as
          // its content and push the footer note down.
          flexShrink: 0,
          padding: "12px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {rows.length === 0 ? (
          <div data-testid="tools-empty" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)" }}>
            No tool calls in this range.
          </div>
        ) : (
          rows.map((r, i) => <ToolBar key={r?.tool_name || i} row={r} maxCalls={maxCalls} />)
        )}
      </div>

      {note ? (
        <div
          role="note"
          data-testid="tools-coverage-note"
          style={{
            flexShrink: 0,
            padding: "9px 16px",
            borderTop: "1px solid var(--cc-line)",
            fontSize: 10,
            lineHeight: 1.5,
            color: "var(--cc-muted)",
          }}
        >
          {note}
        </div>
      ) : null}
    </div>
  );
}
