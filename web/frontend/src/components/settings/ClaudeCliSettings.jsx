/**
 * ClaudeCliSettings — Settings ▸ Claude CLI.
 *
 * The owner's question was "why is this not displaying a path to the cli?" The
 * answer was that nothing ever asked: `pty_manager.resolve_claude_cli` has
 * always resolved a real path, and `GET /api/cli` now reports it. This page is
 * that report, and nothing more.
 *
 * READ-ONLY BY DESIGN. There is no path input here, and that is a deliberate
 * refusal rather than an omission:
 *
 *   - The only override Plexar Studio honours is the `CLAUDE_CLI_PATH` **environment
 *     variable**, read inside `resolve_claude_cli` at spawn time. A browser
 *     cannot set an environment variable for the server process.
 *   - `settings.json` does carry `claude_cli.binary_path` (see
 *     settings_store.DEFAULT_SETTINGS), but **no server code reads it** —
 *     `pty_manager` never consults settings_store. A text field bound to that
 *     path would save cleanly, report itself as persisted, and change which
 *     binary spawns not at all. That is the exact "looks like it works and
 *     doesn't" trap, and it is worse than no field.
 *   - So the override is explained in words and the variable is named. When the
 *     spawn path actually reads a stored value, this page grows an input.
 *
 * Data: GET /api/cli (authoritative) + GET /api/version (supporting facts).
 * Fetched once on mount and on an explicit Re-check. Never polled — the
 * resolved CLI does not change while a settings page is open, and a poller on a
 * subprocess probe would be pure cost.
 *
 * Props: the shell may pass its standard `{get, setField, isDirty}` trio, but
 * this page reads and writes NO draft field, so it deliberately destructures
 * none of them. Nothing here contributes unsaved-changes state.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  RefreshCw,
  Terminal,
  TriangleAlert,
} from "lucide-react";

// ── tokens / shared style fragments (idiom borrowed from ProvidersSettings) ──
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

const ROW = {
  display: "grid",
  gridTemplateColumns: "200px 1fr",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 0",
};

/** The em dash used wherever a value was genuinely not reported. */
const NOT_REPORTED = "—";

/**
 * Plain-English rendering of `source`. This is the sentence the page exists for:
 * a bare path tells the user nothing about WHY that binary is the one that runs.
 */
function sourceExplanation(info) {
  const envName = info?.override_env || "CLAUDE_CLI_PATH";
  switch (info?.source) {
    case "env":
      return `Found via the ${envName} environment variable — that override wins over anything on your PATH.`;
    case "search":
      return info?.override_set
        ? `Found by searching your PATH and the known install locations. ${envName} is set but did not resolve to a usable file, so Plexar Studio fell back to a search.`
        : "Found by searching your PATH and the known install locations. No override is set.";
    case "not_found":
      return "Plexar Studio could not find a Claude CLI anywhere on your PATH or in the known install locations.";
    default:
      return "Plexar Studio did not report how this path was found.";
  }
}

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

function ReadRow({ label, hint, children, testId }) {
  return (
    <div style={ROW} data-testid={testId}>
      <div style={{ minWidth: 0 }}>
        <div style={LABEL}>{label}</div>
        {hint && (
          <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 2 }}>{hint}</div>
        )}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * Inline callout. `role` is caller-chosen: a genuine failure state gets "alert"
 * so a screen reader interrupts, an explanatory aside gets "note".
 */
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

function ActionButton({ label, onClick, disabled, title, accent, testId, icon: Icon }) {
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
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 10px",
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
      {Icon && <Icon size={12} aria-hidden="true" />}
      {label}
    </button>
  );
}

// ── page ──────────────────────────────────────────────────

