/**
 * EngineLogs — Engine ▸ Logs.
 *
 * THERE IS NO LOG ENDPOINT TODAY. Cockpit's server logs through the `cockpit.*`
 * loggers to its own stdout, and the engines (the lane broker in-process, vLLM in
 * its container) log to their own sinks. None of that is exposed over HTTP, so
 * this tab renders an honest empty state that names what will live here and
 * where the lines are right now.
 *
 * Rendering plausible-looking log lines here would be the single most damaging
 * thing this whole section could do: a fabricated log is indistinguishable from a
 * real one, and an operator would debug against it.
 */
import { ScrollText } from "lucide-react";

import { Card, CardTitle, Note } from "./ui.jsx";

const WHERE_TODAY = [
  {
    what: "Cockpit server",
    where: "the `cockpit.server`, `cockpit.pty`, and `cockpit.bridge` loggers, written to the server process's stdout (the terminal you launched it from, or the desktop app's sidecar output).",
  },
  {
    what: "Lane broker",
    where: "the same stdout — the managed broker runs in-process on Cockpit's event loop, so its lines are interleaved with Cockpit's.",
  },
  {
    what: "vLLM",
    where: "the container's own log: `docker logs` on the managed vLLM container.",
  },
];

export default function EngineLogs() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", minWidth: 0 }}>
      <Card
        testId="engine-logs-card"
        title={<CardTitle icon={ScrollText} token="var(--cc-dim)">Engine logs</CardTitle>}
      >
        <div
          data-testid="engine-logs-empty"
          style={{
            borderRadius: 12,
            border: "1px dashed var(--cc-border)",
            padding: 18,
            maxWidth: 720,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
            No log stream yet
          </div>
          <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: 0 }}>
            Cockpit exposes no log endpoint, so there is nothing to stream into this tab. When one
            lands, this is where the engine&rsquo;s startup line, model load/unload events, spill
            decisions, and request failures will appear — tailed live, with a level filter and a
            copy action.
          </p>
          <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: "10px 0 0" }}>
            Until then the lines exist, just not over HTTP:
          </p>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {WHERE_TODAY.map((row) => (
              <li key={row.what} style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", marginTop: 4 }}>
                <span style={{ fontWeight: 700, color: "var(--cc-fg)" }}>{row.what}</span> — {row.where}
              </li>
            ))}
          </ul>
        </div>
        <Note testId="engine-logs-note">
          This tab is deliberately empty rather than filled with sample lines: a fabricated log is
          indistinguishable from a real one, and you would debug against it.
        </Note>
      </Card>
    </div>
  );
}
