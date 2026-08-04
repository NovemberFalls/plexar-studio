/**
 * ProvidersSettings — the Settings ▸ Providers & Endpoints page (Phase 4).
 *
 * INTENT, NOT A DASHBOARD. Every editable value is a draft field owned by the
 * Settings shell and written through `setField(dottedPath, value)`; nothing is
 * kept in local component state or localStorage. The shell owns saving, so this
 * page renders no save button.
 *
 * Live data is read-only, best-effort, and fetched ONCE on mount (plus on an
 * explicit "Test" click) — never on an interval:
 *   GET /api/local/providers        → capability chips + which backends exist
 *   GET /api/local/status           → lane-broker identity fingerprint + managed
 *   GET /api/local/{id}/health      → per-backend reachability pill
 *   GET /api/local/vllm/ownership   → who owns vLLM, and whether a saved
 *                                     "Managed by Cockpit" is waiting on a restart
 *   GET|POST|DELETE /api/settings/openrouter → the OpenRouter key (masked only)
 *
 * The OpenRouter card ABSORBS OpenRouterModal.jsx: same three routes, same
 * masking contract (the server never returns a full key, and the paste field
 * only ever holds what the user is typing right now).
 *
 * Deliberately inert controls (honest gaps, not fake affordances):
 *   - every `Browse` button unless the caller passes `onBrowse` (native folder
 *     picker lands with Phase 9)
 *   - vLLM `Start engine` (there is no start-on-demand endpoint: Cockpit starts
 *     its own container during Cockpit startup, and must never start or stop one
 *     it does not own. The card says so in prose, not only in a tooltip.)
 *   - each card's `Ellipsis` overflow button (no menu actions exist yet)
 *   - Claude CLI detected version (no detection endpoint; backlog 03)
 *
 * Props (pinned by the Settings shell):
 *   get(dottedPath, fallback) → current DRAFT value
 *   setField(dottedPath, value) → record an unsaved edit
 *   isDirty(dottedPath) → bool; true fields highlight in --cc-waiting
 *   onBrowse(dottedPath) → optional; enables the Browse buttons when supplied
 */

import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  Cloud,
  Cpu,
  Ellipsis,
  Eye,
  EyeOff,
  FolderOpen,
  Layers,
  Route,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import SpillPolicy from "./SpillPolicy";

// ── tokens / shared style fragments ───────────────────────
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const DIRTY = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

/**
 * The half-width pair. Three rows on this page are two blocks side by side:
 * lane broker + spill policy, LM Studio + vLLM, Ollama + OpenRouter.
 *
 * It is one constant rather than three inline objects because the owner's
 * instruction was about the PAGE, not about one row: nothing here earns the
 * full column on its own, and a card that is wide for no reason reads as more
 * important than its neighbours. `minWidth: 0` on the track is load-bearing —
 * without it a grid child with its own horizontal scroller (spill policy) will
 * refuse to shrink and push the page sideways instead.
 */
const PAIR = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
  minWidth: 0,
  alignItems: "start",
};

const LABEL = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

const FIELD_GRID = {
  display: "grid",
  gridTemplateColumns: "200px 1fr 108px",
  gap: 8,
  alignItems: "center",
  padding: "6px 0",
};

// The full capability vocabulary the broker contract defines. A provider that
// does not declare one renders its chip dimmed rather than hiding it — the
// absence is the information.
// The chip vocabulary MUST cover every capability the server actually emits, or a
// provider advertising one gets no chip for it and the row reads as "not supported"
// when it is. server.py emits model-discovery (vllm-local) and appends
// model-control (lmstudio-local when the `lms` CLI resolves, vllm-local always) —
// both were missing here, which hid the very capability the vLLM models-folder
// section is gated on.
const ALL_CAPABILITIES = [
  "models", "model-control", "model-discovery", "health", "queue", "metrics", "spill", "traces",
];

/** Cockpit's expected Claude CLI binary name — anything else earns a warning callout. */
const EXPECTED_CLI = "claude";

// ── primitives ────────────────────────────────────────────

function SectionTitle({ children, note }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
      <span style={{ ...LABEL, fontSize: 10, color: "var(--cc-fg)" }}>{children}</span>
      {note && (
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>{note}</span>
      )}
    </div>
  );
}

/** Status pill: a dot + text, tinted by a state token. */
function Pill({ token, children, title, testId }) {
  return (
    <span
      data-testid={testId}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 20,
        padding: "0 8px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 5, height: 5, borderRadius: 999, background: token, flexShrink: 0 }}
      />
      {children}
    </span>
  );
}

