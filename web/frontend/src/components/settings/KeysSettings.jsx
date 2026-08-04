/**
 * KeysSettings — Settings ▸ Keys & secrets.
 *
 * Generalises the OpenRouter card that already lives in ProvidersSettings.jsx:
 * same three routes per provider (GET/POST/DELETE), same masking contract, same
 * "the paste field only ever holds what the user is typing right now" rule. The
 * card is now a module-scope component parameterised by provider, so Anthropic
 * gets it for free from `/api/settings/anthropic`.
 *
 * MASKING IS ABSOLUTE. The server never returns a full key — `GET` answers
 * `{configured, source, masked}` and `masked` is already redacted. This page
 * therefore has nothing to un-mask: the only place a whole key exists in the
 * browser is the password field the user just pasted into, which is never seeded
 * from the server, never read back after Save, and never logged.
 *
 * NO DRAFT STATE. Unlike every other page on this nav, these controls do not go
 * through `setField` — a key writes through its own route and applies the moment
 * Save returns. The page says so out loud, because a user trained by the rest of
 * Settings will otherwise hunt for a "Save changes" button that will never light
 * up for this page.
 *
 * HONESTY, load-bearing: the stored **Anthropic** key is persisted and reported
 * but is not yet consumed by anything. `pty_manager` spawns `claude` with the
 * inherited process environment, so sessions still authenticate from
 * `ANTHROPIC_API_KEY`; nothing reads the value saved here. A card that implies
 * otherwise would have the user believe their sessions are authenticated by a
 * key that is doing nothing. The OpenRouter key IS consumed (pricing snapshots +
 * the provider lever), so that caveat appears on Anthropic ONLY.
 *
 * Props: the shell may pass `{get, setField, isDirty}`; this page uses none of
 * them, deliberately (see NO DRAFT STATE above).
 */

import { useCallback, useEffect, useState } from "react";
import { Cloud, KeyRound, Lock, TriangleAlert } from "lucide-react";

// ── tokens / shared style fragments (idiom from ProvidersSettings) ──
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const WAITING = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;
const MONO = "var(--font-mono, monospace)";

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

/**
 * The two providers this page manages. Everything that differs between them is
 * data, not a code branch — including whether the stored key is actually used.
 */
const KEY_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    route: "/api/settings/anthropic",
    envVar: "ANTHROPIC_API_KEY",
    icon: KeyRound,
    token: "var(--cc-accent)",
    placeholder: "sk-ant-…",
    // What the key is FOR, in the user's terms.
    purpose: "Authenticates Claude sessions against Anthropic's API.",
    // null = the stored key is live. A string = it is not, and this is why.
    notConsumed:
      "This key is saved, but Plexar Studio does not use it yet. Sessions are spawned as plain " +
      "`claude` processes that inherit their credentials from the environment, so they still " +
      "authenticate from ANTHROPIC_API_KEY (or whatever `claude` itself is logged in as) — " +
      "nothing reads the value stored here. Saving it will not change how a session " +
      "authenticates today.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    route: "/api/settings/openrouter",
    envVar: "OPENROUTER_API_KEY",
    icon: Cloud,
    token: "var(--cc-macro)",
    placeholder: "sk-or-v1-…",
    purpose:
      "Used for daily pricing snapshots and for routing sessions through OpenRouter when the provider lever selects it.",
    notConsumed: null, // this one is genuinely wired up
  },
];

// ── primitives ────────────────────────────────────────────

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

