/**
 * SessionsTable — "Sessions in this range" (spec §8, card 4). 34px rows,
 * --cc-line separators, and a sticky footer on --cc-bg2 carrying the column
 * sums. Rows are clickable and call `onOpenTrace(terminal_id)`.
 *
 * Two honesty rules are load-bearing here:
 *  - a null cell is an em dash, never 0 (see reports/format.js);
 *  - a footer sum only counts the rows that actually reported the field. When
 *    some rows are missing it, the cell says so in its title rather than
 *    presenting a partial total as complete.
 *
 * The state dot describes whether the session is open in Cockpit RIGHT NOW,
 * which is separate from the historical row: usage rows outlive their
 * terminals, so an unknown state is drawn muted and titled as unknown instead
 * of being guessed at.
 */

import { DASH, fmtCost, fmtCount, num, sessionLabel, sumColumn } from "./format.js";

const ROW_H = 34;

/** Session status → dot token. Anything unrecognised is "not open right now". */
const STATE_TOKEN = {
  idle: "var(--cc-idle)",
  busy: "var(--cc-working)",
  waiting: "var(--cc-waiting)",
  starting: "var(--cc-thinking)",
  error: "var(--cc-error)",
};

const TH = {
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: "var(--cc-muted)",
  padding: "0 10px",
  height: 28,
  textAlign: "right",
  whiteSpace: "nowrap",
  background: "var(--cc-surface)",
};

const TD = {
  fontSize: 11,
  color: "var(--cc-fg)",
  padding: "0 10px",
  height: ROW_H,
  textAlign: "right",
  whiteSpace: "nowrap",
  borderTop: "1px solid var(--cc-line)",
};

const TF = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--cc-fg)",
  padding: "0 10px",
  height: ROW_H,
  textAlign: "right",
  whiteSpace: "nowrap",
  background: "var(--cc-bg2)",
  borderTop: "1px solid var(--cc-border)",
};

const NUM_COLUMNS = [
  ["input", "Input"],
  ["output", "Output"],
];

function StateDot({ status }) {
  const known = typeof status === "string" && STATE_TOKEN[status];
  const token = known || "var(--cc-muted)";
  return (
    <span
      aria-hidden="true"
      title={known ? `session is ${status}` : "not open in Cockpit right now"}
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: token,
        flexShrink: 0,
        opacity: known ? 1 : 0.55,
      }}
    />
  );
}

/** "1,024 / 96" — the paired cache read/write cell. */
function cacheCell(row) {
  const r = num(row?.cache_read);
  const w = num(row?.cache_write);
  if (r === null && w === null) return DASH;
  return `${r === null ? DASH : fmtCount(r, DASH)} / ${w === null ? DASH : fmtCount(w, DASH)}`;
}

