/**
 * One message, with inline artifact rendering.
 *
 * MARKDOWN IS RENDERED (2026-08-03); SPREADSHEETS AND RAW HTML STILL ARE NOT.
 * This file said "dependency-free on purpose" until a user reported replies
 * arriving as literal `**bold**` and raw pipe tables -- correct content in
 * source-code form, on the surface read most. `react-markdown` + `remark-gfm`
 * now render the prose between fences.
 *
 * THE DEPENDENCY WAS CHOSEN FOR SECURITY, NOT CONVENIENCE, and it is the same
 * reasoning the HTML paragraph below already applies: react-markdown builds
 * React ELEMENTS and never sets raw HTML, so model output cannot become markup.
 * A hand-rolled renderer ends in string interpolation, and the first person who
 * needs a table reaches for `dangerouslySetInnerHTML`. NO raw-HTML plugin is
 * permitted -- no `rehype-raw`, no `allowDangerousHtml` -- and a test fails if
 * either ever appears.
 *
 * `xlsx` remains an open decision in backlog/10 §A and is unchanged by this.
 *
 * HTML IS NOT EXECUTED. A model-authored `html` block rendered into the app's
 * own origin would be script execution against the user's session — a security
 * decision, not a styling one. Until that is decided it renders as source,
 * which is honest and inert. `dangerouslySetInnerHTML` must not appear here.
 *
 * CSV gets a real table because it is trivially safe to parse and it is the
 * format most likely to be pasted in bulk.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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

function Block({ seg, markdown }) {
  const [asTable, setAsTable] = useState(true);
  if (seg.kind === "text") {
    // MARKDOWN, not plain text. Until 2026-08-03 this returned `seg.text`
    // verbatim, so a reply came through as literal `**bold**` and a raw pipe
    // table -- correct content, source-code presentation, on the surface a user
    // reads most. `segment()` still owns fenced code above; this handles
    // everything between the fences.
    //
    // WHY react-markdown AND NOT A HAND-ROLLED RENDERER, and the reason is
    // security rather than convenience: this renders MODEL OUTPUT inside a
    // desktop app. react-markdown builds React ELEMENTS and never sets raw
    // HTML, so model text cannot become markup. A hand-rolled renderer ends in
    // string interpolation, and the first person who needs a table reaches for
    // `dangerouslySetInnerHTML` -- at which point model output is script
    // execution in an Electron-class context. That door is closed by
    // CONSTRUCTION here, not by everyone remembering.
    //
    // NO RAW-HTML PLUGIN, EVER. No `rehype-raw`, no `allowDangerousHtml`. A
    // test fails if either appears anywhere in the tree; the whole value of
    // "builds elements, never sets HTML" is that nobody adds an exception.
    // MARKDOWN FOR THE ASSISTANT, VERBATIM FOR THE USER -- a deliberate split,
    // not an oversight, and it resolves a real conflict rather than papering
    // over it. Markdown COLLAPSES indentation by design, which broke the
    // existing guarantee that "a paste keeps its shape" (a tested behaviour,
    // and the reason someone pastes a log or a stack trace into chat at all).
    // The user's own words are reproduced exactly; the model's output is
    // formatted. Applying markdown to both would have silently reflowed the
    // thing the user was asking about.
    if (!markdown) {
      return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{seg.text}</div>;
    }
    return (
      <div className="chat-md" style={{ wordBreak: "break-word" }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
      </div>
    );
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
          <button className="hover-bg-elevated" onClick={() => setAsTable((v) => !v)} style={toggle}>
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
        {segs.map((s, i) => <Block key={i} seg={s} markdown={!mine} />)}
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
