import React from "react";
import { cwdFolderName, runningWorkerCount, stageLabel } from "../utils/orchRuns";

/**
 * Sessions that have an open orchestration run, above the folder tree. Renders
 * nothing at all when no run is open. Module scope: everything arrives by props.
 */
export default function OrchestratorsList({ rows, selectedRunId, onPick }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (
    <div className="mb-2" style={{ padding: "0 2px" }} data-testid="orchestrators-list">
      <div className="flex items-center justify-between" style={{ padding: "2px 6px 4px" }}>
        <span className="cc-label">Orchestrators</span>
        <span style={{ fontSize: "9px", color: "var(--cc-muted)" }}>{rows.length}</span>
      </div>
      <div className="flex flex-col" style={{ gap: "1px" }}>
        {rows.map(({ run, session }) => {
          const selected = run.run_id === selectedRunId;
          const running = runningWorkerCount(run);
          return (
            <button
              key={run.run_id}
              type="button"
              data-run-id={run.run_id}
              aria-current={selected ? "true" : undefined}
              onClick={() => onPick(run, session)}
              className={`flex flex-col text-left min-w-0 ${selected ? "" : "hover-bg-surface"}`}
              style={{
                padding: "4px 6px",
                borderRadius: 6,
                borderLeft: selected ? "2px solid var(--cc-accent)" : "2px solid transparent",
                backgroundColor: selected ? "color-mix(in srgb, var(--cc-accent) 10%, transparent)" : "transparent",
              }}
            >
              <span className="flex items-center gap-1.5 min-w-0" style={{ fontSize: 12, color: "var(--cc-fg)" }}>
                <span className="truncate flex-1 min-w-0">
                  {session ? session.name : cwdFolderName(run.cwd)}
                </span>
                {!session && <span style={{ fontSize: 9, color: "var(--cc-muted)" }}>outside Studio</span>}
                <span style={{ fontSize: 10, color: "var(--cc-accent)" }}>{stageLabel(run.stage)}</span>
                {running > 0 && (
                  <span style={{ fontSize: 10, color: "var(--cc-muted)" }} title={`${running} workers running`}>
                    {running}w
                  </span>
                )}
              </span>
              <span className="truncate" style={{ fontSize: 10, color: "var(--cc-dim)" }}>{run.task}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