export default function ClaudeCliSettings() {
  const [info, setInfo] = useState(null); // GET /api/cli payload
  const [version, setVersion] = useState(null); // GET /api/version payload
  const [error, setError] = useState(null); // /api/cli unreachable
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(false);

  // One probe, both routes. /api/cli is authoritative and its failure is an
  // error state; /api/version is supporting detail and its failure is silent.
  const probe = useCallback(async () => {
    let cliPayload = null;
    let cliError = null;
    try {
      const res = await fetch("/api/cli");
      if (!res.ok) {
        cliError = `Plexar Studio's server answered ${res.status} for /api/cli.`;
      } else {
        cliPayload = await res.json();
      }
    } catch (err) {
      cliError = `Could not reach Plexar Studio's server: ${err.message}`;
    }

    let versionPayload = null;
    try {
      const res = await fetch("/api/version");
      if (res.ok) versionPayload = await res.json();
    } catch {
      versionPayload = null; // supporting facts only — no error surface
    }

    setInfo(cliPayload);
    setVersion(versionPayload);
    setError(cliError);
    setLoaded(true);
  }, []);

  useEffect(() => {
    probe();
  }, [probe]);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      await probe();
    } finally {
      setChecking(false);
    }
  }, [probe]);

  const notFound = Boolean(info) && (info.source === "not_found" || !info.path);
  const nameMismatch = Boolean(info) && Boolean(info.path) && info.name_matches === false;
  const envName = info?.override_env || "CLAUDE_CLI_PATH";
  const expected = info?.expected_name || "claude";
  const resolvedFile = info?.path
    ? String(info.path).replace(/\\/g, "/").split("/").filter(Boolean).pop()
    : null;

  const statusPill = () => {
    if (!loaded) return <Pill token="var(--cc-muted)" testId="cli-status">checking</Pill>;
    if (error) {
      return (
        <Pill token="var(--cc-muted)" testId="cli-status" title={error}>
          unknown
        </Pill>
      );
    }
    if (notFound) {
      return (
        <Pill token="var(--cc-error)" testId="cli-status" title="No claude executable resolved">
          not found
        </Pill>
      );
    }
    if (nameMismatch) {
      return (
        <Pill token={WAITING} testId="cli-status" title="Resolved a file that is not named claude">
          check path
        </Pill>
      );
    }
    return (
      <Pill token="var(--cc-idle)" testId="cli-status" title="Plexar Studio can spawn sessions">
        resolved
      </Pill>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      <div style={CARD} data-testid="card-claude-cli">
        <CardHeader icon={Terminal} token="var(--cc-accent)" name="Claude CLI">
          {statusPill()}
          <span style={{ marginLeft: "auto" }} />
          <ActionButton
            label={checking ? "Checking…" : "Re-check"}
            icon={RefreshCw}
            onClick={recheck}
            disabled={checking}
            testId="cli-recheck"
            title="Ask the server to resolve the Claude CLI again"
          />
        </CardHeader>

        <div style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", padding: "6px 0 2px" }}>
          Every session Plexar Studio starts is a <code>claude</code> process. This is the exact
          executable it spawns, and how it was located.
        </div>

        {/* A failed read is an error, never a blank card that reads as
            "no CLI configured" — those are opposite claims. */}
        {error && (
          <Callout
            token="var(--cc-error)"
            role="alert"
            testId="cli-fetch-error"
          >
            {error} Plexar Studio could not read which Claude CLI it would spawn, so nothing below is
            known — this is <strong>not</strong> the same as no CLI being installed. Use
            Re-check once the server is reachable.
          </Callout>
        )}

        {!error && (
          <>
            <ReadRow
              label="Resolved path"
              hint={loaded && !notFound ? "Read-only — see the override note below" : undefined}
              testId="cli-path-row"
            >
              <span
                data-testid="cli-path"
                style={{
                  fontSize: 12,
                  fontFamily: MONO,
                  wordBreak: "break-all",
                  color: notFound ? "var(--cc-error)" : "var(--cc-fg)",
                }}
              >
                {!loaded ? NOT_REPORTED : info?.path || "no executable resolved"}
              </span>
            </ReadRow>

            <ReadRow label="How it was found" testId="cli-source-row">
              <span
                data-testid="cli-source"
                style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-dim)" }}
              >
                {loaded ? sourceExplanation(info) : "Asking the server…"}
              </span>
            </ReadRow>

            <ReadRow
              label="Detected version"
              hint="Reported by the binary itself"
              testId="cli-version-row"
            >
              <span
                data-testid="cli-version"
                style={{ fontSize: 12, fontFamily: MONO, color: "var(--cc-fg)" }}
              >
                {info?.version || NOT_REPORTED}
              </span>
              {loaded && !info?.version && (
                <span
                  data-testid="cli-version-unknown"
                  style={{ fontSize: 11, color: "var(--cc-muted)", marginLeft: 8 }}
                >
                  not reported — the version probe timed out or the binary printed nothing
                  Plexar Studio could parse
                </span>
              )}
            </ReadRow>
          </>
        )}

        {/* not_found is the serious condition on this page: with no binary,
            every "New session" fails. It gets an alert and instructions. */}
        {notFound && !error && (
          <Callout token="var(--cc-error)" role="alert" testId="cli-not-found">
            <strong>Plexar Studio cannot start any session.</strong> No <code>{expected}</code>{" "}
            executable was found on your PATH or in the known install locations, so every attempt
            to open a pane will fail. Either install Claude Code (
            <code>npm i -g @anthropic-ai/claude-code</code>), or set the{" "}
            <code>{envName}</code> environment variable to the full path of the executable and
            restart Plexar Studio. Then press Re-check.
          </Callout>
        )}

        {nameMismatch && !error && (
          <Callout token={WAITING} testId="cli-name-mismatch">
            The resolved file is <code>{resolvedFile}</code>, which is not named{" "}
            <code>{expected}</code> — it may not be the Claude CLI. Plexar Studio spawns whatever this
            path points at, so if it is the wrong program every new session will fail or behave
            strangely. Set <code>{envName}</code> to the correct executable if this looks wrong.
            (An npm shim such as <code>{expected}.cmd</code> is fine and would not appear here.)
          </Callout>
        )}

        {/* The honesty note that replaces the path input someone would expect. */}
        <Callout token="var(--cc-accent)" icon={Terminal} testId="cli-override-note">
          The path is not editable here. Plexar Studio&apos;s only override is the{" "}
          <code>{envName}</code> <strong>environment variable</strong>, which a web page cannot
          set for the server process — set it in your shell, your{" "}
          <code>web/.env</code>, or your system environment, then restart Plexar Studio and press
          Re-check. {loaded && info?.override_set
            ? `It is currently set.`
            : `It is currently not set.`}
        </Callout>
      </div>

      {/* Supporting environment facts. Separate card because none of it is
          about which CLI runs — it is context for a bug report. */}
      <div style={CARD} data-testid="card-environment">
        <CardHeader icon={CircleCheck} token="var(--cc-ok)" name="Environment" />
        <ReadRow label="Plexar Studio version" testId="env-app-row">
          <span
            data-testid="env-app"
            style={{ fontSize: 12, fontFamily: MONO, color: "var(--cc-fg)" }}
          >
            {version?.app || NOT_REPORTED}
          </span>
        </ReadRow>
        <ReadRow label="Python" hint="Runs Plexar Studio's server" testId="env-python-row">
          <span
            data-testid="env-python"
            style={{ fontSize: 12, fontFamily: MONO, color: "var(--cc-fg)" }}
          >
            {version?.python || NOT_REPORTED}
          </span>
        </ReadRow>
        <ReadRow label="Platform" testId="env-platform-row">
          <span
            data-testid="env-platform"
            style={{ fontSize: 12, fontFamily: MONO, color: "var(--cc-fg)" }}
          >
            {version?.platform || NOT_REPORTED}
          </span>
        </ReadRow>
        {loaded && !version && (
          <div
            role="note"
            data-testid="env-unavailable"
            style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 4 }}
          >
            Plexar Studio could not read its environment details just now. These are informational
            only — nothing on this page depends on them.
          </div>
        )}
      </div>
    </div>
  );
}
