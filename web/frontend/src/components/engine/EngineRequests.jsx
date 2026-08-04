/* eslint-disable react-refresh/only-export-components -- `queueRows` is the pure
   normaliser for the broker's /queue payload and is exported next to the single
   table that renders it; QueueTable is exported so Engine ▸ Live can reuse the
   very same table rather than growing a second one that could disagree. */
/**
 * EngineRequests — Engine ▸ Requests. The in-flight / queued detail, plus the
 * existing TracesPanel for the request tree.
 *
 * Shares `QueueTable` with Engine ▸ Live: Live shows the same table as a compact
 * card, Requests gives it the full width. One implementation, so the two screens
 * can never disagree about what is running.
 */
import TracesPanel from "../TracesPanel.jsx";
import { Card, CardTitle, Btn, Note, OfflinePanel, UNKNOWN, fmtElapsed, tint } from "./ui.jsx";
import { Layers, ListTree } from "lucide-react";

/** State chip tokens, pinned to the design's lane vocabulary. */
const STATE_TOKEN = {
  decode: "var(--cc-working)",
  queued: "var(--cc-waiting)",
  spilled: "var(--cc-macro)",
  done: "var(--cc-idle)",
};

/**
 * Row actions are INERT and say so. The broker exposes no cancel/stop route for
 * an individual job (only the whole lane's config is writable), and its /queue
 * payload carries no trace_id, so there is nothing to open a trace on either.
 * A button that silently does nothing is worse than a disabled one that explains.
 */
const ACTION_TITLE = {
  stop: "No per-request stop route — the broker exposes no job-cancel endpoint. Interrupt the calling session instead.",
  cancel: "No per-request cancel route — the broker exposes no job-cancel endpoint.",
  trace: "The /queue payload carries no trace id, so there is no trace to open for this row yet.",
};

function StateChip({ state }) {
  const token = STATE_TOKEN[state] || "var(--cc-muted)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 17,
        padding: "0 7px",
        borderRadius: 5,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 10),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      {state}
    </span>
  );
}

const COLS = "78px 1fr 1fr 74px 74px 66px 74px 62px";

function HeadCell({ children, right }) {
  return (
    <div
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: "var(--cc-muted)",
        textAlign: right ? "right" : "left",
      }}
    >
      {children}
    </div>
  );
}

