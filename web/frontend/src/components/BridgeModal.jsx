import { useState, useRef, useEffect, useCallback } from "react";
import { X, AlertTriangle, Loader, Merge, Minus, Plus, Check } from "lucide-react";
import StateIcon from "./StateIcon.jsx";

// ---------------------------------------------------------------------------
// Preset chips for the custom-message mode
// ---------------------------------------------------------------------------
// Stable empty Map identity so callers that don't pass busyTerminalIds (e.g.
// existing tests) get correct "nothing is busy" behaviour without a fresh
// object being created on every render.
const EMPTY_BUSY_MAP = new Map();

const PRESET_CHIPS = [
    {
        label: "Share blast radius",
        text: "Share your current blast radius — the files you intend to touch — so we can reconcile if there is overlap.",
    },
    {
        label: "Reconcile overlap",
        text: "List the files you plan to modify. Let us identify any overlap and agree on ownership before proceeding.",
    },
    {
        label: "Status check",
        text: "Give a brief status update: what you have completed, what is in progress, and what blockers you have.",
    },
];

// ---------------------------------------------------------------------------
// SessionDot — small coloured dot keyed off activityState
// ---------------------------------------------------------------------------
function SessionDot({ activityState }) {
    return (
        <StateIcon state={activityState || "idle"} />
    );
}

// ---------------------------------------------------------------------------
// ReceiverList — radio-style list of selectable target sessions
// ---------------------------------------------------------------------------
function BusyHint() {
    return (
        <span
            className="text-[9px] font-bold uppercase"
            style={{
                color: "var(--cc-error)",
                background: "color-mix(in srgb, var(--cc-error) 15%, transparent)",
                borderRadius: 4,
                padding: "2px 6px",
                letterSpacing: ".04em",
                flexShrink: 0,
            }}
        >
            BUSY &middot; in bridge
        </span>
    );
}

