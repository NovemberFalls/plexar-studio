/* eslint-disable react-refresh/only-export-components -- buildModelSelectGroups
   is exported so the test suite asserts grouping against the shared model source
   directly, instead of a fixture that could drift from it. Same accommodation
   TopBar.jsx makes for its MODELS re-export. */
/**
 * SessionDefaultsSettings — the Settings ▸ Defaults & models page.
 *
 * WHY THIS PAGE EXISTS AT ALL (owner's note: "shouldn't they be tied together?"):
 * the command bar's DEFAULTS pill already chooses the model / permission mode /
 * effort / fast flag a NEW session spawns with. This page must be the SAME state
 * as that pill, not a second competing copy. Two consequences:
 *
 *   1. The model list is imported from TopBar.jsx (`MODEL_GROUPS` / `MODELS` /
 *      `getModelProvider`), which re-exports the shared `modelCatalog` source the
 *      pill itself renders. When a live catalog is present in context we read it
 *      through `useModelCatalog()` — the exact hook TopBar uses — so a live
 *      Anthropic catalog and any local-provider groups appear here too. A second
 *      hardcoded list would drift, and that drift is the thing being objected to.
 *   2. Permission modes and effort levels come from `sessionVocabulary.js`, the
 *      single source all four session surfaces read. Effort "Auto" is
 *      the empty string — pty_manager's _ALLOWED_EFFORT_LEVELS raises on
 *      anything outside {"",low,medium,high,xhigh,max}, so a friendly "auto"
 *      string would break session creation. See TopBar for the full note.
 *
 * INTENT, NOT A DASHBOARD. Every value is written through
 * `setField(dottedPath, value)`; nothing lives in local state or localStorage,
 * and the page renders no save button (the Settings shell owns saving).
 *
 * Paths written: sessions.model · sessions.permission_mode · sessions.effort ·
 * sessions.fast.
 *
 * HONESTY: the shell does not read `sessions.*` when spawning yet — the DEFAULTS
 * pill still drives that from App state + localStorage. So this page currently
 * stores an intent that does not apply. That is said on screen
 * (`not-read-sessions`), in the same pattern ProvidersSettings uses for
 * concurrency / gpu_util. Remove that note when the shell reads these on boot.
 *
 * Props (pinned by the Settings shell):
 *   get(dottedPath, fallback) → current DRAFT value
 *   setField(dottedPath, value) → record an unsaved edit
 *   isDirty(dottedPath) → bool; true fields highlight in --cc-waiting
 */

import { Cpu, Info, TriangleAlert } from "lucide-react";
// Same sources the DEFAULTS pill uses. Do NOT re-declare any of these lists
// here; a second copy is exactly the drift the owner objected to.
//   · model list  → TopBar's documented re-export of modelCatalog
//   · vocabularies → sessionVocabulary, a plain module (see its header for why
//     they are not constants on TopBar)
import { MODEL_GROUPS, MODELS, getModelProvider, isOpusModel } from "../TopBar.jsx";
import { PERMISSION_MODES, EFFORT_OPTIONS } from "../../sessionVocabulary";
import { useModelCatalog } from "../../modelCatalog";

// ── tokens / shared style fragments (mirrors ProvidersSettings) ────────────
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const DIRTY = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
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

/** Provider → the badge text shown beside a model option's group. */
const PROVIDER_BADGE = {
  local: "local",
  openrouter: "OpenRouter",
  anthropic: null,
};

// ── primitives ────────────────────────────────────────────

function SectionTitle({ children, note }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
      <span style={{ ...LABEL, fontSize: 10, color: "var(--cc-fg)" }}>{children}</span>
      {note && <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>{note}</span>}
    </div>
  );
}

function CardHeader({ icon: Icon, token, name, children }) {
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
      {Icon && (
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
      )}
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>{name}</span>
      {children}
    </div>
  );
}

