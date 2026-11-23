import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  embedUrl, embedSessionUrl, originOf, stageLabel,
  clampDockWidth, DOCK_MIN_WIDTH, DOCK_MAX_FRACTION, DOCK_WIDTH_KEY,
} from "../utils/orchRuns";

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

  // Width: the default 42% until the user drags the left edge, then their pixel
  // width, remembered. Owner QA, 2.1.62: "I cannot resize it".
  const dockRef = useRef(null);
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(DOCK_WIDTH_KEY));
      return Number.isFinite(stored) && stored >= DOCK_MIN_WIDTH ? stored : null;
    } catch { return null; }
  });
  const [dragging, setDragging] = useState(false);
  const rowWidth = () => dockRef.current?.parentElement?.getBoundingClientRect().width || 0;
  const applyWidth = (px) => {
    const next = clampDockWidth(px, rowWidth());
    setWidth(next);
    try { localStorage.setItem(DOCK_WIDTH_KEY, String(next)); } catch { /* unpersisted */ }
  };
  const resetWidth = () => {
    setWidth(null);
    try { localStorage.removeItem(DOCK_WIDTH_KEY); } catch { /* unpersisted */ }
  };
  const onDragStart = (e) => {
    e.preventDefault();
    // Capture keeps the moves coming to the handle even while the pointer is
    // over the frame, which would otherwise swallow them.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onDragMove = (e) => {
    if (!dragging || !dockRef.current) return;
    applyWidth(dockRef.current.getBoundingClientRect().right - e.clientX);
  };
  const onDragEnd = (e) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };
  const onHandleKey = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = dockRef.current?.getBoundingClientRect().width || DOCK_MIN_WIDTH;
    applyWidth(current + (e.key === "ArrowLeft" ? 24 : -24));
  };

  return (
    <aside
      ref={dockRef}
      data-testid="run-dock"
      className="flex flex-col flex-shrink-0 min-h-0"
      style={{
        position: "relative",
        width: width === null ? "42%" : width,
        minWidth: DOCK_MIN_WIDTH,
        maxWidth: `${DOCK_MAX_FRACTION * 100}%`,
        borderLeft: "1px solid var(--border-color)",
        background: "var(--cc-bg)",
      }}
    >
      <div
        data-testid="run-dock-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize run view"
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onDoubleClick={resetWidth}
        onKeyDown={onHandleKey}
        style={{
          position: "absolute",
          left: -3,
          top: 0,
          bottom: 0,
          width: 7,
          zIndex: 2,
          cursor: "col-resize",
          touchAction: "none",
          background: dragging ? "var(--cc-accent)" : "transparent",
          opacity: dragging ? 0.5 : 1,
        }}
      />
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
          style={{ border: "none", background: "var(--cc-bg)", pointerEvents: dragging ? "none" : "auto" }}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center" style={{ fontSize: 12, color: "var(--cc-muted)" }}>
          {base ? "Focus a session to see its orchestration run." : "Plexar-Framework is not reachable."}
        </div>
      )}
    </aside>
  );
}