function SessionRow({ row, status, onOpenTrace, showLocal }) {
  const id = row?.terminal_id || "";
  const name = sessionLabel(row);
  const clickable = typeof onOpenTrace === "function" && id.length > 0;
  const open = () => {
    if (clickable) onOpenTrace(id);
  };

  return (
    <tr
      data-testid={`session-row-${id || name}`}
      onClick={open}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? "button" : undefined}
      aria-label={clickable ? `Open trace for ${name}` : undefined}
      className={clickable ? "hover-bg-elevated" : undefined}
      style={{ cursor: clickable ? "pointer" : "default" }}
    >
      <td style={{ ...TD, textAlign: "left", maxWidth: 260 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <StateDot status={status} />
          <span
            style={{
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {name}
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--cc-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
            title={row?.project || undefined}
          >
            {row?.project || DASH}
          </span>
        </span>
      </td>
      <td style={{ ...TD, textAlign: "left", color: "var(--cc-dim)", maxWidth: 170 }}>
        <span
          style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={row?.model || undefined}
        >
          {row?.model || DASH}
        </span>
      </td>
      {NUM_COLUMNS.map(([key]) => (
        <td key={key} className="tabular-nums" style={TD}>
          {fmtCount(row?.[key], DASH)}
        </td>
      ))}
      <td className="tabular-nums" style={{ ...TD, color: "var(--cc-dim)" }}>
        {cacheCell(row)}
      </td>
      {showLocal ? (
        <td className="tabular-nums" style={{ ...TD, color: "var(--cc-idle)" }}>
          {fmtCount(row?.local, DASH)}
        </td>
      ) : null}
      <td className="tabular-nums" style={{ ...TD, fontWeight: 700 }}>
        {fmtCount(row?.total, DASH)}
      </td>
      <td className="tabular-nums" style={TD}>
        {fmtCount(row?.turns, DASH)}
      </td>
      <td className="tabular-nums" style={TD}>
        {fmtCost(row?.cost, DASH)}
      </td>
      <td className="tabular-nums" style={{ ...TD, color: "var(--cc-dim)" }}>
        {fmtCount(row?.tool_calls, DASH)}
      </td>
    </tr>
  );
}

/** Footer cell whose title admits when the sum excludes unreported rows. */
function FooterCell({ rows, column, format, testId, strong }) {
  const { value, missing } = sumColumn(rows, column);
  const title =
    missing > 0
      ? `${missing} of ${rows.length} sessions do not report ${column}; they are excluded from this total.`
      : undefined;
  return (
    <td
      className="tabular-nums"
      data-testid={testId}
      title={title}
      style={{ ...TF, fontWeight: strong ? 800 : 700, color: missing > 0 ? "var(--cc-dim)" : TF.color }}
    >
      {format(value)}
      {missing > 0 ? "*" : ""}
    </td>
  );
}

export default function SessionsTable({ rows, statusByTerminalId, onOpenTrace, title, showLocal }) {
  const list = Array.isArray(rows) ? rows : [];
  const statuses = statusByTerminalId && typeof statusByTerminalId === "object" ? statusByTerminalId : {};

  const cacheRead = sumColumn(list, "cache_read");
  const cacheWrite = sumColumn(list, "cache_write");

  // The Tools column is sourced now (sessions[].tool_calls is a real integer),
  // so there is no unsourced-column note here any more. Range-level coverage of
  // tool recording is stated once by ReportsView from `tool_events_since`
  // instead of being repeated per card.

  return (
    <div
      data-testid="sessions-table"
      style={{
        borderRadius: 12,
        background: "var(--cc-surface)",
        border: "1px solid var(--cc-border)",
        overflow: "hidden",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
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
          {title || "Sessions"}
        </span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
          {list.length === 1 ? "1 session" : `${list.length} sessions`}
        </span>
      </div>

      {list.length === 0 ? (
        <div style={{ padding: "16px", fontSize: 11, color: "var(--cc-muted)" }}>
          No sessions match the current range and filters.
        </div>
      ) : (
        <div style={{ maxHeight: 420, overflow: "auto", minWidth: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
            <thead>
              <tr>
                <th style={{ ...TH, textAlign: "left" }}>Session</th>
                <th style={{ ...TH, textAlign: "left" }}>Model</th>
                <th style={TH}>Input</th>
                <th style={TH}>Output</th>
                <th style={TH}>Cache r/w</th>
                {showLocal ? <th style={TH}>Local</th> : null}
                <th style={TH}>Total</th>
                <th style={TH}>Turns</th>
                <th style={TH}>Cost</th>
                <th style={TH}>Tools</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <SessionRow
                  key={r?.terminal_id || i}
                  row={r}
                  status={statuses[r?.terminal_id]}
                  onOpenTrace={onOpenTrace}
                  showLocal={showLocal}
                />
              ))}
            </tbody>
            <tfoot style={{ position: "sticky", bottom: 0 }}>
              <tr>
                <td style={{ ...TF, textAlign: "left", fontWeight: 800 }}>Total</td>
                <td style={{ ...TF, textAlign: "left", color: "var(--cc-muted)", fontWeight: 600 }}>
                  {list.length === 1 ? "1 session" : `${list.length} sessions`}
                </td>
                <FooterCell rows={list} column="input" format={(v) => fmtCount(v, DASH)} testId="sum-input" />
                <FooterCell rows={list} column="output" format={(v) => fmtCount(v, DASH)} testId="sum-output" />
                <td
                  className="tabular-nums"
                  data-testid="sum-cache"
                  style={{ ...TF, color: "var(--cc-dim)" }}
                >
                  {fmtCount(cacheRead.value, DASH)} / {fmtCount(cacheWrite.value, DASH)}
                </td>
                {showLocal ? (
                  <FooterCell rows={list} column="local" format={(v) => fmtCount(v, DASH)} testId="sum-local" />
                ) : null}
                <FooterCell rows={list} column="total" format={(v) => fmtCount(v, DASH)} testId="sum-total" strong />
                <FooterCell rows={list} column="turns" format={(v) => fmtCount(v, DASH)} testId="sum-turns" />
                <FooterCell rows={list} column="cost" format={(v) => fmtCost(v, DASH)} testId="sum-cost" />
                <FooterCell
                  rows={list}
                  column="tool_calls"
                  format={(v) => fmtCount(v, DASH)}
                  testId="sum-tools"
                />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