function Cell({ children, right, mono, dim, title }) {
  return (
    <div
      title={title}
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: dim ? "var(--cc-muted)" : "var(--cc-fg)",
        fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
        textAlign: right ? "right" : "left",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

/** Normalise the broker's /queue snapshot into rows. Fields pinned from
 *  lane_broker/broker.py::_queue_state — nothing is inferred. */
export function queueRows(queue) {
  if (!queue || queue.reachable === false) return null;
  const rows = [];
  if (queue.in_flight) {
    rows.push({
      key: "in-flight",
      state: "decode",
      requester: queue.in_flight.client_id || UNKNOWN,
      model: queue.in_flight.model || UNKNOWN,
      laneClass: queue.in_flight.class || UNKNOWN,
      elapsed: queue.in_flight.elapsed_s,
      action: "stop",
    });
  }
  for (const j of Array.isArray(queue.queued) ? queue.queued : []) {
    rows.push({
      key: `q-${j.position}`,
      state: "queued",
      requester: j.client_id || UNKNOWN,
      model: j.model || UNKNOWN,
      laneClass: j.class || UNKNOWN,
      elapsed: j.waiting_s,
      action: "cancel",
    });
  }
  return rows;
}

/**
 * In flight & queued. `queue === undefined` means the provider does not offer a
 * queue capability at all (vLLM batches internally) — a materially different
 * statement from "the queue is empty", so it gets its own copy.
 */
export function QueueTable({ queue, caps, metrics, style, compact }) {
  const offered = caps ? caps.has("queue") : queue !== undefined;
  const rows = queueRows(queue);
  const engine = metrics && metrics.reachable !== false ? metrics.engine : null;

  return (
    <Card
      title={<CardTitle icon={Layers} token="var(--cc-working)">In flight &amp; queued</CardTitle>}
      right={
        rows && rows.length > 0 ? (
          <span style={{ fontSize: 10, color: "var(--cc-dim)" }}>{rows.length} in lane</span>
        ) : null
      }
      style={style}
      testId="engine-queue-table"
    >
      {offered && queue === undefined ? (
        <Note testId="queue-loading">Reading the lane…</Note>
      ) : !offered ? (
        <>
          <Note testId="queue-not-offered">
            This backend serves requests directly and does not expose a lane queue, so there is no
            per-request list to show. Its own scheduler reports aggregate counts only.
          </Note>
          {engine && (
            <div style={{ fontSize: 11, color: "var(--cc-fg)", marginTop: 8 }}>
              {`running ${engine.running ?? UNKNOWN} · waiting ${engine.waiting ?? UNKNOWN}`}
            </div>
          )}
        </>
      ) : rows === null ? (
        <Note testId="queue-offline">
          The lane broker is not answering, so Plexar Studio cannot say what is in flight. This is
          &ldquo;unknown&rdquo;, not &ldquo;nothing running&rdquo;.
        </Note>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 8,
              padding: "0 0 6px",
              borderBottom: "1px solid var(--cc-line, var(--cc-border))",
            }}
          >
            <HeadCell>State</HeadCell>
            <HeadCell>Requester</HeadCell>
            <HeadCell>Model</HeadCell>
            <HeadCell right>Prompt</HeadCell>
            <HeadCell right>Decoded</HeadCell>
            <HeadCell right>tok/s</HeadCell>
            <HeadCell right>Elapsed</HeadCell>
            <HeadCell right>Action</HeadCell>
          </div>
          {rows.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--cc-dim)", padding: "10px 0 2px" }}>
              Lane is empty — nothing in flight and nothing queued.
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={r.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS,
                  gap: 8,
                  alignItems: "center",
                  height: 30,
                  borderBottom: "1px solid var(--cc-line, var(--cc-border))",
                }}
              >
                <div><StateChip state={r.state} /></div>
                <Cell mono title={r.requester}>{r.requester}</Cell>
                <Cell mono title={r.model}>{r.model}</Cell>
                <Cell right dim title="The broker does not report prompt size per job">{UNKNOWN}</Cell>
                <Cell right dim title="Decoded-token counts are not reported per job">{UNKNOWN}</Cell>
                <Cell right dim title="Per-job decode rate is not reported; see the lane average">{UNKNOWN}</Cell>
                <Cell right>{fmtElapsed(r.elapsed)}</Cell>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Btn label={r.action} disabled title={ACTION_TITLE[r.action]} testId={`row-${r.action}-${r.key}`} />
                </div>
              </div>
            ))
          )}
          {!compact && (
            <Note>
              Prompt size, decoded tokens, and per-job tok/s are blank because the broker&rsquo;s
              /queue snapshot does not carry them — not because they are zero. Lane-wide decode
              rate is on the Live tab.
            </Note>
          )}
        </>
      )}
    </Card>
  );
}

export default function EngineRequests({ provider, caps, data, onNavigate }) {
  const hasTraces = caps?.has("traces");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", minWidth: 0 }}>
      <QueueTable queue={data?.queue} caps={caps} metrics={data?.metrics} />

      <Card title={<CardTitle icon={ListTree} token="var(--cc-type)">Traces</CardTitle>}>
        {!hasTraces ? (
          <OfflinePanel
            testId="traces-not-offered"
            title="This backend does not expose traces"
            body="Traces come from the lane broker's /traces endpoint. The selected provider does not declare the traces capability, so there is nothing to read."
          />
        ) : data?.traces === null ? (
          <Note testId="traces-offline">
            The broker is not answering /traces. Recent requests may still have run — Plexar Studio simply
            cannot read them right now.
          </Note>
        ) : (
          <TracesPanel traces={data?.traces} providerId={provider?.id} />
        )}
      </Card>

      {typeof onNavigate === "function" && (
        <Note>
          Looking for totals over days rather than what is running now? That lives in Reports.
        </Note>
      )}
    </div>
  );
}