function Badge({ children, token = "var(--cc-dim)", testId }) {
  return (
    <span
      data-testid={testId}
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

function FieldRow({ label, hint, action, children }) {
  return (
    <div style={FIELD_GRID}>
      <div style={{ minWidth: 0 }}>
        <div style={LABEL}>{label}</div>
        {hint && <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
      <div>{action ?? null}</div>
    </div>
  );
}

/** Inline callout. `token` decides the tone: DIRTY for "not in force yet". */
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

/**
 * A draft <select>. `options` is [{value, label}]; `groups` (optional) is
 * [{label, options:[…]}] and renders <optgroup>s so the model list keeps the
 * pill's family/provider grouping.
 */
function SettingSelect({
  label,
  path,
  get,
  setField,
  isDirty,
  options,
  groups,
  fallback = "",
  hint,
  action,
  mono,
}) {
  const dirty = Boolean(isDirty?.(path));
  const raw = get(path, fallback);
  // null is how settings.json spells "not chosen"; render it as the fallback
  // rather than letting the select go uncontrolled.
  const value = raw === null || raw === undefined ? fallback : raw;
  const renderOption = (o) => (
    <option key={`${o.value}`} value={o.value}>
      {o.label}
    </option>
  );
  return (
    <FieldRow label={label} hint={hint} action={action}>
      <select
        value={value}
        onChange={(e) => setField(path, e.target.value)}
        aria-label={label}
        data-testid={`field-${path}`}
        data-dirty={dirty ? "true" : "false"}
        className="w-full rounded"
        style={{
          width: "100%",
          height: 26,
          padding: "0 6px",
          fontSize: 11,
          fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
          borderRadius: 7,
          background: "var(--cc-elev)",
          border: `1px solid ${dirty ? DIRTY : "var(--cc-border)"}`,
          color: dirty ? DIRTY : "var(--cc-fg)",
          outline: "none",
        }}
      >
        {groups
          ? groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map(renderOption)}
              </optgroup>
            ))
          : (options || []).map(renderOption)}
      </select>
    </FieldRow>
  );
}