/** Small neutral badge (kind label, "Default", model counts). */
function Badge({ children, token = "var(--cc-dim)" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 18,
        padding: "0 7px",
        borderRadius: 7,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 30)}`,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/** 108px action button that lives in the third grid column. */
function ActionButton({ label, onClick, disabled, title, accent, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      className="rounded transition-colors hover-bg-elevated"
      style={{
        width: "100%",
        height: 26,
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 7,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: accent && !disabled ? ACCENT_FG : "var(--cc-fg)",
        border: `1px solid ${accent && !disabled ? "transparent" : "var(--cc-border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

/** The 22px square kind badge shown at the left of each backend card header. */
function KindIcon({ icon: Icon, token }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        borderRadius: 7,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 30)}`,
        flexShrink: 0,
      }}
    >
      <Icon size={12} />
    </span>
  );
}

/** Overflow affordance. Deliberately inert — no card-level menu actions exist. */
function OverflowButton({ name }) {
  return (
    <button
      type="button"
      disabled
      data-testid={`overflow-${name}`}
      aria-label={`More ${name} actions`}
      title="No overflow actions yet — card-level actions arrive with a later phase"
      className="rounded"
      style={{
        width: 22,
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 7,
        background: "none",
        border: "1px solid var(--cc-border)",
        color: "var(--cc-muted)",
        opacity: 0.5,
        cursor: "not-allowed",
        flexShrink: 0,
      }}
    >
      <Ellipsis size={12} />
    </button>
  );
}

function CardHeader({ icon, token, name, children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        paddingBottom: 10,
        marginBottom: 4,
        borderBottom: "1px solid var(--cc-line)",
      }}
    >
      {icon && <KindIcon icon={icon} token={token} />}
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>{name}</span>
      {children}
    </div>
  );
}

/** label / control / action row. */
function FieldRow({ label, hint, action, children }) {
  return (
    <div style={FIELD_GRID}>
      <div style={{ minWidth: 0 }}>
        <div style={LABEL}>{label}</div>
        {hint && (
          <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 2 }}>{hint}</div>
        )}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
      <div>{action ?? null}</div>
    </div>
  );
}

/**
 * A draft text field. The value lives in the Settings draft (via get/setField)
 * — never in local state — so the shell's dirty tracking and save are authoritative.
 */
function SettingText({ label, path, get, setField, isDirty, placeholder, hint, action, mono }) {
  const dirty = Boolean(isDirty?.(path));
  return (
    <FieldRow label={label} hint={hint} action={action}>
      <input
        type="text"
        value={get(path, "") ?? ""}
        onChange={(e) => setField(path, e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        data-testid={`field-${path}`}
        data-dirty={dirty ? "true" : "false"}
        className="w-full rounded"
        style={{
          height: 26,
          padding: "0 8px",
          fontSize: 11,
          fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
          borderRadius: 7,
          background: "var(--cc-elev)",
          border: `1px solid ${dirty ? DIRTY : "var(--cc-border)"}`,
          color: dirty ? DIRTY : "var(--cc-fg)",
          outline: "none",
        }}
      />
    </FieldRow>
  );
}

/** A draft boolean rendered as a two-segment switch. */
function SettingToggle({ label, path, get, setField, isDirty, hint, title, onLabel = "On", offLabel = "Off" }) {
  const dirty = Boolean(isDirty?.(path));
  const on = Boolean(get(path, false));
  const segment = (active, text, next) => (
    <button
      key={text}
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${label}: ${text}`}
      onClick={() => setField(path, next)}
      className="transition-colors hover-bg-surface"
      style={{
        height: 22,
        padding: "0 10px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        border: "none",
        background: active ? "var(--cc-accent)" : "transparent",
        color: active ? ACCENT_FG : "var(--cc-dim)",
        cursor: "pointer",
      }}
    >
      {text}
    </button>
  );
  return (
    <FieldRow label={label} hint={hint}>
      <div
        role="radiogroup"
        aria-label={label}
        title={title}
        data-testid={`field-${path}`}
        data-dirty={dirty ? "true" : "false"}
        style={{
          display: "inline-flex",
          overflow: "hidden",
          borderRadius: 8,
          background: "var(--cc-elev)",
          border: `1px solid ${dirty ? DIRTY : "var(--cc-border)"}`,
        }}
      >
        {segment(!on, offLabel, false)}
        {segment(on, onLabel, true)}
      </div>
    </FieldRow>
  );
}

/** A draft numeric slider. */
function SettingSlider({ label, path, get, setField, isDirty, min, max, step, fallback, format, hint }) {
  const dirty = Boolean(isDirty?.(path));
  const raw = get(path, fallback);
  const value = typeof raw === "number" && !Number.isNaN(raw) ? raw : fallback;
  return (
    <FieldRow label={label} hint={hint}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setField(path, Number(e.target.value))}
          aria-label={label}
          data-testid={`field-${path}`}
          data-dirty={dirty ? "true" : "false"}
          style={{
            flex: 1,
            minWidth: 0,
            accentColor: dirty ? DIRTY : "var(--cc-accent)",
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            minWidth: 40,
            textAlign: "right",
            color: dirty ? DIRTY : "var(--cc-fg)",
          }}
        >
          {format ? format(value) : value}
        </span>
      </div>
    </FieldRow>
  );
}

/** Capability chips — declared caps solid, undeclared dimmed to .5. */
function CapabilityChips({ capabilities }) {
  const have = new Set(Array.isArray(capabilities) ? capabilities : []);
  return (
    <FieldRow label="Capabilities" hint="Dimmed = not offered by this backend">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {ALL_CAPABILITIES.map((cap) => {
          const present = have.has(cap);
          return (
            <span
              key={cap}
              data-testid={`cap-${cap}`}
              data-present={present ? "true" : "false"}
              title={present ? `${cap} available` : `${cap} not offered by this backend`}
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                padding: "2px 7px",
                borderRadius: 999,
                color: present ? "var(--cc-accent)" : "var(--cc-muted)",
                background: present ? tint("var(--cc-accent)", 8) : "transparent",
                border: `1px solid ${present ? tint("var(--cc-accent)", 30) : "var(--cc-border)"}`,
                opacity: present ? 1 : 0.5,
              }}
            >
              {cap}
            </span>
          );
        })}
      </div>
    </FieldRow>
  );
}

/**
 * Browse — inert unless the shell supplies onBrowse. There is no folder-picker
 * endpoint wired for these fields yet (Phase 9); a disabled button that says so
 * is honest, a button that opens nothing is not.
 */
function BrowseButton({ path, onBrowse }) {
  const enabled = typeof onBrowse === "function";
  return (
    <ActionButton
      label="Browse"
      testId={`browse-${path}`}
      onClick={enabled ? () => onBrowse(path) : undefined}
      disabled={!enabled}
      title={
        enabled
          ? "Choose a path"
          : "Inert for now — the native folder picker arrives with the folder browser (Phase 9)"
      }
    />
  );
}

