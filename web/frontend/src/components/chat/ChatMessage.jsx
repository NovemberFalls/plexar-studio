/**
 * One message, with inline artifact rendering.
 *
 * DEPENDENCY-FREE ON PURPOSE. Cockpit ships no markdown or spreadsheet
 * renderer today, and `xlsx` + arbitrary HTML are the two open decisions in
 * backlog/10 §A. Rather than pull in a parser to pre-empt those, this renders
 * what can be rendered SAFELY with no new dependency and is explicit about the
 * rest.
 *
 * HTML IS NOT EXECUTED. A model-authored `html` block rendered into the app's
 * own origin would be script execution against the user's session — a security
 * decision, not a styling one. Until that is decided it renders as source,
 * which is honest and inert. `dangerouslySetInnerHTML` must not appear here.
 *
 * CSV gets a real table because it is trivially safe to parse and it is the
 * format most likely to be pasted in bulk.
 */

import { useState } from "react";
import { Table, Code, FileText } from "lucide-react";

/** Split content into text and fenced-code segments. */
function segment(content) {
  const out = [];
  const fence = /```([\w.+-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(content)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: content.slice(last, m.index) });
    out.push({ kind: "code", lang: (m[1] || "").toLowerCase(), text: m[2] });
    last = fence.lastIndex;
  }
  if (last < content.length) out.push({ kind: "text", text: content.slice(last) });
  return out;
}

/**
 * A deliberately small CSV split: handles quoted fields and embedded commas,
 * which is where a naive `split(",")` mangles real data.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

const MAX_TABLE_ROWS = 200;

function CsvTable({ text }) {
  const rows = parseCsv(text);
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  const shown = body.slice(0, MAX_TABLE_ROWS);
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: "100%" }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={{ ...cell, fontWeight: 700, color: "var(--cc-fg)", textAlign: "left" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {head.map((_, j) => (
                <td key={j} style={cell}>{r[j] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        // Say what was dropped. A silently truncated table reads as the whole
        // dataset, which is how someone draws a conclusion from half of it.
        <div style={{ fontSize: 10, color: "var(--cc-waiting)", padding: "4px 2px" }}>
          Showing {shown.length} of {body.length} rows.
        </div>
      )}
    </div>
  );
}

function Block({ seg }) {
  const [asTable, setAsTable] = useState(true);
  if (seg.kind === "text") {
    // Plain text, whitespace preserved — a paste keeps its shape.
    return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{seg.text}</div>;
  }

  const isCsv = seg.lang === "csv";
  const isHtml = seg.lang === "html";
  const Icon = isCsv ? Table : isHtml ? FileText : Code;

  return (
    <div style={{ ...artifact, marginBlock: 8 }}>
      <div style={artifactBar}>
        <Icon size={11} />
        <span style={{ flex: 1 }}>{seg.lang || "text"}</span>
        {isCsv && (
          <button onClick={() => setAsTable((v) => !v)} style={toggle}>
            {asTable ? "source" : "table"}
          </button>
        )}
      </div>
      {isHtml && (
        // Not a styling choice: rendering model-authored HTML into this origin
        // is script execution against the user's session.
        <div style={{ fontSize: 10, color: "var(--cc-waiting)", padding: "5px 9px" }}>
          Shown as source. HTML is never executed here.
        </div>
      )}
      {isCsv && asTable ? (
        <div style={{ padding: "6px 9px" }}><CsvTable text={seg.text} /></div>
      ) : (
        <pre style={pre}>{seg.text}</pre>
      )}
    </div>
  );
}

export default function ChatMessage({ message }) {
  const mine = message.role === "user";
  const segs = segment(message.content || "");
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 9, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase",
        color: mine ? "var(--cc-accent)" : "var(--cc-muted)", marginBottom: 3,
      }}>
        {message.role}
      </div>
      <div style={{
        fontSize: 12, lineHeight: 1.6, color: "var(--cc-fg)",
        borderLeft: `2px solid ${mine ? "var(--cc-accent)" : "var(--cc-border)"}`,
        paddingLeft: 10,
      }}>
        {segs.map((s, i) => <Block key={i} seg={s} />)}
      </div>
    </div>
  );
}

const cell = {
  border: "1px solid var(--cc-line)", padding: "3px 7px",
  color: "var(--cc-dim)", whiteSpace: "nowrap",
};
const artifact = {
  border: "1px solid var(--cc-border)", borderRadius: 8, overflow: "hidden",
  background: "var(--cc-bg)",
};
const artifactBar = {
  display: "flex", alignItems: "center", gap: 6, padding: "4px 9px",
  borderBottom: "1px solid var(--cc-border)", fontSize: 9, fontWeight: 700,
  letterSpacing: ".06em", textTransform: "uppercase", color: "var(--cc-muted)",
};
const toggle = {
  fontSize: 9, padding: "1px 6px", borderRadius: 5, cursor: "pointer",
  border: "1px solid var(--cc-border)", background: "transparent", color: "var(--cc-dim)",
};
const pre = {
  margin: 0, padding: "8px 9px", overflowX: "auto", fontSize: 11,
  lineHeight: 1.5, color: "var(--cc-dim)", whiteSpace: "pre",
};