function ActionButton({ label, onClick, disabled, title, accent, danger, testId }) {
  const fg = accent && !disabled ? ACCENT_FG : danger && !disabled ? "var(--cc-error)" : "var(--cc-fg)";
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      aria-disabled={disabled ? "true" : "false"}
      className="rounded transition-colors hover-bg-elevated"
      style={{
        width: "100%",
        height: 26,
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 7,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: fg,
        border: `1px solid ${accent && !disabled ? "transparent" : "var(--cc-border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function Callout({ token = WAITING, icon: Icon = TriangleAlert, role = "note", children, testId }) {
  return (
    <div
      data-testid={testId}
      role={role}
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
 * The masked-value line. Never receives an unmasked key: `masked` is what the
 * server chose to reveal, and if it is absent we say where the key came from
 * rather than inventing a redaction of a value we do not hold.
 */
function maskedStatus({ configured, source, masked }) {
  if (!configured || !source) return "Not configured";
  const where = source === "env" ? "Environment variable" : "Saved in config.json";
  return masked ? `${where} · ${masked}` : where;
}

// ── one provider card ─────────────────────────────────────

function KeyCard({ provider }) {
  const { id, label, route, envVar, icon, token, placeholder, purpose, notConsumed } = provider;

  // Server-owned state. Never part of the Settings draft.
  const [configured, setConfigured] = useState(false);
  const [source, setSource] = useState(null);
  const [masked, setMasked] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState(null);
  // Holds ONLY what the user is typing. Never seeded from the server, cleared on
  // success, and always type=password — there is no reveal toggle, because the
  // only value it can ever contain is one the user already has.
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // failure text (from the server)
  const [ok, setOk] = useState(null); // success text

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(route);
      if (!res.ok) {
        setReadError(`Plexar Studio's server answered ${res.status} when asked about this key.`);
      } else {
        const data = await res.json();
        setConfigured(Boolean(data?.configured));
        setSource(data?.source ?? null);
        setMasked(data?.masked ?? null);
        setReadError(null);
      }
    } catch (err) {
      setReadError(`Could not reach Plexar Studio's server: ${err.message}`);
    }
    setLoaded(true);
  }, [route]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    if (busy) return;
    setNotice(null);
    setOk(null);
    if (!keyInput || /\s/.test(keyInput)) {
      setNotice("Key cannot be empty or contain whitespace.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setConfigured(true);
        setSource(data.source ?? "ui");
        setMasked(data.masked ?? null);
        setKeyInput(""); // the full key leaves the browser's state immediately
        setReadError(null);
        setOk("Key saved. It applies now — this page has no Save changes step.");
      } else {
        // The server's own message: it is the only thing that knows what was
        // wrong with the value.
        setNotice(data?.error || "The server rejected this key but gave no reason.");
      }
    } catch (err) {
      setNotice(`Could not reach Plexar Studio's server: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setNotice(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await fetch(route, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      // An env-sourced key answers ok:false with an explanation — the server
      // cannot unset the caller's environment. Surface that verbatim.
      setConfigured(Boolean(data?.configured));
      setSource(data?.source ?? null);
      setMasked(data?.masked ?? null);
      if (res.ok && data?.ok) {
        setOk("Key removed.");
      } else {
        setNotice(data?.error || "The server could not remove this key.");
      }
    } catch (err) {
      setNotice(`Could not reach Plexar Studio's server: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const fromEnv = source === "env";

  return (
    <div style={CARD} data-testid={`card-${id}`}>
      <CardHeader icon={icon} token={token} name={label}>
        {configured ? (
          <Pill token="var(--cc-idle)" testId={`${id}-pill`}>
            Key set
          </Pill>
        ) : (
          <Pill token="var(--cc-muted)" testId={`${id}-pill`}>
            {loaded ? "Not set" : "checking"}
          </Pill>
        )}
        {fromEnv && <Badge token="var(--cc-accent)">from environment</Badge>}
      </CardHeader>

      <div style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", padding: "6px 0 2px" }}>
        {purpose}
      </div>

      {/* A read failure must not render as "Not configured" — those are
          different claims about the user's machine. */}
      {readError && (
        <Callout token="var(--cc-error)" role="alert" testId={`${id}-read-error`}>
          {readError} Plexar Studio could not read whether a {label} key is configured — this is{" "}
          <strong>not</strong> the same as there being none.
        </Callout>
      )}

      {/* Masked only. This is a <span>, not an input: there is no full value in
          the DOM to reveal, and no reveal control exists. */}
      <FieldRow label="Current key" hint="Masked by the server">
        <span
          data-testid={`${id}-masked`}
          style={{ fontSize: 11, fontFamily: MONO, color: "var(--cc-dim)" }}
        >
          {readError ? "unknown" : maskedStatus({ configured, source, masked })}
        </span>
      </FieldRow>

      <FieldRow
        label="Paste new key"
        hint={configured ? "Saving replaces the stored key" : undefined}
        action={
          <ActionButton
            label={busy ? "Saving…" : "Save"}
            onClick={save}
            disabled={busy}
            accent
            testId={`${id}-save`}
            title={`Store this ${label} key on Plexar Studio's server`}
          />
        }
      >
        <input
          type="password"
          value={keyInput}
          onChange={(e) => {
            setKeyInput(e.target.value);
            setNotice(null);
            setOk(null);
          }}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-label={`Paste new ${label} key`}
          data-testid={`${id}-input`}
          className="w-full rounded"
          style={{
            width: "100%",
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
      </FieldRow>

      <FieldRow
        label="Remove key"
        hint={fromEnv ? "Not possible from here" : "Deletes the key Plexar Studio stored"}
        action={
          <ActionButton
            label={busy ? "Removing…" : "Remove"}
            onClick={fromEnv ? undefined : remove}
            disabled={fromEnv || busy || !configured}
            danger
            testId={`${id}-remove`}
            title={
              fromEnv
                ? `This key comes from the ${envVar} environment variable, which Plexar Studio cannot unset.`
                : configured
                  ? `Delete the stored ${label} key`
                  : "There is no stored key to remove"
            }
          />
        }
      >
        <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>
          {fromEnv
            ? `Plexar Studio cannot unset ${envVar}.`
            : configured
              ? "Plexar Studio stops using this key."
              : "Nothing stored."}
        </span>
      </FieldRow>

      {fromEnv && (
        <Callout token="var(--cc-accent)" icon={Lock} testId={`${id}-env-note`}>
          This key comes from the <code>{envVar}</code> environment variable. Plexar Studio cannot
          remove it here — the server does not own your environment. Unset{" "}
          <code>{envVar}</code> (in your shell, your system environment, or{" "}
          <code>web/.env</code>) and restart Plexar Studio.
        </Callout>
      )}

      {notConsumed && (
        <Callout token={WAITING} testId={`${id}-not-consumed`}>
          {notConsumed}
        </Callout>
      )}

      {notice && (
        <Callout token="var(--cc-error)" role="alert" testId={`${id}-notice`}>
          {notice}
        </Callout>
      )}

      {ok && !notice && (
        <div
          role="note"
          data-testid={`${id}-ok`}
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-idle)", paddingTop: 6 }}
        >
          {ok}
        </div>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function KeysSettings() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      {/* Two facts the user needs before touching either card: where the values
          live, and that they do not participate in Save changes. */}
      <div
        role="note"
        data-testid="keys-storage-note"
        style={{
          ...CARD,
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          fontSize: 11,
          lineHeight: 1.6,
          color: "var(--cc-dim)",
        }}
      >
        <Lock size={13} style={{ flexShrink: 0, marginTop: 2, color: "var(--cc-accent)" }} />
        <span>
          Keys are stored server-side in <code>config.json</code>, deliberately separate from{" "}
          <code>settings.json</code> — so a settings file you export or share carries no secrets.
          Plexar Studio only ever shows you a masked value; the full key is never sent back to this
          page.
          <br />
          <strong>These two cards do not use “Save changes”.</strong> Unlike the rest of Settings
          they are not drafts: Save and Remove write straight to the server and take effect the
          moment they return.
        </span>
      </div>

      {KEY_PROVIDERS.map((provider) => (
        <KeyCard key={provider.id} provider={provider} />
      ))}
    </div>
  );
}