/** A draft boolean rendered as a two-segment switch (ProvidersSettings idiom). */
function SettingToggle({
  label,
  path,
  get,
  setField,
  isDirty,
  hint,
  title,
  disabled,
  onLabel = "On",
  offLabel = "Off",
}) {
  const dirty = Boolean(isDirty?.(path));
  const on = Boolean(get(path, false));
  const segment = (active, text, next) => (
    <button
      key={text}
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${label}: ${text}`}
      disabled={disabled}
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
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
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

// ── model list, shared with the DEFAULTS pill ──────────────

/**
 * Turns the shared catalog's groups into <optgroup> data.
 *
 * `catalogGroups` is whatever `useModelCatalog()` holds — the live list when the
 * app wraps this page in ModelCatalogProvider, the static FALLBACK groups
 * otherwise. `MODEL_GROUPS` (TopBar's re-export of the same fallback) is the
 * last resort so the select is never empty.
 *
 * Provider is derived per-model with `getModelProvider` — the same function the
 * pill uses — so local and OpenRouter entries are marked from the id, never from
 * a second maintained mapping. A group whose models are all one non-Anthropic
 * provider also gets that word in its optgroup label, because an optgroup is the
 * only place a native select lets us put it.
 */
export function buildModelSelectGroups(catalogGroups) {
  const source =
    Array.isArray(catalogGroups) && catalogGroups.length > 0 ? catalogGroups : MODEL_GROUPS;
  return source
    .map((g) => {
      const models = Array.isArray(g.models) ? g.models : [];
      const providers = new Set(models.map((m) => getModelProvider(m.id)));
      const only = providers.size === 1 ? [...providers][0] : null;
      const badge = only ? PROVIDER_BADGE[only] : null;
      return {
        label: badge ? `${g.label} · ${badge}` : g.label,
        options: models.map((m) => ({ value: m.id, label: m.label || m.id })),
      };
    })
    .filter((g) => g.options.length > 0);
}

/** Flat list of every id the select offers — used for the fast-mode eligibility check. */
function flatModels(catalogGroups) {
  const source =
    Array.isArray(catalogGroups) && catalogGroups.length > 0 ? catalogGroups : MODEL_GROUPS;
  const models = source.flatMap((g) => (Array.isArray(g.models) ? g.models : []));
  return models.length > 0 ? models : MODELS;
}

// ── page ──────────────────────────────────────────────────

export default function SessionDefaultsSettings({ get, setField, isDirty }) {
  // Same hook TopBar calls. Without a ModelCatalogProvider above us this is the
  // static fallback catalog, which is exactly what the pill falls back to too.
  const catalog = useModelCatalog();
  const groups = buildModelSelectGroups(catalog?.groups);
  const all = flatModels(catalog?.groups);

  // sessions.model is null until the user picks one; "" renders the placeholder
  // option and means "whatever the command bar is set to right now".
  const selectedModel = get("sessions.model", null);
  const modelProvider = selectedModel ? getModelProvider(selectedModel) : null;
  const known = all.some((m) => m.id === selectedModel);

  // Fast mode mirrors the pill's eligibility rule exactly: Opus models only, and
  // never for an OpenRouter model. Anything else and the flag is inert, so we
  // disable the switch and say why instead of storing a value that cannot apply.
  const fastEligible =
    Boolean(selectedModel) && isOpusModel(selectedModel) && modelProvider !== "openrouter";

  const modelGroups = [
    { label: "Not set", options: [{ value: "", label: "Use the command bar's current model" }] },
    ...groups,
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      <SectionTitle note="what a NEW session starts with">Defaults &amp; models</SectionTitle>

      <div style={CARD} data-testid="card-session-defaults">
        <CardHeader icon={Cpu} token="var(--cc-accent)" name="New session defaults">
          <Badge testId="catalog-source">
            {catalog?.source === "fallback" || !catalog?.source
              ? "static model list"
              : `catalog: ${catalog.source}`}
          </Badge>
          {modelProvider && PROVIDER_BADGE[modelProvider] && (
            <Badge token="var(--cc-macro)" testId="model-provider-badge">
              {PROVIDER_BADGE[modelProvider]}
            </Badge>
          )}
        </CardHeader>

        {/* The whole point of the page: state the scope before any control. */}
        <div
          role="note"
          data-testid="new-sessions-only"
          style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", padding: "6px 0 2px" }}
        >
          These are the defaults for <strong>new sessions only</strong>. They are the same four
          values as the command bar&apos;s DEFAULTS pill, and they never retune a pane that is
          already running — to change a running session&apos;s model, permission mode or effort,
          use the Inspector for that session.
        </div>

        <SettingSelect
          label="Model"
          path="sessions.model"
          get={get}
          setField={setField}
          isDirty={isDirty}
          groups={modelGroups}
          fallback=""
          hint="Same list as the DEFAULTS pill"
          mono
        />

        {selectedModel && !known && (
          <Callout testId="unknown-model">
            <strong>{selectedModel}</strong> is not in the model list Cockpit currently knows about.
            It is stored as typed — if it came from a local provider that is offline right now, it
            will reappear in the list when that provider answers again.
          </Callout>
        )}

        <SettingSelect
          label="Permission mode"
          path="sessions.permission_mode"
          get={get}
          setField={setField}
          isDirty={isDirty}
          options={[
            { value: "", label: "Use the command bar's current mode" },
            ...PERMISSION_MODES.map((p) => ({ value: p.id, label: p.label })),
          ]}
          fallback=""
          hint="Ask · Plan · Accept Edits · Bypass"
        />

        <SettingSelect
          label="Thinking effort"
          path="sessions.effort"
          get={get}
          setField={setField}
          isDirty={isDirty}
          options={EFFORT_OPTIONS.map((e) => ({ value: e.id, label: e.label }))}
          fallback=""
          hint="Auto lets the model decide"
        />

        <SettingToggle
          label="Fast mode"
          path="sessions.fast"
          get={get}
          setField={setField}
          isDirty={isDirty}
          disabled={!fastEligible}
          hint={fastEligible ? "Opus fast decoding" : "Opus models only"}
          title={
            fastEligible
              ? "New Opus sessions start in fast mode"
              : "Fast mode only exists for Opus models, and never for OpenRouter models — the command bar disables it the same way."
          }
        />

        {!fastEligible && (
          <div
            role="note"
            data-testid="fast-ineligible"
            style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 2 }}
          >
            {selectedModel
              ? "Fast mode does nothing for this model — it applies to Opus models only, and never to OpenRouter models. The command bar disables it under the same rule."
              : "Pick an Opus model above to enable fast mode. It applies to Opus models only, and never to OpenRouter models."}
          </div>
        )}

        {/* The honesty note. Same pattern as ProvidersSettings' NotEnforcedNote,
            but tinted --cc-waiting because here the stored value has NO effect at
            all yet, not merely a delayed one. */}
        <Callout token={DIRTY} icon={Info} testId="not-read-sessions">
          Saved, but <strong>not in force yet</strong>. Cockpit still takes a new session&apos;s
          model, permission mode, effort and fast flag from the command bar&apos;s DEFAULTS pill,
          which keeps its own selection for this workspace. Nothing reads{" "}
          <code>sessions.*</code> at startup today, so changing these values here does not yet
          change what the next session spawns with. This note disappears once the shell reads
          these on boot.
        </Callout>
      </div>
    </div>
  );
}