/**
 * The one-line qualifier that must accompany any pill whose meaning depends on
 * a base URL the user has edited but not saved. Probing hits the SAVED url the
 * server is using, so an unqualified green pill next to an edited field reads as
 * "Cockpit told me this URL was fine" — a lie about the screen even when it is
 * true about the system. We qualify the pill; we never blank it.
 */
function StaleUrlNote({ name }) {
  return (
    <div
      data-testid={`stale-url-${name}`}
      role="note"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        marginTop: 4,
        fontSize: 11,
        lineHeight: 1.5,
        color: DIRTY,
      }}
    >
      <TriangleAlert size={12} style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        Unsaved URL — the status above still reflects the saved URL the server is using.
        Save to test the edited value.
      </span>
    </div>
  );
}

/** Title used on every Test button that is blocked by an unsaved URL. */
const STALE_TEST_TITLE =
  "Save changes first — Test probes the URL the server is currently using, not the edited value.";

/**
 * Per-card Test action. Disabled while that card's base URL is dirty, because
 * the probe cannot reach an unsaved URL (there is no probe-arbitrary-URL
 * endpoint, and inventing one is out of scope).
 */
function TestButton({ name, staleUrl, testing, onTest }) {
  return (
    <ActionButton
      label={testing && !staleUrl ? "Testing…" : "Test"}
      onClick={staleUrl ? undefined : onTest}
      disabled={staleUrl || testing}
      testId={`test-${name}`}
      title={staleUrl ? STALE_TEST_TITLE : "Re-probe this backend now"}
    />
  );
}

/**
 * Plain-English note for values that persist correctly but are NOT yet read by
 * the server (those paths are still env-var driven). A slider that saves cleanly
 * and changes nothing is a trap, so we say so rather than implying it is live.
 */
/** A control that persists cleanly and changes nothing.
 *
 *  `why` exists because the default sentence ("the running services still read
 *  this from their environment variables") is TRUE for most of these and FALSE
 *  for at least one: lane concurrency is read by no environment variable and no
 *  code path -- nothing consumes it anywhere. Telling a user to go look at an
 *  env var that does not exist is a second wrong turn on top of the first, so
 *  callers whose reason differs pass their own. */
function NotEnforcedNote({ name, what, why }) {
  return (
    <div
      data-testid={`not-enforced-${name}`}
      role="note"
      style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 4 }}
    >
      {what} is saved, but Cockpit does not apply it yet —{" "}
      {why || (
        <>
          the running services still read this from their environment variables. It takes
          effect when engine lifecycle control lands.
        </>
      )}
    </div>
  );
}

/**
 * VllmModelsFolderSection — the ONE frontend caller of
 * GET|PUT /api/local/{provider_id}/models-dir.
 *
 * Re-homed from the deleted LocalBrokerView's `ModelsFolderCard`. It is
 * deliberately NOT a draft field:
 *
 *   - The route applies and persists server-side the moment it returns
 *     (~/.claude-cockpit/vllm-models-dir.json, re-read at startup to build the
 *     managed container's docker -v bind mount). Routing it through setField
 *     would write a settings.json key nothing reads, and the container would
 *     never be configured — that is the exact regression this section closes.
 *   - So it owns its own value in local state and its own Save button, and the
 *     card says out loud that it applies immediately rather than on the shell's
 *     "Save changes". That asymmetry is real; hiding it is what makes it a trap.
 *
 * Capability-gated on `model-discovery`: LM Studio's catalog is already complete
 * via /api/v0/models, so only vLLM-local declares it and only vLLM-local gets
 * this section. Absent capability → the section does not render at all.
 *
 * Two honesty rules carried over verbatim in spirit:
 *   - a 400 renders the SERVER's message, not a generic failure — the server is
 *     the only thing that knows what is wrong with the path
 *   - a successful save does NOT mean the running container picked it up
 */
