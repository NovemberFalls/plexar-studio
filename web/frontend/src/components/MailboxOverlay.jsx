import { useState } from "react";

/**
 * The pane badge for a session enrolled in a V4 mailbox bridge.
 *
 * Two states, and the difference between them is the point of the redesign:
 *
 *  - **running** — a thin accent strip: role, handle, rounds used. Informational
 *    only; the session is driving itself off its own file watcher and there is
 *    nothing for the user to do.
 *
 *  - **awaiting_human** — the bridge hit its round cap and PAUSED. This is a
 *    prompt, not a status: the conversation is intact, every session is standing
 *    by, and it resumes the moment more rounds are granted. It is rendered in
 *    the waiting colour (not the error colour) with the grant control inline,
 *    because a paused bridge is a normal, expected outcome and must not read as
 *    a failure.
 *
 * There is deliberately no native `confirm()` here — those are banned app-wide
 * (see NoNativeDialogs.test.jsx); WebView2 prefixes them with the page origin,
 * so a desktop app ends up showing the user its own HTTP port.
 */
export default function MailboxOverlay({ info, onExtend, onStop }) {
    const [busy, setBusy] = useState(false);
    if (!info) return null;

    const paused = info.state === "awaiting_human";
    const accent = paused ? "var(--cc-waiting, #e0b060)" : "var(--cc-accent, #6ab0f3)";
    const rgb = paused ? "224,176,96" : "106,176,243";

    const grant = async (n) => {
        if (busy) return;
        setBusy(true);
        try {
            await onExtend(info.mailbox_id, n);
        } finally {
            setBusy(false);
        }
    };

    const btn = {
        pointerEvents: "all",
        fontSize: "10px",
        fontWeight: 600,
        color: accent,
        border: `1px solid rgba(${rgb},0.6)`,
        borderRadius: 4,
        padding: "1px 7px",
        backgroundColor: `rgba(${rgb},0.15)`,
        cursor: busy ? "wait" : "pointer",
        opacity: busy ? 0.6 : 1,
    };

    return (
        <div
            className={paused ? "mailbox-paused-glow" : "mailbox-active-glow"}
            style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "4px 10px",
                backgroundColor: `rgba(${rgb}, 0.12)`,
                borderBottom: `1px solid rgba(${rgb}, 0.5)`,
                zIndex: 5,
                pointerEvents: "none",
            }}
        >
            <span
                style={{
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    color: accent,
                    textShadow: `0 0 8px rgba(${rgb},0.7)`,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                }}
            >
                {paused
                    ? `ROUND CAP REACHED · ${info.rounds_used}/${info.max_rounds} · grant more?`
                    : `${info.isLead ? "BRIDGE LEAD" : "BRIDGE WORKER"} · ${info.handle} · round ${info.rounds_used}/${info.max_rounds}`}
            </span>
            <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {paused && (
                    <>
                        <button type="button" style={btn} onClick={() => grant(5)}>
                            +5
                        </button>
                        <button type="button" style={btn} onClick={() => grant(15)}>
                            +15
                        </button>
                    </>
                )}
                <button type="button" style={btn} onClick={() => onStop(info.mailbox_id)}>
                    {paused ? "End" : "Stop"}
                </button>
            </span>
        </div>
    );
}
