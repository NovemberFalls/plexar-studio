import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { embedUrl, embedSessionUrl, originOf, stageLabel } from "../utils/orchRuns";

/**
 * The framework's live picture of one run, docked on the right of the sessions
 * grid. The frame's src is built from `base` and the run at first load ONLY: a
 * later run change is a postMessage (the frame re-points itself), never a reload.
 * Messages from the frame are trusted only from base's origin AND this frame's own
 * window, and every field is rendered as text through stageLabel.
 *
 * Two modes. With `runId` it shows that run. Without one it FOLLOWS `sessionId`
 * (the focused pane): the frame shows that session's newest open run and picks up
 * the next one when it starts, which is what the top bar toggle opens when no run
 * was picked from the Orchestrators list.
 */
export default function RunDock({ base, runId, run, sessionId = null, sessionName = null, onClose }) {
  const frameRef = useRef(null);
  const origin = originOf(base);
  const [readyN, setReadyN] = useState(0);
  const [embedStage, setEmbedStage] = useState(null); // { run, stage }

  // Frame URL: fixed at the run shown when `base` last changed, so a run change
  // never alters src (the postMessage below carries it).
  const [ready, setReady] = useState(false);
  const [frame, setFrame] = useState({ base, run: runId, session: sessionId });
  if (frame.base !== base) {
    setFrame({ base, run: runId, session: sessionId });
    setReady(false);
  }
  const hasTarget = Boolean(frame.run || frame.session);
  const src = !base || !hasTarget ? null
    : frame.run ? embedUrl(base, frame.run) : embedSessionUrl(base, frame.session);
  // The frame only exists once there is something to show; adopt the first target.
  if (!hasTarget && (runId || sessionId)) setFrame({ base, run: runId, session: sessionId });

  useEffect(() => {
    const onMessage = (event) => {
      if (!origin || event.origin !== origin) return;
      const win = frameRef.current?.contentWindow;
      if (!win || event.source !== win) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "plexar-embed-ready") {
        setReady(true);
        setReadyN((n) => n + 1);
      } else if (data.type === "plexar-embed-stage") {
        setEmbedStage({ run: String(data.run ?? ""), stage: typeof data.stage === "string" ? data.stage : "" });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  useEffect(() => {
    if (!ready || !origin) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    if (runId) win.postMessage({ type: "plexar-run", run: runId }, origin);
    else if (sessionId) win.postMessage({ type: "plexar-session", session: sessionId }, origin);
  }, [ready, readyN, runId, sessionId, origin]);

  // Keep the last open reading so a run that closes still names its task and stage.
  const [last, setLast] = useState(run);
  if (run && last !== run) setLast(run);
  const shown = run || (last?.run_id === runId ? last : null);
  const following = !runId;
  const closed = !following && !run;
  const stage = following
    ? (embedStage?.stage || null)
    : (embedStage && embedStage.run === runId && embedStage.stage ? embedStage.stage : shown?.stage);

  return (
    <aside
      data-testid="run-dock"
      className="flex flex-col flex-shrink-0 min-h-0"
      style={{
        width: "42%",
        minWidth: 360,
        borderLeft: "1px solid var(--border-color)",
        background: "var(--cc-bg)",
      }}
    >
      <div
        className="flex items-center gap-2 flex-shrink-0"
        style={{ height: 30, padding: "0 8px", borderBottom: "1px solid var(--cc-line)" }}
      >
        <span className="truncate flex-1 min-w-0" style={{ fontSize: 12, color: "var(--cc-fg)" }} title={shown?.task || ""}>
          {/* The frame shows the live task line itself; repeating it here read as a
              duplicate. Without a frame this header is the only place it appears. */}
          {src ? "Orchestration run" : (shown?.task || runId)}
        </span>
        <span style={{ fontSize: 10, color: "var(--cc-accent)" }}>
          {following
            ? (sessionId ? `${sessionName || "This session"}${stage ? ` · ${stageLabel(stage)}` : ""}` : "")
            : closed ? `Run closed${stage ? ` at ${stageLabel(stage)}` : ""}` : stageLabel(stage)}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close run dock"
          aria-label="Close run dock"
          className="p-0.5 rounded hover-bg-surface"
          style={{ color: "var(--cc-muted)" }}
        >
          <X size={14} />
        </button>
      </div>
      {src ? (
        <iframe
          ref={frameRef}
          title="Orchestration run"
          src={src}
          sandbox="allow-scripts allow-same-origin"
          onLoad={() => setReady(true)}
          className="flex-1 min-h-0 w-full"
          style={{ border: "none", background: "var(--cc-bg)" }}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center" style={{ fontSize: 12, color: "var(--cc-muted)" }}>
          {base ? "Focus a session to see its orchestration run." : "Plexar-Framework is not reachable."}
        </div>
      )}
    </aside>
  );
}