function VllmModelsFolderSection({ provider }) {
  const providerId = provider?.id || null;
  const supported =
    Boolean(providerId) &&
    Array.isArray(provider?.capabilities) &&
    provider.capabilities.includes("model-discovery");

  // Server truth: {path, mount_path, scan_path, exists, writable_config, current_model}
  const [current, setCurrent] = useState(null); // null = not read yet
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [modelsRefreshed, setModelsRefreshed] = useState(false);

  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;
    (async () => {
      const data = await safeGet(`/api/local/${encodeURIComponent(providerId)}/models-dir`);
      if (cancelled || !data) return;
      setCurrent(data);
      setInput(data.path || "");
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, providerId]);

  const save = async () => {
    if (saving) return;
    const path = (input || "").trim();
    setError(null);
    setSaved(false);
    setModelsRefreshed(false);
    if (!path) {
      setError("Enter a folder path first.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/models-dir`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Verbatim server text. It names what is wrong with the path (not
        // absolute / not a directory / too long) and that IS the whole value.
        setError(data?.error || "The server rejected this path but gave no reason.");
        return;
      }
      setCurrent(data);
      setInput(data.path || path);
      setSaved(true);
      // Changing the folder changes what is discoverable on disk, so re-read the
      // list once. A one-shot GET on the same route the page already uses — NOT
      // a second poller; useLocalModels owns the app-wide interval.
      const models = await safeGet(`/api/local/${encodeURIComponent(providerId)}/models`);
      if (models) setModelsRefreshed(true);
    } catch (err) {
      setError(`Could not reach Cockpit's server: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!supported) return null;

  const hasPath = Boolean(current?.path);
  const mountPath = current?.mount_path || null;
  const scanPath = current?.scan_path || null;
  const currentModel = current?.current_model || null;

  return (
    <div
      data-testid="vllm-models-dir"
      style={{ borderTop: "1px solid var(--cc-line)", marginTop: 10, paddingTop: 10 }}
    >
      <SectionTitle note="applies immediately — not on Save changes">Models Folder</SectionTitle>

      <FieldRow
        label="Host models folder"
        hint="Folder CONTAINING your model subfolders"
        action={
          <ActionButton
            label={saving ? "Saving…" : "Apply now"}
            onClick={save}
            disabled={saving}
            accent
            testId="vllm-models-dir-save"
            title="Writes straight to Cockpit's server and persists — this control does not use the page's Save changes button"
          />
        }
      >
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
            setSaved(false);
          }}
          placeholder="C:\models"
          spellCheck={false}
          autoComplete="off"
          aria-label="Host models folder"
          data-testid="vllm-models-dir-input"
          className="w-full rounded"
          style={{
            height: 26,
            padding: "0 8px",
            fontSize: 11,
            fontFamily: "var(--font-mono, monospace)",
            borderRadius: 7,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
            outline: "none",
            opacity: saving ? 0.6 : 1,
          }}
        />
      </FieldRow>

      {/* Server truth, read-only. Every field renders only when the server sent
          it — a missing mount_path shows nothing rather than an invented one. */}
      <div
        data-testid="vllm-models-dir-state"
        style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", padding: "4px 0 2px" }}
      >
        <div>
          <span style={{ color: "var(--cc-muted)" }}>configured path: </span>
          <span data-testid="vllm-models-dir-path">{hasPath ? current.path : "not set"}</span>
          {hasPath && (
            <span
              data-testid="vllm-models-dir-exists"
              style={{
                marginLeft: 6,
                fontWeight: 700,
                color: current.exists ? "var(--cc-idle)" : "var(--cc-error)",
              }}
            >
              {current.exists ? "exists" : "not found"}
            </span>
          )}
        </div>
        {mountPath && (
          <div data-testid="vllm-models-dir-mount">
            <span style={{ color: "var(--cc-muted)" }}>mounted in container at: </span>
            {mountPath}
          </div>
        )}
        {scanPath && (
          <div data-testid="vllm-models-dir-scan">
            <span style={{ color: "var(--cc-muted)" }}>scanned by Cockpit at: </span>
            {scanPath}
          </div>
        )}
        {currentModel && (
          <div data-testid="vllm-models-dir-current-model">
            <span style={{ color: "var(--cc-muted)" }}>current model: </span>
            {currentModel}
          </div>
        )}
      </div>

      <Callout token="var(--cc-accent)" icon={FolderOpen} testId="vllm-models-dir-immediate">
        This path is the one control on this page that does <strong>not</strong> wait for
        <em> Save changes</em>. Apply now writes it to Cockpit&apos;s server and saves it to disk
        straight away, and it stays set across restarts. On Windows, models usually live inside
        WSL, so a path like <code>/home/&lt;you&gt;/models</code> is normal.
      </Callout>

      <Callout testId="vllm-models-dir-remount">
        A saved path does <strong>not</strong> reconfigure a vLLM container that is already
        running. The folder is mounted when the container starts, so if managed vLLM is serving
        right now, restart it before the new folder&apos;s models can be loaded.
      </Callout>

      {error && (
        <div
          role="alert"
          data-testid="vllm-models-dir-error"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: 9,
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--cc-error)",
            background: tint("var(--cc-error)", 8),
            border: `1px solid ${tint("var(--cc-error)", 35)}`,
          }}
        >
          <TriangleAlert size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {saved && !error && (
        <div
          role="note"
          data-testid="vllm-models-dir-saved"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-idle)", paddingTop: 6 }}
        >
          Saved and persisted.
          {modelsRefreshed
            ? " Model list re-read from the new folder."
            : " Cockpit could not re-read the model list just now — reopen Engine ▸ Models to retry."}
        </div>
      )}
    </div>
  );
}

/** Inline callout, used for honest "not wired yet" and mismatch warnings. */
function Callout({ token = DIRTY, icon: Icon = TriangleAlert, children, testId }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      <Icon size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

// ── live-data helpers ─────────────────────────────────────

/** Best-effort JSON GET. Returns null on any failure — callers render "unknown". */
async function safeGet(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // silent by convention: no console noise for background reads
  }
}

/**
 * `stale` = this backend's base URL has unsaved edits, so the probe result
 * describes the SAVED url. The pill is qualified ("· saved URL") and recolored
 * to --cc-waiting rather than blanked — the reading is still true, just not
 * about what is on screen.
 */
function reachabilityPill(health, testId, stale) {
  const q = (text) => (stale ? `${text} · saved URL` : text);
  const staleTitle = stale ? "Reflects the saved URL, not your edit. " : "";
  if (health === undefined) {
    return (
      <Pill token={stale ? DIRTY : "var(--cc-muted)"} testId={testId} title={staleTitle || undefined}>
        {q("checking")}
      </Pill>
    );
  }
  if (health === null) {
    return (
      <Pill
        token={stale ? DIRTY : "var(--cc-muted)"}
        testId={testId}
        title={`${staleTitle}Cockpit could not read this backend's health`}
      >
        {q("unknown")}
      </Pill>
    );
  }
  const up = Boolean(health?.provider?.reachable);
  return (
    <Pill
      token={stale ? DIRTY : up ? "var(--cc-idle)" : "var(--cc-error)"}
      testId={testId}
      title={`${staleTitle}${up ? "Backend answered a health probe" : "Backend did not answer"}`}
    >
      {q(up ? "reachable" : "unreachable")}
    </Pill>
  );
}

function modelCountText(health) {
  const n = health?.provider?.models_loaded;
  if (typeof n !== "number") return "models n/a";
  return `${n} loaded`;
}

// ── OpenRouter card (absorbs OpenRouterModal) ─────────────

function openRouterStatus(configured, source, masked) {
  if (!configured || !source) return "Not configured";
  const where = source === "env" ? "environment key" : "saved key";
  return masked ? `${where} ${masked}` : where;
}

function OpenRouterCard({ get, setField, isDirty }) {
  // Server-owned key state (never part of the Settings draft — it is written
  // through its own routes, exactly as OpenRouterModal did).
  const [configured, setConfigured] = useState(false);
  const [source, setSource] = useState(null);
  const [masked, setMasked] = useState(null);
  const [loaded, setLoaded] = useState(false);
  // Holds ONLY what the user is typing. Never seeded from the server.
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    const data = await safeGet("/api/settings/openrouter");
    if (data) {
      setConfigured(Boolean(data.configured));
      setSource(data.source ?? null);
      setMasked(data.masked ?? null);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    if (busy) return;
    if (!keyInput || /\s/.test(keyInput)) {
      setNotice("Key cannot be empty or contain whitespace.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setConfigured(true);
        setSource("ui");
        setMasked(data.masked ?? null);
        setKeyInput("");
      } else {
        setNotice(data.error || "Failed to save the key.");
      }
    } catch (err) {
      setNotice(`Could not reach the server: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/openrouter", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setConfigured(Boolean(data.configured));
        setSource(data.source ?? null);
        setMasked(data.masked ?? null);
      } else {
        setNotice(data.error || "Failed to remove the key.");
      }
    } catch (err) {
      setNotice(`Could not reach the server: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={CARD} data-testid="card-openrouter">
      <CardHeader icon={Cloud} token="var(--cc-macro)" name="OpenRouter">
        {configured ? (
          <Pill token="var(--cc-idle)" testId="openrouter-key-pill">Key saved</Pill>
        ) : (
          <Pill token="var(--cc-muted)" testId="openrouter-key-pill">
            {loaded ? "No key" : "checking"}
          </Pill>
        )}
        <span style={{ marginLeft: "auto" }} />
        <OverflowButton name="OpenRouter" />
      </CardHeader>

      <SettingToggle
        label="Enabled"
        path="providers.openrouter.enabled"
        get={get}
        setField={setField}
        isDirty={isDirty}
      />

      {/* Masked preview only — the server never returns a full key, and this
          field is not an input, so there is nothing to reveal. */}
      <FieldRow label="Current key">
        <span
          data-testid="openrouter-masked"
          style={{ fontSize: 11, color: "var(--cc-dim)", fontFamily: "var(--font-mono, monospace)" }}
        >
          {openRouterStatus(configured, source, masked)}
        </span>
      </FieldRow>

      <FieldRow
        label="Paste new key"
        hint={source === "ui" ? "Saving replaces the current key" : undefined}
        action={<ActionButton label={busy ? "Saving…" : "Save"} onClick={save} disabled={busy} accent />}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type={showKey ? "text" : "password"}
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setNotice(null);
            }}
            placeholder="sk-or-v1-…"
            autoComplete="off"
            spellCheck={false}
            aria-label="Paste new OpenRouter key"
            data-testid="openrouter-key-input"
            className="rounded"
            style={{
              flex: 1,
              minWidth: 0,
              height: 26,
              padding: "0 8px",
              fontSize: 11,
              borderRadius: 7,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? "Hide typed key" : "Show typed key"}
            aria-pressed={showKey}
            className="rounded transition-colors hover-bg-elevated"
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "none",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-dim)",
              flexShrink: 0,
            }}
          >
            {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      </FieldRow>

      {source === "ui" && (
        <FieldRow
          label="Remove key"
          hint="Deletes the key Cockpit stored"
          action={
            <ActionButton
              label={busy ? "Removing…" : "Remove"}
              onClick={remove}
              disabled={busy}
              testId="openrouter-remove"
            />
          }
        >
          <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>
            Cockpit stops routing through OpenRouter.
          </span>
        </FieldRow>
      )}

      {source === "env" && (
        <Callout token="var(--cc-accent)" icon={Cloud}>
          This key comes from the environment. Cockpit cannot remove it here — unset the
          environment variable instead.
        </Callout>
      )}

      {notice && <Callout testId="openrouter-notice">{notice}</Callout>}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function ProvidersSettings({ get, setField, isDirty, onBrowse }) {
  const [providers, setProviders] = useState(null); // null = not yet read
  const [status, setStatus] = useState(undefined); // undefined = checking, null = unknown
  const [latencyMs, setLatencyMs] = useState(null);
  const [health, setHealth] = useState({}); // providerId -> payload | null
  const [ownership, setOwnership] = useState(null); // vLLM ownership; null = unknown
  const [testing, setTesting] = useState(false);

  // No setState before the first await: the mount effect calls probe()
  // directly, and a synchronous setState in an effect body triggers cascading
  // renders (react-hooks/set-state-in-effect). The in-flight flag is owned by
  // handleTest, which is only ever reached from a user click.
  const probe = useCallback(async () => {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const [list, st, own] = await Promise.all([
      safeGet("/api/local/providers"),
      safeGet("/api/local/status"),
      // Who owns the vLLM process right now, and whether a save is waiting on a
      // Cockpit restart. The draft value of providers.vllm.managed cannot answer
      // that — it is intent, and the container is launched at startup.
      safeGet("/api/local/vllm/ownership"),
    ]);
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const rows = Array.isArray(list?.providers) ? list.providers : [];
    setProviders(rows);
    setStatus(st ?? null);
    setOwnership(own ?? null);
    setLatencyMs(st ? Math.max(0, Math.round(t1 - t0)) : null);

    const results = await Promise.all(
      rows
        .filter((p) => Array.isArray(p.capabilities) && p.capabilities.includes("health"))
        .map(async (p) => [p.id, await safeGet(`/api/local/${p.id}/health`)])
    );
    setHealth(Object.fromEntries(results));
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      await probe();
    } finally {
      setTesting(false);
    }
  }, [probe]);

  useEffect(() => {
    probe();
  }, [probe]);

  const rows = providers || [];
  const byKind = (kind) => rows.find((p) => p.kind === kind) || null;
  // The spill card hosts whichever backend declares the `spill` capability —
  // spill is a lane-broker feature, so in practice that is the broker-fronted
  // provider. Passed down as a prop rather than re-fetched so the page keeps
  // exactly one /api/local/providers read.
  const spillProvider = rows.find(
    (p) => Array.isArray(p.capabilities) && p.capabilities.includes("spill")
  ) || null;
  const lmStudio = byKind("lmstudio");
  const vllm = byKind("vllm");
  const ollama = byKind("ollama");
  const healthFor = (p) => (p ? health[p.id] : null);

  // Lane-broker health. /api/local/status returns
  // {reachable, compatible, service, detail, url, managed} — version/pid are
  // not in that contract today, so they render only if the server starts
  // sending them.
  const brokerToken =
    status === undefined
      ? "var(--cc-muted)"
      : status && status.reachable && status.compatible
        ? "var(--cc-idle)"
        : status && status.reachable
          ? DIRTY
          : "var(--cc-error)";
  const brokerText =
    status === undefined
      ? "checking"
      : status === null
        ? "unknown"
        : !status.reachable
          ? "offline"
          : status.compatible
            ? `online · ${latencyMs ?? "?"}ms`
            : "wrong service";

  // A probe can only ever hit the SAVED url — so any card whose base URL is
  // dirty must disable its Test button and qualify its pill.
  const staleUrl = (path) => Boolean(isDirty?.(path));
  const brokerStale = staleUrl("providers.lane_broker.base_url");
  const lmStudioStale = staleUrl("providers.lmstudio.base_url");
  const vllmStale = staleUrl("providers.vllm.base_url");

  // ── vLLM ownership ──────────────────────────────────────
  // "Managed by Cockpit" is INTENT; the container is launched during Cockpit
  // startup, so the draft (and even the saved value) can legitimately disagree
  // with what is running. GET /api/local/vllm/ownership is the only thing that
  // knows which of the three situations the user is actually in, and they need
  // different fixes:
  //   env_set          — COCKPIT_MANAGED_VLLM wins outright; this toggle is inert
  //   external         — someone else holds the port; a restart will NOT help
  //   pending_restart  — the save is real but dormant until Cockpit restarts
  const vllmOwned = ownership?.effective === true;
  const vllmExternalHoldsPort = ownership?.external === true;
  const vllmEnvPinned = ownership?.env_set === true;
  const vllmManagedDraft = get("providers.vllm.managed", false) === true;
  // Server-side pending (saved, not applied) OR a draft that disagrees with what
  // is in effect. Never "pending" when the env pins it or an external process
  // holds the port — in those cases restarting changes nothing.
  const vllmPendingRestart =
    ownership !== null &&
    !vllmExternalHoldsPort &&
    !vllmEnvPinned &&
    (ownership.pending_restart === true || vllmManagedDraft !== vllmOwned);
  const ollamaStale = staleUrl("providers.ollama.base_url");

  // The claude_cli.* derivations that lived here went with the card above.
  // Settings ▸ Claude CLI reads the REAL resolved path from GET /api/cli instead
  // of these settings keys, which nothing on the server ever consulted.

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      {/* ── Lane broker + spill policy — half-width pair ─ */}
      <div style={PAIR} data-testid="row-broker-spill">
      <div style={CARD} data-testid="card-lane-broker">
        <CardHeader icon={Route} token="var(--cc-accent)" name="Lane broker">
          <Pill
            token={brokerStale ? DIRTY : brokerToken}
            testId="broker-health"
            title={
              brokerStale
                ? `Reflects the saved URL, not your edit. ${status?.detail || ""}`.trim()
                : status?.detail || undefined
            }
          >
            {brokerStale ? `${brokerText} · saved URL` : brokerText}
          </Pill>
          {status?.managed === true && <Badge token="var(--cc-accent)">managed by Cockpit</Badge>}
          {status?.managed === false && status?.reachable && <Badge>external process</Badge>}
          <span style={{ marginLeft: "auto" }} />
          <OverflowButton name="lane broker" />
        </CardHeader>

        <div style={{ fontSize: 11, color: "var(--cc-dim)", padding: "6px 0 2px" }}>
          {status?.service ? `service: ${status.service}` : "service: unknown"}
          {status?.version ? ` · version ${status.version}` : ""}
          {status?.pid ? ` · pid ${status.pid}` : ""}
          {status?.detail ? ` — ${status.detail}` : ""}
        </div>

        <SettingText
          label="Base URL"
          path="providers.lane_broker.base_url"
          get={get}
          setField={setField}
          isDirty={isDirty}
          placeholder="http://127.0.0.1:1235"
          mono
          action={
            <TestButton
              name="lane-broker"
              staleUrl={brokerStale}
              testing={testing}
              onTest={handleTest}
            />
          }
        />
        {brokerStale && <StaleUrlNote name="lane-broker" />}
        {/* THE ADDRESS THE BROKER ACTUALLY BINDS. `GET /api/local/status`
            already returns it as `url` and this card already has the payload --
            it was on the wire and unread, which is the same defect as the
            field's wrong default. Shown next to the control it contradicts, so
            a user who edits the box can see what is really in use. */}
        {status?.url && (
          <div
            data-testid="broker-effective-url"
            role="note"
            style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 4 }}
          >
            In use right now: <code>{status.url}</code>
            {status.managed === true
              ? " — started by Cockpit."
              : status.reachable
                ? " — an external process holds this address."
                : ""}
          </div>
        )}
        <NotEnforcedNote
          name="lane-broker-base-url"
          what="Base URL"
          why="Cockpit reads the broker address from the COCKPIT_BROKER_URL environment variable, not from this field. The address actually in use is shown above."
        />
        <SettingToggle
          label="Autostart with Cockpit"
          path="providers.lane_broker.autostart"
          get={get}
          setField={setField}
          isDirty={isDirty}
          hint="Cockpit runs the broker unless one is already listening"
        />
        <NotEnforcedNote
          name="lane-broker-autostart"
          what="Autostart with Cockpit"
          why="whether Cockpit starts the broker is governed by the COCKPIT_MANAGED_BROKER environment variable (default on), not by this toggle."
        />
        <SettingSlider
          label="Lane concurrency"
          path="providers.lane_broker.concurrency"
          get={get}
          setField={setField}
          isDirty={isDirty}
          min={1}
          max={8}
          step={1}
          fallback={1}
          hint="1 keeps decode fastest"
        />
        <NotEnforcedNote
          name="lane-broker-concurrency"
          what="Lane concurrency"
          why="no code path reads it — not the server, and not an environment variable either. It is validated on save and then ignored."
        />
      </div>

      {/* ── Spill policy + its translation panel ──────── */}
      {/* The translation table sits BESIDE the control, never in a tooltip — it
          is what makes a seconds threshold comprehensible. The pair is wider
          than the settings column, so it scrolls horizontally rather than
          squashing either half. */}
      <div
        style={{ overflowX: "auto", overflowY: "hidden", minWidth: 0, paddingBottom: 2 }}
        data-testid="card-spill-policy"
      >
        <SpillPolicy provider={spillProvider} loading={providers === null} />
      </div>
      </div>

      {/* ── Backends ──────────────────────────────────── */}
      <SectionTitle note="each backend sits behind the broker unless noted">
        Backends behind the broker
      </SectionTitle>

      {/* LM Studio + vLLM — half-width pair */}
      <div style={PAIR} data-testid="row-lmstudio-vllm">
      <div style={CARD} data-testid="card-lmstudio">
        <CardHeader icon={Boxes} token="var(--cc-type)" name="LM Studio">
          {reachabilityPill(
            providers === null ? undefined : healthFor(lmStudio),
            "lmstudio-health",
            lmStudioStale
          )}
          {get("providers.lmstudio.default", false) === true && (
            <Badge token="var(--cc-accent)">Default</Badge>
          )}
          <Badge>{modelCountText(healthFor(lmStudio))}</Badge>
          <span style={{ marginLeft: "auto" }} />
          <OverflowButton name="LM Studio" />
        </CardHeader>

        <SettingText
          label="Base URL"
          path="providers.lmstudio.base_url"
          get={get}
          setField={setField}
          isDirty={isDirty}
          placeholder="http://127.0.0.1:1234"
          mono
          action={
            <TestButton
              name="lmstudio"
              staleUrl={lmStudioStale}
              testing={testing}
              onTest={handleTest}
            />
          }
        />
        {lmStudioStale && <StaleUrlNote name="lmstudio" />}
        <SettingText
          label="lms CLI binary"
          path="providers.lmstudio.cli_path"
          get={get}
          setField={setField}
          isDirty={isDirty}
          placeholder="lms"
          mono
          action={<BrowseButton path="providers.lmstudio.cli_path" onBrowse={onBrowse} />}
        />
        <SettingText
          label="Models folder"
          path="providers.lmstudio.models_dir"
          get={get}
          setField={setField}
          isDirty={isDirty}
          placeholder="~/.lmstudio/models"
          mono
          action={<BrowseButton path="providers.lmstudio.models_dir" onBrowse={onBrowse} />}
        />
        <SettingToggle
          label="Default backend"
          path="providers.lmstudio.default"
          get={get}
          setField={setField}
          isDirty={isDirty}
          hint="New sessions target this backend"
          title="LM Studio is currently the only backend the settings schema lets you mark as default."
        />
        <CapabilityChips capabilities={lmStudio?.capabilities} />
      </div>

      {/* vLLM */}
      <div style={CARD} data-testid="card-vllm">
        <CardHeader icon={Cpu} token="var(--cc-fn)" name="vLLM">
          {reachabilityPill(
            providers === null ? undefined : healthFor(vllm),
            "vllm-health",
            vllmStale
          )}
          <Pill
            token={
              vllmStale
                ? DIRTY
                : healthFor(vllm)?.provider?.reachable
                  ? "var(--cc-idle)"
                  : "var(--cc-muted)"
            }
            testId="vllm-managed-pill"
            title={
              vllmStale
                ? "Reflects the saved URL, not your edit."
                : ownership?.reason || "Sourced from /api/local/vllm/ownership and the health probe"
            }
          >
            {/* Ownership comes from the server, NOT from the draft toggle — the
                toggle is intent and only takes effect on a Cockpit restart. */}
            {`${vllmOwned ? "Managed" : "External"} · ${
              healthFor(vllm)?.provider?.reachable ? "serving" : "stopped"
            }${vllmStale ? " · saved URL" : ""}`}
          </Pill>
          <Badge>{modelCountText(healthFor(vllm))}</Badge>
          <span style={{ marginLeft: "auto" }} />
          <OverflowButton name="vLLM" />
        </CardHeader>

        <div style={{ fontSize: 11, color: "var(--cc-dim)", padding: "6px 0 2px" }}>
          Served direct on its own port — not behind the broker, so continuous batching
          is not serialised.
        </div>

        <SettingText
          label="Base URL"
          path="providers.vllm.base_url"
          get={get}
          setField={setField}
          isDirty={isDirty}
          placeholder="http://127.0.0.1:8001"
          mono
          action={
            <TestButton name="vllm" staleUrl={vllmStale} testing={testing} onTest={handleTest} />
          }
        />
        {vllmStale && <StaleUrlNote name="vllm" />}
        <SettingToggle
          label="Managed by Cockpit"
          path="providers.vllm.managed"
          get={get}
          setField={setField}
          isDirty={isDirty}
          hint="Cockpit starts the container at startup and may restart it to change model"
          title={ownership?.reason || undefined}
        />
        {/* Exactly one caveat, naming the situation the user is actually in.
            Order matters: the env var wins over everything, an external process
            wins over a restart, and only then is "restart Cockpit" the fix. */}
        {vllmEnvPinned && (
          <Callout testId="vllm-managed-env-pinned">
            COCKPIT_MANAGED_VLLM is set in this Cockpit's environment, and it wins over this
            toggle — the saved value is ignored until that variable is unset.
          </Callout>
        )}
        {!vllmEnvPinned && vllmExternalHoldsPort && (
          <Callout testId="vllm-managed-external">
            Another vLLM is already answering on this port, so Cockpit is deferring to it and
            will keep deferring until that process stops. Restarting Cockpit will not change
            this — stop the other vLLM first.
          </Callout>
        )}
        {!vllmEnvPinned && !vllmExternalHoldsPort && vllmPendingRestart && (
          <Callout testId="vllm-managed-pending-restart">
            {vllmManagedDraft
              ? "Cockpit starts the vLLM container during its own startup, so this takes effect the next time Cockpit restarts — not on save."
              : "Cockpit still owns the container it started; it is released the next time Cockpit restarts."}
          </Callout>
        )}
        <SettingText
          label="Launch command"
          path="providers.vllm.launch_command"
          get={get}
          setField={setField}
          isDirty={isDirty}
          placeholder="docker run …"
          mono
          action={
            <ActionButton
              label="Start engine"
              disabled
              testId="vllm-start"
              title={
                vllmOwned
                  ? "Cockpit starts its vLLM container during Cockpit startup — there is no start-on-demand endpoint."
                  : "Cockpit does not own this vLLM, so it must not start or stop it. Start it where you started it."
              }
            />
          }
        />
        {/* The button next to a "docker run …" field reads as THE way to start
            vLLM. It is not, and it never was — so say what actually starts it,
            rather than leaving a disabled control to be guessed at. */}
        <div
          data-testid="vllm-launch-command-note"
          role="note"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 4 }}
        >
          Cockpit does not read this launch command — it builds its own{" "}
          <code>docker run</code> from the vLLM environment variables and runs it at Cockpit
          startup when it owns the container. `Start engine` stays disabled because there is
          no start-on-demand endpoint, and Cockpit must never start or stop a container it
          does not own.
        </div>
        <SettingSlider
          label="GPU memory utilisation"
          path="providers.vllm.gpu_util"
          get={get}
          setField={setField}
          isDirty={isDirty}
          min={0.05}
          max={1}
          step={0.05}
          fallback={0.9}
          format={(v) => `${Math.round(v * 100)}%`}
          hint="Share of VRAM vLLM may claim"
        />
        <NotEnforcedNote name="vllm" what="GPU memory utilisation" />
        <CapabilityChips capabilities={vllm?.capabilities} />
        {/* Live, server-owned config — see the component's own header for why it
            deliberately bypasses the draft store. */}
        <VllmModelsFolderSection provider={vllm} />
      </div>
      </div>

      {/* Ollama + OpenRouter — half-width pair */}
      <div style={PAIR} data-testid="row-ollama-openrouter">
        <div style={CARD} data-testid="card-ollama">
          <CardHeader icon={Layers} token="var(--cc-num)" name="Ollama">
            {reachabilityPill(
              providers === null ? undefined : healthFor(ollama),
              "ollama-health",
              ollamaStale
            )}
            <span style={{ marginLeft: "auto" }} />
            <OverflowButton name="Ollama" />
          </CardHeader>
          <SettingText
            label="Base URL"
            path="providers.ollama.base_url"
            get={get}
            setField={setField}
            isDirty={isDirty}
            placeholder="http://127.0.0.1:11434"
            mono
            action={
              <TestButton
                name="ollama"
                staleUrl={ollamaStale}
                testing={testing}
                onTest={handleTest}
              />
            }
          />
          {ollamaStale && <StaleUrlNote name="ollama" />}
          <SettingToggle
            label="Enabled"
            path="providers.ollama.enabled"
            get={get}
            setField={setField}
            isDirty={isDirty}
          />
        </div>

        <OpenRouterCard get={get} setField={setField} isDirty={isDirty} />
      </div>

      {/* The Claude CLI card that used to live here has been REMOVED, not moved.
          It rendered a live text input bound to `claude_cli.binary_path` — but
          `pty_manager.resolve_claude_cli` reads the CLAUDE_CLI_PATH environment
          variable and otherwise searches PATH; it never consults settings_store.
          So that field saved, reported itself persisted, and changed which binary
          spawns not at all. Its sibling note also claimed version detection was
          unavailable, which stopped being true when GET /api/cli landed.

          Settings ▸ Claude CLI is the real home: it reports the resolved path,
          how it was found, the probed version, and a warning when the resolved
          file is not named `claude`. It deliberately offers no path input, for
          the same reason this card should not have had one. */}
    </div>
  );
}