function PickerRow({ selected, disabled, onClick, accent, name, model, activityState, busy, shape = "radio", checked }) {
    return (
        <button
            type="button"
            role={shape}
            aria-checked={shape === "radio" ? selected : checked}
            disabled={disabled}
            onClick={onClick}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-left transition-colors"
            style={{
                border: `1px solid ${
                    selected || checked
                        ? `color-mix(in srgb, ${accent} 35%, transparent)`
                        : "var(--cc-border, var(--border-color))"
                }`,
                backgroundColor:
                    selected || checked
                        ? `color-mix(in srgb, ${accent} 10%, transparent)`
                        : "var(--cc-term, var(--bg-surface))",
                color: "var(--cc-fg, var(--text-primary))",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
            }}
        >
            {shape === "radio" ? (
                <span
                    style={{
                        width: 15,
                        height: 15,
                        borderRadius: 999,
                        border: `2px solid ${selected ? accent : "var(--cc-muted, var(--text-muted))"}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                    }}
                >
                    <span
                        style={{
                            width: 7,
                            height: 7,
                            borderRadius: 999,
                            background: selected ? accent : "transparent",
                        }}
                    />
                </span>
            ) : (
                <span
                    style={{
                        width: 15,
                        height: 15,
                        borderRadius: 4,
                        border: `2px solid ${checked ? accent : "var(--cc-muted, var(--text-muted))"}`,
                        background: checked ? accent : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        color: "#0f1216",
                    }}
                >
                    {checked && <Check size={9} strokeWidth={3.5} />}
                </span>
            )}
            <SessionDot activityState={activityState} />
            <span className="flex-1 truncate font-semibold">{name}</span>
            {busy && <BusyHint />}
            <span
                className="text-[10px] truncate"
                style={{ color: "var(--cc-muted, var(--text-muted))" }}
            >
                {model}
            </span>
        </button>
    );
}

function ReceiverList({ sessions, fromSessionId, selected, onSelect, busyTerminalIds = EMPTY_BUSY_MAP, accent }) {
    const eligible = sessions.filter(
        (s) =>
            s.id !== fromSessionId &&
            s.status === "running" &&
            s.terminalId != null
    );

    if (eligible.length === 0) {
        return (
            <p
                className="text-xs py-2 px-1"
                style={{ color: "var(--cc-muted, var(--text-muted))" }}
            >
                No other running sessions to bridge with.
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-1.5 max-h-[150px] overflow-y-auto" role="radiogroup" aria-label="Target session">
            {eligible.map((s) => {
                const isSelected = s.id === selected;
                const busyReason = busyTerminalIds.get(s.terminalId);
                const isBusy = Boolean(busyReason);
                return (
                    <PickerRow
                        key={s.id}
                        shape="radio"
                        selected={isSelected}
                        disabled={isBusy}
                        onClick={() => onSelect(s.id)}
                        accent={accent}
                        name={s.name}
                        model={s.model}
                        activityState={s.activityState}
                        busy={isBusy}
                    />
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Stepper — small +/- control used for max-turns
// ---------------------------------------------------------------------------
function Stepper({ value, onDec, onInc, min, max }) {
    return (
        <div
            className="flex items-center gap-0.5 rounded-lg"
            style={{
                background: "var(--cc-term, var(--bg-surface))",
                border: "1px solid var(--cc-border, var(--border-color))",
                padding: 3,
            }}
        >
            <button
                type="button"
                aria-label="Decrease max turns"
                onClick={onDec}
                disabled={value <= min}
                className="flex items-center justify-center rounded-md"
                style={{
                    width: 26,
                    height: 26,
                    border: "none",
                    background: "none",
                    color: "var(--cc-dim, var(--text-secondary))",
                    cursor: value <= min ? "not-allowed" : "pointer",
                    opacity: value <= min ? 0.4 : 1,
                }}
            >
                <Minus size={12} />
            </button>
            <span
                className="text-[13px] font-bold text-center"
                style={{ minWidth: 30, color: "var(--cc-fg, var(--text-primary))" }}
            >
                {value}
            </span>
            <button
                type="button"
                aria-label="Increase max turns"
                onClick={onInc}
                disabled={value >= max}
                className="flex items-center justify-center rounded-md"
                style={{
                    width: 26,
                    height: 26,
                    border: "none",
                    background: "none",
                    color: "var(--cc-dim, var(--text-secondary))",
                    cursor: value >= max ? "not-allowed" : "pointer",
                    opacity: value >= max ? 0.4 : 1,
                }}
            >
                <Plus size={12} />
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// NeonWarningPanel — used in the Bridge tab
// ---------------------------------------------------------------------------
const NEON_PANEL_STYLE = {
    background: "color-mix(in srgb, var(--cc-error, #e0698a) 16%, var(--cc-surface, var(--bg-elevated)))",
    border: "1px solid color-mix(in srgb, var(--cc-error, #e0698a) 45%, transparent)",
    color: "var(--cc-fg, var(--text-primary))",
    padding: "14px 16px",
    borderRadius: "10px",
    boxShadow: "0 0 18px color-mix(in srgb, var(--cc-error, #e0698a) 25%, transparent)",
    fontWeight: 600,
    marginBottom: "16px",
    animation: "bridge-neon-pulse 2.6s ease-in-out infinite",
};

const NEON_PANEL_SMALL_STYLE = {
    ...NEON_PANEL_STYLE,
    fontSize: "12px",
    padding: "10px 14px",
    fontWeight: 500,
    marginBottom: "14px",
};

// ---------------------------------------------------------------------------
// BridgeModal
// ---------------------------------------------------------------------------
export default function BridgeModal({
    open,
    fromSession,
    allSessions,
    busyTerminalIds = EMPTY_BUSY_MAP,
    onSendManual,
    onStartMailbox,
    onClose,
    fetchLatestAssistant,
}) {
    // ---- state ----
    const [tab, setTab] = useState("manual");
    const [toSessionId, setToSessionId] = useState(null);
    const [manualMode, setManualMode] = useState("latest");
    const [latestText, setLatestText] = useState("");
    const [latestLoading, setLatestLoading] = useState(false);
    const [customText, setCustomText] = useState("");
    const [prefix, setPrefix] = useState(
        fromSession ? `[From session "${fromSession.name}"]:` : ""
    );
    const [submitting, setSubmitting] = useState(false);

    // ---- bridge tab state (V4 mailbox protocol) ----
    const [bridgeLeadId, setBridgeLeadId] = useState(null);
    const [bridgeWorkerIds, setBridgeWorkerIds] = useState(new Set());
    const [bridgeTopic, setBridgeTopic] = useState("");
    const [bridgeMaxRounds, setBridgeMaxRounds] = useState(6);
    const [bridgeConfirmed, setBridgeConfirmed] = useState(false);
    const [bridgeError, setBridgeError] = useState(null);

    const cardRef = useRef(null);
    const firstFieldRef = useRef(null);

    // ---- sync prefix when fromSession changes ----
    useEffect(() => {
        if (fromSession) {
            setPrefix(`[From session "${fromSession.name}"]:`);
        }
    }, [fromSession]);

    // ---- focus management ----
    useEffect(() => {
        if (open) {
            firstFieldRef.current?.focus();
        }
    }, [open]);

    // ---- escape key ----
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (e.key === "Escape" && !submitting) {
                onClose();
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [open, submitting, onClose]);

    // ---- click-outside to close ----
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (cardRef.current && !cardRef.current.contains(e.target)) {
                if (!submitting) onClose();
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open, submitting, onClose]);

    // ---- fetch latest assistant reply when receiver is set or tab/mode activates ----
    const fetchLatest = useCallback(async () => {
        if (!fromSession?.terminalId || !fetchLatestAssistant) return;
        setLatestLoading(true);
        setLatestText("");
        try {
            const result = await fetchLatestAssistant(fromSession.terminalId);
            setLatestText(result || "");
        } catch {
            setLatestText("");
        } finally {
            setLatestLoading(false);
        }
    }, [fromSession?.terminalId, fetchLatestAssistant]);

    useEffect(() => {
        if (!open) return;
        if (tab === "manual" && manualMode === "latest" && toSessionId != null) {
            fetchLatest();
        }
    }, [open, tab, manualMode, toSessionId, fetchLatest]);

    // ---- tab switch resets the bridge confirm gate ----
    const handleTabChange = (newTab) => {
        setTab(newTab);
        setBridgeConfirmed(false);
        setBridgeError(null);
    };

    // ---- receiver helpers ----
    const eligibleSessions = allSessions.filter(
        (s) =>
            s.id !== fromSession?.id &&
            s.status === "running" &&
            s.terminalId != null
    );
    const receiverSession = eligibleSessions.find((s) => s.id === toSessionId) || null;

    // ---- bridge session helpers ----
    // Eligible for the bridge tab (excludes modal's own session)
    const bridgeEligible = allSessions.filter(
        (s) =>
            s.id !== fromSession?.id &&
            s.status === "running" &&
            s.terminalId != null
    );
    // After a lead is chosen, workers are the remaining eligible sessions (excluding lead)
    const bridgeWorkerEligible = bridgeEligible.filter((s) => s.id !== bridgeLeadId);

    // ---- busy-session helper — true if the given local session id maps to a
    // terminalId currently enrolled in another active bridge/channel. Used both
    // to disable picker rows and as a submit-time safety net in case busyness
    // changes (via polling) after a row was already selected. ----
    const sessionIsBusy = (sessionId) => {
        if (!sessionId) return false;
        const s = allSessions.find((x) => x.id === sessionId);
        return s ? busyTerminalIds.has(s.terminalId) : false;
    };

    const toggleBridgeWorker = (sessionId) => {
        setBridgeWorkerIds((prev) => {
            const next = new Set(prev);
            if (next.has(sessionId)) next.delete(sessionId);
            else next.add(sessionId);
            return next;
        });
    };

    // When lead changes, remove the new lead from workers if it was selected
    const handleBridgeLeadChange = (sessionId) => {
        setBridgeLeadId(sessionId);
        setBridgeWorkerIds((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
        });
    };

    // ---- manual send ----
    const handleSendManual = async () => {
        if (submitting) return;
        const text = manualMode === "latest" ? latestText : customText.trim();
        if (!text || !toSessionId) return;
        setSubmitting(true);
        try {
            await onSendManual({ to: toSessionId, text, prefix });
        } finally {
            setSubmitting(false);
            onClose();
        }
    };

    // ---- mailbox bridge start ----
    const handleStartBridge = async () => {
        if (submitting) return;
        if (!bridgeLeadId || bridgeWorkerIds.size === 0 || !bridgeTopic.trim()) return;
        setSubmitting(true);
        setBridgeError(null);
        try {
            const res = await onStartMailbox({
                leadId: bridgeLeadId,
                workerIds: [...bridgeWorkerIds],
                topic: bridgeTopic.trim(),
                maxRounds: bridgeMaxRounds,
            });
            if (res && res.ok === false) {
                setBridgeError(res.error || "Could not start the bridge");
                setSubmitting(false);
                return;
            }
        } catch (e) {
            setBridgeError(e.message || "Unknown error");
            setSubmitting(false);
            return;
        }
        setSubmitting(false);
        onClose();
    };

    // ---- disabled logic ----
    const manualSendDisabled =
        !toSessionId ||
        submitting ||
        sessionIsBusy(toSessionId) ||
        (manualMode === "latest" && (!latestText || latestLoading)) ||
        (manualMode === "custom" && !customText.trim());

    const bridgeStartDisabled =
        !bridgeLeadId ||
        bridgeWorkerIds.size === 0 ||
        !bridgeTopic.trim() ||
        !bridgeConfirmed ||
        submitting ||
        sessionIsBusy(bridgeLeadId) ||
        [...bridgeWorkerIds].some(sessionIsBusy);

    if (!open || !fromSession) return null;

    // ---- mode accent: salmon (--cc-error) for a one-shot manual relay, gold
    // (--cc-waiting) for a live bridge, matching the pane overlay's colours ----
    const isBridgeTab = tab === "bridge";
    const accent = isBridgeTab ? "var(--cc-waiting, #e0b060)" : "var(--cc-error, #e0698a)";
    const modeSubtitle =
        tab === "manual"
            ? "Relay one message to another session"
            : "Sessions coordinate over a shared mailbox file";

    const tabDefs = [
        { id: "manual", label: "Manual" },
        { id: "bridge", label: "Bridge" },
    ];

    return (
        <>
            {/* Keyframe for neon pulse — scoped inline */}
            <style>{`
                @keyframes bridge-neon-pulse {
                    0%, 100% { box-shadow: 0 0 18px color-mix(in srgb, var(--cc-error, #e0698a) 18%, transparent); }
                    50%       { box-shadow: 0 0 24px color-mix(in srgb, var(--cc-error, #e0698a) 32%, transparent); }
                }
            `}</style>

            {/* Overlay */}
            <div
                className="cc-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
                aria-modal="true"
                role="dialog"
                aria-label={`Bridge from "${fromSession.name}"`}
            >
                {/* Card */}
                <div
                    ref={cardRef}
                    className="cc-modal flex flex-col"
                    style={{
                        width: "100%",
                        maxWidth: "560px",
                        maxHeight: "90vh",
                        borderRadius: 14,
                        backgroundColor: "var(--cc-surface, var(--bg-elevated))",
                        border: "1px solid var(--cc-border, var(--border-color))",
                        boxShadow: `0 40px 120px rgba(0,0,0,.6), 0 0 0 1px color-mix(in srgb, ${accent} 22%, transparent)`,
                        overflow: "hidden",
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div
                        className="flex items-center justify-between"
                        style={{
                            padding: "16px 18px",
                            borderBottom: "1px solid var(--cc-line, var(--border-color))",
                        }}
                    >
                        <div className="flex items-center gap-2.5">
                            <div
                                className="flex items-center justify-center"
                                style={{
                                    width: 28,
                                    height: 28,
                                    borderRadius: 8,
                                    background: `color-mix(in srgb, ${accent} 15%, transparent)`,
                                    border: `1px solid color-mix(in srgb, ${accent} 35%, transparent)`,
                                    color: accent,
                                }}
                            >
                                <Merge size={15} />
                            </div>
                            <div className="flex flex-col" style={{ lineHeight: 1.15 }}>
                                <h3
                                    className="text-[15px] font-bold"
                                    style={{ color: "var(--cc-fg, var(--text-primary))" }}
                                >
                                    Bridge from &quot;{fromSession.name}&quot;
                                </h3>
                                <span
                                    className="text-[11px]"
                                    style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                >
                                    {modeSubtitle}
                                </span>
                            </div>
                        </div>
                        <button
                            type="button"
                            aria-label="Close modal"
                            onClick={onClose}
                            className="p-1.5 rounded-lg hover-color-red"
                            style={{ color: "var(--cc-muted, var(--text-muted))", background: "none", border: "none" }}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    <div className="flex flex-col" style={{ padding: "14px 18px 0", gap: 14 }}>
                        {/* From chip */}
                        <div className="flex items-center gap-2 text-xs">
                            <span style={{ color: "var(--cc-muted, var(--text-muted))" }}>From</span>
                            <span
                                className="cc-pill flex items-center gap-1.5"
                                style={{
                                    padding: "4px 10px",
                                    background: "var(--cc-term, var(--bg-surface))",
                                    border: "1px solid var(--cc-border, var(--border-color))",
                                    borderRadius: 999,
                                }}
                            >
                                <SessionDot activityState={fromSession.activityState} />
                                <span className="font-bold" style={{ color: "var(--cc-fg, var(--text-primary))" }}>
                                    {fromSession.name}
                                </span>
                                {fromSession.model && (
                                    <span className="text-[10px]" style={{ color: "var(--cc-muted, var(--text-muted))" }}>
                                        {fromSession.model}
                                    </span>
                                )}
                            </span>
                        </div>

                        {/* Segmented tabs */}
                        <div
                            className="flex"
                            role="tablist"
                            style={{
                                background: "var(--cc-term, var(--bg-surface))",
                                border: "1px solid var(--cc-border, var(--border-color))",
                                borderRadius: 9,
                                padding: 3,
                                gap: 3,
                            }}
                        >
                            {tabDefs.map((t) => {
                                const active = tab === t.id;
                                const tabAccent = t.id === "bridge" ? "var(--cc-waiting, #e0b060)" : "var(--cc-error, #e0698a)";
                                return (
                                    <button
                                        key={t.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={active}
                                        onClick={() => handleTabChange(t.id)}
                                        className="flex-1 flex items-center justify-center text-xs font-bold rounded-md transition-colors"
                                        style={{
                                            height: 32,
                                            color: active ? "#0f1216" : "var(--cc-dim, var(--text-muted))",
                                            background: active ? tabAccent : "transparent",
                                            border: "none",
                                        }}
                                    >
                                        {t.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="flex flex-col" style={{ padding: "16px 18px", gap: 16 }}>
                        {/* Intro */}
                        <p
                            className="text-xs"
                            style={{ color: "var(--cc-muted, var(--text-muted))", lineHeight: 1.6, margin: 0 }}
                        >
                            Send a message from this session to another running session.{" "}
                            <strong style={{ color: "var(--cc-dim, var(--text-secondary))" }}>Manual</strong>{" "}
                            relays a single message (your latest reply or a custom prompt).{" "}
                            <strong style={{ color: "var(--cc-dim, var(--text-secondary))" }}>Bridge</strong>{" "}
                            links a lead session with one or more workers over a shared mailbox file
                            they each watch, so they coordinate without you relaying anything.
                        </p>

                        {/* Receiver picker — only visible for Manual and Auto tabs */}
                        {tab !== "bridge" && (
                            <div>
                                <label
                                    className="cc-label block mb-1.5"
                                    style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                >
                                    Send to
                                </label>
                                <ReceiverList
                                    sessions={allSessions}
                                    fromSessionId={fromSession.id}
                                    selected={toSessionId}
                                    onSelect={(id) => setToSessionId(id)}
                                    busyTerminalIds={busyTerminalIds}
                                    accent="var(--cc-error, #e0698a)"
                                />
                            </div>
                        )}

                        {/* ---- MANUAL TAB ---- */}
                        {tab === "manual" && (
                            <>
                                {/* Mode toggle */}
                                <div>
                                    <label
                                        className="cc-label block mb-1.5"
                                        style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                    >
                                        Message source
                                    </label>
                                    <div
                                        className="flex rounded-lg overflow-hidden"
                                        style={{ border: "1px solid var(--cc-border, var(--border-color))" }}
                                        role="group"
                                        aria-label="Message source"
                                    >
                                        <button
                                            type="button"
                                            aria-pressed={manualMode === "latest"}
                                            onClick={() => setManualMode("latest")}
                                            className="flex-1 px-3 py-1.5 text-xs font-semibold transition-colors"
                                            style={{
                                                color: manualMode === "latest" ? "#0f1216" : "var(--cc-muted, var(--text-muted))",
                                                backgroundColor:
                                                    manualMode === "latest" ? "var(--cc-error, #e0698a)" : "transparent",
                                                borderRight: "1px solid var(--cc-border, var(--border-color))",
                                            }}
                                        >
                                            Relay my latest reply
                                        </button>
                                        <button
                                            type="button"
                                            aria-pressed={manualMode === "custom"}
                                            onClick={() => setManualMode("custom")}
                                            className="flex-1 px-3 py-1.5 text-xs font-semibold transition-colors"
                                            style={{
                                                color: manualMode === "custom" ? "#0f1216" : "var(--cc-muted, var(--text-muted))",
                                                backgroundColor:
                                                    manualMode === "custom" ? "var(--cc-error, #e0698a)" : "transparent",
                                            }}
                                        >
                                            Custom message
                                        </button>
                                    </div>
                                </div>

                                {/* Latest reply display */}
                                {manualMode === "latest" && (
                                    <div>
                                        {latestLoading ? (
                                            <div
                                                className="flex items-center gap-2 py-3 text-xs"
                                                style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                            >
                                                <Loader
                                                    size={12}
                                                    className="state-icon-spin"
                                                    style={{ color: "var(--cc-error, var(--accent))" }}
                                                />
                                                Fetching latest reply...
                                            </div>
                                        ) : latestText ? (
                                            <pre
                                                className="text-xs rounded-lg px-3 py-2"
                                                style={{
                                                    backgroundColor: "var(--cc-term, var(--bg-surface))",
                                                    border: "1px solid var(--cc-border, var(--border-color))",
                                                    color: "var(--cc-dim, var(--text-secondary))",
                                                    fontFamily: "inherit",
                                                    maxHeight: "140px",
                                                    overflowY: "auto",
                                                    whiteSpace: "pre-wrap",
                                                    wordBreak: "break-word",
                                                    margin: 0,
                                                }}
                                            >
                                                {latestText}
                                            </pre>
                                        ) : (
                                            <p
                                                className="text-xs py-2"
                                                style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                            >
                                                {toSessionId
                                                    ? "(No assistant reply found yet for this session.)"
                                                    : "Select a target session above to load the latest reply."}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* Custom message */}
                                {manualMode === "custom" && (
                                    <div className="flex flex-col gap-2">
                                        {/* Preset chips */}
                                        <div className="flex flex-wrap gap-1.5">
                                            {PRESET_CHIPS.map((chip) => (
                                                <button
                                                    key={chip.label}
                                                    type="button"
                                                    onClick={() => setCustomText(chip.text)}
                                                    className="cc-chip"
                                                    style={{
                                                        border: "1px solid var(--cc-border, var(--border-color))",
                                                        color: "var(--cc-dim, var(--text-secondary))",
                                                        backgroundColor: "transparent",
                                                        borderRadius: 999,
                                                        padding: "4px 10px",
                                                        fontWeight: 600,
                                                        textTransform: "none",
                                                        letterSpacing: "normal",
                                                    }}
                                                >
                                                    {chip.label}
                                                </button>
                                            ))}
                                        </div>
                                        <label
                                            htmlFor="bridge-custom-text"
                                            className="cc-label block"
                                            style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                        >
                                            Message
                                        </label>
                                        <textarea
                                            id="bridge-custom-text"
                                            ref={manualMode === "custom" ? firstFieldRef : null}
                                            rows={4}
                                            value={customText}
                                            onChange={(e) => setCustomText(e.target.value)}
                                            onKeyDown={(e) => {
                                                // Allow Enter for newlines; do not submit
                                                e.stopPropagation();
                                            }}
                                            placeholder="Type a message to relay..."
                                            className="w-full px-3 py-2 rounded-lg text-xs outline-none resize-none"
                                            style={{
                                                backgroundColor: "var(--cc-term, var(--bg-surface))",
                                                color: "var(--cc-fg, var(--text-primary))",
                                                border: "1px solid var(--cc-border, var(--border-color))",
                                                fontFamily: "inherit",
                                                lineHeight: 1.5,
                                            }}
                                        />
                                    </div>
                                )}

                                {/* Prefix input */}
                                <div>
                                    <label
                                        htmlFor="bridge-prefix"
                                        className="cc-label block mb-1"
                                        style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                    >
                                        Prefix (prepended to message)
                                    </label>
                                    <input
                                        id="bridge-prefix"
                                        ref={manualMode === "latest" ? firstFieldRef : null}
                                        type="text"
                                        value={prefix}
                                        onChange={(e) => setPrefix(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg text-xs outline-none"
                                        style={{
                                            backgroundColor: "var(--cc-term, var(--bg-surface))",
                                            color: "var(--cc-fg, var(--text-primary))",
                                            border: "1px solid var(--cc-border, var(--border-color))",
                                            fontFamily: "inherit",
                                        }}
                                    />
                                </div>
                            </>
                        )}

                        {/* ---- CHANNEL TAB ---- */}
                        {tab === "bridge" && (
                            <>
                                {/* Neon warning panel (gold — matches the live pane badge) */}
                                <div
                                    style={{
                                        ...NEON_PANEL_STYLE,
                                        background: "color-mix(in srgb, var(--cc-waiting, #e0b060) 16%, var(--cc-surface, var(--bg-elevated)))",
                                        border: "1px solid color-mix(in srgb, var(--cc-waiting, #e0b060) 45%, transparent)",
                                        boxShadow: "0 0 18px color-mix(in srgb, var(--cc-waiting, #e0b060) 25%, transparent)",
                                    }}
                                    role="alert"
                                >
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle
                                            size={16}
                                            style={{ flexShrink: 0, marginTop: "1px", color: "var(--cc-waiting, #e0b060)" }}
                                        />
                                        <div>
                                            <div style={{ fontSize: "13px", marginBottom: "4px" }}>
                                                AUTONOMOUS BRIDGE
                                            </div>
                                            <div style={{ fontSize: "11px", fontWeight: 400, lineHeight: 1.5 }}>
                                                These sessions will work together without your input until
                                                they all agree they are done, the round cap is reached, or
                                                you click Stop. At the cap the bridge PAUSES and asks you
                                                whether to grant more rounds — it does not silently end.
                                                Token cost scales with the number of sessions.
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Lead session picker */}
                                <div>
                                    <label
                                        className="cc-label block mb-1.5"
                                        style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                    >
                                        Lead session
                                    </label>
                                    {bridgeEligible.length === 0 ? (
                                        <p
                                            className="text-xs py-2 px-1"
                                            style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                        >
                                            No other running sessions available.
                                        </p>
                                    ) : (
                                        <div className="flex flex-col gap-1.5 max-h-[150px] overflow-y-auto" role="radiogroup" aria-label="Lead session">
                                            {bridgeEligible.map((s) => {
                                                const isSelected = s.id === bridgeLeadId;
                                                const busyReason = busyTerminalIds.get(s.terminalId);
                                                const isBusy = Boolean(busyReason);
                                                return (
                                                    <PickerRow
                                                        key={s.id}
                                                        shape="radio"
                                                        selected={isSelected}
                                                        disabled={isBusy}
                                                        onClick={() => handleBridgeLeadChange(s.id)}
                                                        accent="var(--cc-waiting, #e0b060)"
                                                        name={s.name}
                                                        model={s.model}
                                                        activityState={s.activityState}
                                                        busy={isBusy}
                                                        busyReason={busyReason}
                                                    />
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                {/* Worker sessions picker */}
                                <div>
                                    <label
                                        className="cc-label block mb-1.5"
                                        style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                    >
                                        Worker sessions{" "}
                                        <span style={{ color: "var(--cc-waiting, #e0b060)" }}>
                                            {bridgeWorkerIds.size > 0 ? `${bridgeWorkerIds.size} selected` : ""}
                                        </span>
                                    </label>
                                    {!bridgeLeadId ? (
                                        <p
                                            className="text-xs py-2 px-1"
                                            style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                        >
                                            Select a lead session first.
                                        </p>
                                    ) : bridgeWorkerEligible.length === 0 ? (
                                        <p
                                            className="text-xs py-2 px-1"
                                            style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                        >
                                            No other running sessions available as workers.
                                        </p>
                                    ) : (
                                        <div className="flex flex-col gap-1.5 max-h-[150px] overflow-y-auto" role="group" aria-label="Worker sessions">
                                            {bridgeWorkerEligible.map((s) => {
                                                const isChecked = bridgeWorkerIds.has(s.id);
                                                const busyReason = busyTerminalIds.get(s.terminalId);
                                                const isBusy = Boolean(busyReason);
                                                return (
                                                    <PickerRow
                                                        key={s.id}
                                                        shape="checkbox"
                                                        checked={isChecked}
                                                        disabled={isBusy}
                                                        onClick={() => toggleBridgeWorker(s.id)}
                                                        accent="var(--cc-waiting, #e0b060)"
                                                        name={s.name}
                                                        model={s.model}
                                                        activityState={s.activityState}
                                                        busy={isBusy}
                                                        busyReason={busyReason}
                                                    />
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                {/* Kickoff prompt */}
                                <div>
                                    <label
                                        htmlFor="bridge-topic"
                                        className="cc-label block mb-1"
                                        style={{ color: "var(--cc-muted, var(--text-muted))" }}
                                    >
                                        Objective
                                    </label>
                                    <textarea
                                        id="bridge-topic"
                                        ref={firstFieldRef}
                                        rows={4}
                                        value={bridgeTopic}
                                        onChange={(e) => setBridgeTopic(e.target.value)}
                                        onKeyDown={(e) => e.stopPropagation()}
                                        placeholder="What are these sessions working on together? The lead breaks this down and assigns it."
                                        className="w-full px-3 py-2 rounded-lg text-xs outline-none resize-none"
                                        style={{
                                            backgroundColor: "var(--cc-term, var(--bg-surface))",
                                            color: "var(--cc-fg, var(--text-primary))",
                                            border: "1px solid var(--cc-border, var(--border-color))",
                                            fontFamily: "inherit",
                                            lineHeight: 1.5,
                                        }}
                                    />
                                </div>

                                {/* Round cap stepper */}
                                <div className="flex items-center justify-between">
                                    <div className="flex flex-col" style={{ gap: 1 }}>
                                        <span className="text-xs font-semibold" style={{ color: "var(--cc-fg, var(--text-primary))" }}>
                                            Round cap
                                        </span>
                                        <span className="text-[10px]" style={{ color: "var(--cc-muted, var(--text-muted))" }}>
                                            Pause and ask you after this many messages
                                        </span>
                                    </div>
                                    <Stepper
                                        value={bridgeMaxRounds}
                                        min={1}
                                        max={20}
                                        onDec={() => setBridgeMaxRounds((v) => Math.max(1, v - 1))}
                                        onInc={() => setBridgeMaxRounds((v) => Math.min(20, v + 1))}
                                    />
                                </div>

                                {/* Confirm gate */}
                                {!bridgeConfirmed ? (
                                    <div>
                                        <div
                                            style={{
                                                ...NEON_PANEL_SMALL_STYLE,
                                                background: "color-mix(in srgb, var(--cc-waiting, #e0b060) 16%, var(--cc-surface, var(--bg-elevated)))",
                                                border: "1px solid color-mix(in srgb, var(--cc-waiting, #e0b060) 45%, transparent)",
                                                boxShadow: "0 0 18px color-mix(in srgb, var(--cc-waiting, #e0b060) 25%, transparent)",
                                            }}
                                            role="alert"
                                        >
                                            <div className="flex items-start gap-2">
                                                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: "1px", color: "var(--cc-waiting, #e0b060)" }} />
                                                <span>
                                                    This will start an autonomous loop across{" "}
                                                    {bridgeWorkerIds.size > 0
                                                        ? `1 lead + ${bridgeWorkerIds.size} worker${bridgeWorkerIds.size > 1 ? "s" : ""}`
                                                        : "multiple sessions"}
                                                    . Confirm to enable the Start button.
                                                </span>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setBridgeConfirmed(true)}
                                            className="w-full px-3 py-2 rounded-lg text-xs font-bold transition-colors"
                                            style={{
                                                backgroundColor: "transparent",
                                                color: "var(--cc-waiting, #e0b060)",
                                                border: "1px solid color-mix(in srgb, var(--cc-waiting, #e0b060) 60%, transparent)",
                                                cursor: "pointer",
                                            }}
                                        >
                                            I understand — confirm bridge
                                        </button>
                                    </div>
                                ) : (
                                    <div
                                        className="px-3 py-2 rounded-lg text-xs"
                                        style={{
                                            border: "1px solid var(--cc-border, var(--border-color))",
                                            color: "var(--cc-muted, var(--text-muted))",
                                            backgroundColor: "var(--cc-term, var(--bg-surface))",
                                        }}
                                    >
                                        Confirmed. Click Start Bridge to proceed.
                                        <button
                                            type="button"
                                            onClick={() => setBridgeConfirmed(false)}
                                            className="ml-2 underline"
                                            style={{ color: "var(--cc-muted, var(--text-muted))", background: "none", border: "none" }}
                                        >
                                            Undo
                                        </button>
                                    </div>
                                )}

                                {/* Error display */}
                                {bridgeError && (
                                    <div
                                        className="px-3 py-2 rounded-lg text-xs"
                                        style={{
                                            border: "1px solid var(--cc-error, #e0698a)",
                                            color: "var(--cc-error, #e0698a)",
                                            backgroundColor: "color-mix(in srgb, var(--cc-error, #e0698a) 10%, transparent)",
                                        }}
                                    >
                                        {bridgeError}
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Bridge tab footer */}
                    {tab === "bridge" && (
                        <div
                            className="flex items-center justify-between gap-2"
                            style={{
                                padding: "14px 18px",
                                borderTop: "1px solid var(--cc-line, var(--border-color))",
                                background: "color-mix(in srgb, var(--cc-bg, var(--bg-primary)) 40%, transparent)",
                            }}
                        >
                            <>
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors"
                                        style={{
                                            color: "var(--cc-dim, var(--text-muted))",
                                            border: "1px solid var(--cc-border, var(--border-color))",
                                            background: "none",
                                        }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        disabled={bridgeStartDisabled}
                                        onClick={handleStartBridge}
                                        className="px-3.5 py-2 rounded-lg text-xs font-bold transition-colors"
                                        style={{
                                            backgroundColor: bridgeStartDisabled
                                                ? "var(--cc-elev, var(--bg-surface))"
                                                : "var(--cc-waiting, #e0b060)",
                                            color: bridgeStartDisabled
                                                ? "var(--cc-muted, var(--text-muted))"
                                                : "#0f1216",
                                            cursor: bridgeStartDisabled ? "not-allowed" : "pointer",
                                            border: bridgeStartDisabled
                                                ? "1px solid var(--cc-border, var(--border-color))"
                                                : "1px solid color-mix(in srgb, var(--cc-waiting, #e0b060) 60%, white)",
                                            boxShadow: bridgeStartDisabled
                                                ? "none"
                                                : "0 0 12px color-mix(in srgb, var(--cc-waiting, #e0b060) 45%, transparent)",
                                        }}
                                    >
                                        {submitting ? (
                                            <span className="flex items-center gap-1.5">
                                                <Loader size={11} className="state-icon-spin" />
                                                Starting...
                                            </span>
                                        ) : (
                                            "Start Bridge"
                                        )}
                                    </button>
                            </>
                        </div>
                    )}

                    {/* Manual tab footer */}
                    {tab === "manual" && (
                        <div
                            className="flex items-center justify-between gap-2"
                            style={{
                                padding: "14px 18px",
                                borderTop: "1px solid var(--cc-line, var(--border-color))",
                                background: "color-mix(in srgb, var(--cc-bg, var(--bg-primary)) 40%, transparent)",
                            }}
                        >
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors"
                                style={{
                                    color: "var(--cc-dim, var(--text-muted))",
                                    border: "1px solid var(--cc-border, var(--border-color))",
                                    background: "none",
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={manualSendDisabled}
                                onClick={handleSendManual}
                                className="px-3.5 py-2 rounded-lg text-xs font-bold transition-colors"
                                style={{
                                    backgroundColor: manualSendDisabled
                                        ? "var(--cc-elev, var(--bg-surface))"
                                        : "var(--cc-error, #e0698a)",
                                    color: manualSendDisabled
                                        ? "var(--cc-muted, var(--text-muted))"
                                        : "#0f1216",
                                    cursor: manualSendDisabled ? "not-allowed" : "pointer",
                                    border: manualSendDisabled
                                        ? "1px solid var(--cc-border, var(--border-color))"
                                        : "none",
                                }}
                            >
                                {submitting ? (
                                    <span className="flex items-center gap-1.5">
                                        <Loader size={11} className="state-icon-spin" />
                                        Sending...
                                    </span>
                                ) : receiverSession ? (
                                    `Send to "${receiverSession.name}"`
                                ) : (
                                    "Send"
                                )}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
