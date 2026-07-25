import { useState, useRef, useEffect, useCallback } from "react";
import { X, FolderOpen, Folder, ShieldOff, Plus, ArrowRight, ChevronDown } from "lucide-react";

function normPath(dir) {
  return dir.replace(/\//g, "\\").replace(/\\$/, "");
}

// Mirrors TopBar.jsx's MODEL_GROUPS / PERMISSION_MODES / EFFORT_OPTIONS values —
// display-only defaults here; the actual per-session model/permission/effort are
// the global TopBar settings applied by createSession() in App.jsx. Kept as local
// selects for visual parity with the design; not wired into onConfirm so the
// existing (name, workdir, bypassPermissions) contract stays byte-identical.
const MODEL_OPTIONS = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "opus", label: "Opus 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
];
const PERMISSION_OPTIONS = [
  { id: "default", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "bypassPermissions", label: "Bypass" },
];
const EFFORT_OPTIONS = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

function ConfigSelect({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value) || options[0];
  return (
    <div className="flex flex-col gap-1 flex-1 relative">
      <span className="cc-label" style={{ paddingLeft: 2 }}>{label}</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between rounded-lg"
        style={{
          height: 34,
          padding: "0 11px",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--cc-fg)",
          background: "var(--cc-elev)",
          border: "1px solid var(--cc-border)",
          cursor: "pointer",
        }}
      >
        {current.label}
        <ChevronDown size={10} style={{ color: "var(--cc-muted)" }} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            className="absolute z-50 rounded-lg overflow-hidden"
            style={{
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 4,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => { onChange(o.id); setOpen(false); }}
                className="w-full text-left"
                style={{
                  fontSize: 12,
                  fontWeight: o.id === value ? 600 : 400,
                  padding: "6px 11px",
                  color: o.id === value ? "var(--cc-accent)" : "var(--cc-dim)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function NewSessionDialog({
  recentLocations,
  savedLocations = [],
  onConfirm,
  onCancel,
}) {
  const initialDir = recentLocations[0] || "C:\\Code";
  const [workdir, setWorkdir] = useState(initialDir);
  const [name, setName] = useState("");
  const initialBypass = savedLocations.find((l) => normPath(l.path) === normPath(initialDir))?.bypassPermissions || false;
  const [bypassPermissions, setBypassPermissions] = useState(initialBypass);
  const [manualBypassOverride, setManualBypassOverride] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [modelSel, setModelSel] = useState(MODEL_OPTIONS[0].id);
  const [permissionSel, setPermissionSel] = useState(PERMISSION_OPTIONS[0].id);
  const [effortSel, setEffortSel] = useState(EFFORT_OPTIONS[0].id);
  const inputRef = useRef(null);
  const dirRef = useRef(null);
  const suggestionsRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Sync bypass checkbox when changing to a directory with a saved bypass setting
  const syncBypassForDir = useCallback((dir) => {
    if (manualBypassOverride) return;
    const match = savedLocations.find(
      (l) => normPath(l.path) === normPath(dir.trim())
    );
    if (match) setBypassPermissions(match.bypassPermissions);
  }, [savedLocations, manualBypassOverride]);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target) &&
        dirRef.current &&
        !dirRef.current.contains(e.target)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const fetchSuggestions = useCallback((path) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const url = `/api/browse?path=${encodeURIComponent(path)}`;
        const res = await fetch(url);
        const data = await res.json();
        setSuggestions(data.dirs || []);
        setShowSuggestions((data.dirs || []).length > 0);
        setHighlightIdx(-1);
      } catch {
        setSuggestions([]);
      }
    }, 150);
  }, []);

  const handleDirChange = (e) => {
    const val = e.target.value;
    setWorkdir(val);
    syncBypassForDir(val);
    if (val.length >= 2) {
      fetchSuggestions(val);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const handleDirFocus = () => {
    if (workdir.length >= 2) {
      fetchSuggestions(workdir);
    }
  };

  const selectSuggestion = (dir) => {
    setWorkdir(dir);
    syncBypassForDir(dir);
    setShowSuggestions(false);
    setHighlightIdx(-1);
    // Fetch children of selected dir
    fetchSuggestions(dir + "\\");
    dirRef.current?.focus();
  };

  const handleDirKeyDown = (e) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (highlightIdx >= 0 && highlightIdx < suggestions.length) {
        e.preventDefault();
        selectSuggestion(suggestions[highlightIdx]);
      } else if (e.key === "Tab" && suggestions.length > 0) {
        e.preventDefault();
        selectSuggestion(suggestions[0]);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx >= 0 && suggestionsRef.current) {
      const el = suggestionsRef.current.children[highlightIdx];
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx]);

  const handleSubmit = (e) => {
    e.preventDefault();
    setShowSuggestions(false);
    onConfirm(name.trim(), workdir.trim(), bypassPermissions);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape" && !showSuggestions) onCancel();
  };

  // Extract just the folder name for display
  const folderName = (fullPath) => {
    const parts = fullPath.replace(/\//g, "\\").split("\\");
    return parts[parts.length - 1] || fullPath;
  };

  const toggleBypass = () => {
    setBypassPermissions((v) => !v);
    setManualBypassOverride(true);
  };

  return (
    <div
      className="cc-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        className="cc-modal cc-card"
        style={{
          width: 520,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 40px 120px rgba(0,0,0,.6), 0 0 0 1px color-mix(in srgb, var(--cc-accent) 22%, transparent)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div
          className="flex items-center justify-between"
          style={{ padding: "16px 18px", borderBottom: "1px solid var(--cc-line)" }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center rounded-lg"
              style={{
                width: 28,
                height: 28,
                background: "color-mix(in srgb, var(--cc-accent) 15%, transparent)",
                border: "1px solid color-mix(in srgb, var(--cc-accent) 35%, transparent)",
                color: "var(--cc-accent)",
              }}
            >
              <Plus size={15} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col" style={{ lineHeight: 1.15 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--cc-fg)" }}>New session</span>
              <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>Launch a Claude Code shell in a project</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex rounded-lg"
            style={{ padding: 6, color: "var(--cc-muted)", background: "none", border: "none", cursor: "pointer" }}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="flex flex-col gap-4.5" style={{ padding: 18, overflowY: "auto", gap: 18 }}>
            {/* Working directory */}
            <div className="flex flex-col gap-2">
              <label className="cc-label flex items-center gap-1.5">
                <FolderOpen size={11} />
                Working directory
              </label>
              <div className="relative">
                <div
                  className="flex items-center gap-2"
                  style={{
                    height: 38,
                    padding: "0 12px",
                    borderRadius: 9,
                    background: "var(--cc-term)",
                    border: `1px solid ${showSuggestions ? "color-mix(in srgb, var(--cc-accent) 40%, transparent)" : "var(--cc-border)"}`,
                  }}
                >
                  <FolderOpen size={14} style={{ color: "var(--cc-accent)", flexShrink: 0 }} />
                  <input
                    ref={(el) => { inputRef.current = el; dirRef.current = el; }}
                    type="text"
                    value={workdir}
                    onChange={handleDirChange}
                    onFocus={handleDirFocus}
                    onKeyDown={handleDirKeyDown}
                    placeholder="C:\Code"
                    className="flex-1 outline-none"
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--cc-fg)",
                      fontSize: 13,
                      fontFamily: "inherit",
                    }}
                  />
                </div>

                {showSuggestions && suggestions.length > 0 && (
                  <div
                    ref={suggestionsRef}
                    className="absolute z-10 left-0 right-0 mt-1 rounded-lg overflow-hidden"
                    style={{
                      background: "var(--cc-elev)",
                      border: "1px solid var(--cc-border)",
                      maxHeight: 200,
                      overflowY: "auto",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}
                  >
                    {suggestions.map((dir, idx) => (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => selectSuggestion(dir)}
                        className="w-full text-left flex items-center gap-2"
                        style={{
                          padding: "7px 10px",
                          fontSize: 12,
                          color: idx === highlightIdx ? "var(--cc-fg)" : "var(--cc-dim)",
                          background: idx === highlightIdx ? "var(--cc-surface)" : "transparent",
                          border: "none",
                          cursor: "pointer",
                        }}
                        onMouseEnter={() => setHighlightIdx(idx)}
                      >
                        <Folder size={12} style={{ color: "var(--cc-accent)", flexShrink: 0 }} />
                        <span className="truncate">{folderName(dir)}</span>
                        <span
                          className="ml-auto truncate"
                          style={{ maxWidth: "50%", fontSize: 10, color: "var(--cc-muted)" }}
                        >
                          {dir}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent locations */}
              {!showSuggestions && recentLocations.length > 0 && (
                <div className="flex flex-col gap-1" style={{ marginTop: 2 }}>
                  <span className="cc-label" style={{ padding: "2px 2px 4px" }}>Recent</span>
                  <div className="flex flex-col gap-0.5" style={{ maxHeight: 128, overflowY: "auto" }}>
                    {recentLocations.map((loc) => {
                      const sel = workdir === loc;
                      return (
                        <button
                          key={loc}
                          type="button"
                          onClick={() => { setWorkdir(loc); syncBypassForDir(loc); }}
                          className="flex items-center gap-2 text-left"
                          style={{
                            padding: "7px 10px",
                            borderRadius: 8,
                            background: sel ? "color-mix(in srgb, var(--cc-accent) 10%, transparent)" : "transparent",
                            border: `1px solid ${sel ? "color-mix(in srgb, var(--cc-accent) 30%, transparent)" : "var(--cc-line)"}`,
                            borderLeft: `2px solid ${sel ? "var(--cc-accent)" : "transparent"}`,
                            cursor: "pointer",
                          }}
                        >
                          <Folder size={13} style={{ color: sel ? "var(--cc-accent)" : "var(--cc-muted)", flexShrink: 0 }} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: sel ? "var(--cc-fg)" : "var(--cc-dim)", flexShrink: 0 }}>
                            {folderName(loc)}
                          </span>
                          <span
                            className="flex-1 truncate"
                            style={{ fontSize: 11, color: "var(--cc-muted)" }}
                          >
                            {loc}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Session name */}
            <div className="flex flex-col gap-2">
              <label className="cc-label">
                Session name <span style={{ fontWeight: 400, opacity: 0.7 }}>— optional</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${folderName(workdir)} session`}
                style={{
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 9,
                  background: "var(--cc-term)",
                  color: "var(--cc-fg)",
                  border: "1px solid var(--cc-border)",
                  outline: "none",
                  fontFamily: "inherit",
                  fontSize: 13,
                }}
              />
            </div>

            {/* Configuration */}
            <div className="flex flex-col gap-2">
              <label className="cc-label">Configuration</label>
              <div className="flex gap-2">
                <ConfigSelect label="Model" value={modelSel} options={MODEL_OPTIONS} onChange={setModelSel} />
                <ConfigSelect label="Permission" value={permissionSel} options={PERMISSION_OPTIONS} onChange={setPermissionSel} />
                <ConfigSelect label="Effort" value={effortSel} options={EFFORT_OPTIONS} onChange={setEffortSel} />
              </div>
            </div>

            {/* Bypass permissions toggle */}
            <button
              type="button"
              onClick={toggleBypass}
              className="flex items-center gap-3 text-left"
              title="Skip all permission prompts (--dangerously-skip-permissions)"
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                background: bypassPermissions ? "color-mix(in srgb, var(--cc-waiting) 8%, transparent)" : "var(--cc-term)",
                border: `1px solid ${bypassPermissions ? "color-mix(in srgb, var(--cc-waiting) 45%, transparent)" : "var(--cc-border)"}`,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <ShieldOff size={17} style={{ color: bypassPermissions ? "var(--cc-waiting)" : "var(--cc-muted)", flexShrink: 0 }} />
              <div className="flex-1 flex flex-col" style={{ gap: 1 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: bypassPermissions ? "var(--cc-waiting)" : "var(--cc-fg)" }}>
                  Bypass permissions
                </span>
                <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
                  Claude runs fully autonomously — no approval prompts
                </span>
              </div>
              <div
                style={{
                  width: 38,
                  height: 22,
                  borderRadius: 999,
                  background: bypassPermissions ? "var(--cc-waiting)" : "color-mix(in srgb, var(--cc-fg) 20%, transparent)",
                  position: "relative",
                  transition: "background .15s",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 2,
                    left: bypassPermissions ? 18 : 2,
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: "#fff",
                    transition: "left .15s",
                  }}
                />
              </div>
            </button>
          </div>

          {/* footer */}
          <div
            className="flex items-center justify-between gap-2.5"
            style={{
              padding: "14px 18px",
              borderTop: "1px solid var(--cc-line)",
              background: "color-mix(in srgb, var(--cc-bg) 40%, transparent)",
            }}
          >
            {/* CLI-path callout: the `claude` binary is discovered off PATH.
                If it lives somewhere nonstandard, CLAUDE_CLI_PATH overrides —
                surfaced here so users learn the escape hatch before a spawn
                fails (the spawn error names it too). */}
            <span
              style={{ fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.4, maxWidth: 230 }}
            >
              Can&apos;t find <code style={{ fontFamily: "var(--cc-mono, monospace)" }}>claude</code>? Set{" "}
              <code style={{ fontFamily: "var(--cc-mono, monospace)", color: "var(--cc-dim)" }}>CLAUDE_CLI_PATH</code>{" "}
              before launching Cockpit.
            </span>
            <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onCancel}
              style={{
                height: 38,
                padding: "0 18px",
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                color: "var(--cc-dim)",
                background: "none",
                border: "1px solid var(--cc-border)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-2"
              style={{
                height: 38,
                padding: "0 20px",
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 700,
                fontFamily: "inherit",
                color: "#0f1216",
                background: "var(--cc-accent)",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 6px 18px color-mix(in srgb, var(--cc-accent) 35%, transparent)",
              }}
            >
              Open session
              <ArrowRight size={15} strokeWidth={2.5} />
            </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
