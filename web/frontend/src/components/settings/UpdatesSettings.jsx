/* eslint-disable react-refresh/only-export-components -- platformLabel and
   runUpdateCheck are pure/async helpers unit-tested directly; neither is a
   component and neither participates in fast-refresh state. */
/**
 * UpdatesSettings — the Settings ▸ Updates page.
 *
 * Two jobs, both read-only: state what this build IS, and let the user ask
 * whether a newer one exists.
 *
 * WHERE THE VERSION COMES FROM (and why it is not one source):
 *   - the APP version is read from `import.meta.env.VITE_APP_VERSION`, which
 *     vite.config.js defines from package.json at build time. It is always
 *     correct for the running bundle.
 *   - `GET /api/version` also returns `app`, but in the packaged desktop sidecar
 *     that field can be `null` (the version file is not always bundled). So the
 *     server is used ONLY for `cli` / `python` / `platform`, and its `app` is
 *     shown as a separate "server reports" line when it disagrees — never as the
 *     headline. A headline that reads "unknown" for a build we can name exactly
 *     would be a self-inflicted lie.
 *
 * WHERE THE UPDATE CHECK COMES FROM:
 *   - NOT from Cockpit's server. `/api/version` contacts nothing external; there
 *     is no backend update route. The check is Tauri's updater plugin
 *     (`@tauri-apps/plugin-updater`, registered with `updater:default`), reached
 *     through the same dynamic `import(...)` + `check()` pattern App.jsx uses for
 *     its startup check. Outside the desktop app the button is disabled and says
 *     why, because there is genuinely nothing to call.
 *   - Three outcomes are rendered distinctly: up to date, update available (with
 *     the version), and check failed (`role="alert"`). "Up to date" is NEVER
 *     shown for a failed or unavailable check — a check that could not run has
 *     told us nothing about whether an update exists.
 *
 * NO CHANNEL SELECTOR AND NO CHECK-ON-LAUNCH TOGGLE. `settings.system` carries no
 * update keys, so either control would persist nothing and change nothing. The
 * page states the real behaviour (the desktop app checks GitHub Releases on
 * launch, always) instead of offering a switch wired to nothing.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, Download, RefreshCw, TriangleAlert } from "lucide-react";
import { isTauriRuntime } from "../folderPath.js";

// ── tokens / shared style fragments (same idiom as ProvidersSettings) ──
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
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

/** Check outcomes. `idle` and `checking` deliberately render NO verdict. */
const IDLE = "idle";
const CHECKING = "checking";
const UP_TO_DATE = "up-to-date";
const AVAILABLE = "available";
const FAILED = "failed";
const UNAVAILABLE = "unavailable"; // plugin absent / not a desktop build

const DISABLED_REASON =
  "Update checks need the desktop app — the browser build has no updater. " +
  "Cockpit's server does not check for updates; the check is the desktop " +
  "updater talking to GitHub Releases.";

/** sys.platform values → what a human calls them. Unknown values pass through. */
const PLATFORM_NAMES = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

export function platformLabel(raw) {
  if (typeof raw !== "string" || !raw) return null;
  return PLATFORM_NAMES[raw] ? `${PLATFORM_NAMES[raw]} (${raw})` : raw;
}

// ── primitives ────────────────────────────────────────────

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

function FactRow({ label, value, testId, hint }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 8,
        alignItems: "baseline",
        padding: "6px 0",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={LABEL}>{label}</div>
        {hint && (
          <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 2 }}>{hint}</div>
        )}
      </div>
      <div
        data-testid={testId}
        style={{
          fontSize: 12,
          color: "var(--cc-dim)",
          fontFamily: "var(--font-mono, monospace)",
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Callout({ token = "var(--cc-waiting)", icon: Icon = TriangleAlert, children, testId, alert }) {
  return (
    <div
      data-testid={testId}
      role={alert ? "alert" : "note"}
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
        padding: "0 12px",
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

// ── the check itself ──────────────────────────────────────

/**
 * Ask Tauri's updater plugin. Resolves to a discriminated result rather than
 * throwing, so every caller path has to name an outcome:
 *   {kind:"available", version} | {kind:"up-to-date"}
 *   | {kind:"unavailable", reason} | {kind:"failed", error}
 *
 * An ABSENT plugin resolves to `unavailable`, not `failed` and certainly not
 * "up to date": a build without the updater has not been told anything about
 * newer releases.
 */
export async function runUpdateCheck() {
  if (!isTauriRuntime()) {
    return { kind: UNAVAILABLE, reason: "This is not the desktop app." };
  }
  let check;
  try {
    const mod = await import("@tauri-apps/plugin-updater");
    check = mod?.check;
  } catch (err) {
    return {
      kind: UNAVAILABLE,
      reason: `The updater plugin could not be loaded (${err?.message || "unknown error"}).`,
    };
  }
  if (typeof check !== "function") {
    return { kind: UNAVAILABLE, reason: "The updater plugin is not available in this build." };
  }
  try {
    const update = await check();
    if (update && update.version) return { kind: AVAILABLE, version: String(update.version) };
    if (update) return { kind: AVAILABLE, version: null };
    return { kind: UP_TO_DATE };
  } catch (err) {
    return { kind: FAILED, error: err?.message || String(err) };
  }
}

// ── page ──────────────────────────────────────────────────

export default function UpdatesSettings() {
  // The app version is a build-time constant; read it at render so a test can
  // stub the env before mounting.
  const appVersion = import.meta.env?.VITE_APP_VERSION || null;

  const [info, setInfo] = useState(undefined); // undefined = reading, null = unreachable
  const [result, setResult] = useState({ kind: IDLE });
  const desktop = isTauriRuntime();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let data = null;
      try {
        const res = await fetch("/api/version");
        data = res.ok ? await res.json() : null;
      } catch {
        data = null; // best-effort: supporting facts, not the headline
      }
      if (!cancelled) setInfo(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const check = useCallback(async () => {
    setResult({ kind: CHECKING });
    const outcome = await runUpdateCheck();
    setResult(outcome);
  }, []);

  const serverApp = info && typeof info.app === "string" && info.app ? info.app : null;
  const unknown = <span style={{ color: "var(--cc-muted)" }}>unknown</span>;
  const fact = (value) => (value ? value : unknown);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      {/* ── This build ─────────────────────────────────── */}
      <div style={CARD} data-testid="card-version">
        <CardHeader icon={CircleCheck} token="var(--cc-accent)" name="This build" />

        <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "8px 0 4px" }}>
          <span
            data-testid="app-version"
            style={{
              fontSize: 17,
              fontWeight: 800,
              color: "var(--cc-fg)",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {appVersion ? `v${appVersion}` : "version unknown"}
          </span>
          <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>Claude Cockpit</span>
        </div>

        <FactRow
          label="Claude CLI"
          testId="fact-cli"
          hint="the binary sessions spawn"
          value={info === undefined ? "reading…" : fact(info?.cli)}
        />
        <FactRow
          label="Python"
          testId="fact-python"
          hint="running Cockpit's server"
          value={info === undefined ? "reading…" : fact(info?.python)}
        />
        <FactRow
          label="Platform"
          testId="fact-platform"
          value={info === undefined ? "reading…" : fact(platformLabel(info?.platform))}
        />

        {serverApp && serverApp !== appVersion && (
          <FactRow
            label="Server reports"
            testId="fact-server-app"
            hint="the bundled sidecar's own version file"
            value={`v${serverApp}`}
          />
        )}

        {info === null && (
          <Callout testId="version-unreachable">
            Cockpit&apos;s server did not answer, so the CLI, Python and platform facts above are
            unknown. The version on this page is a build-time constant and is still correct.
          </Callout>
        )}

        {appVersion && (
          <div
            role="note"
            data-testid="version-source-note"
            style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 6 }}
          >
            The version above is baked into this build, so it always matches the code you are
            running. The packaged server does not always carry its own version file, which is why
            it is reported separately when the two disagree.
          </div>
        )}
      </div>

      {/* ── Updates ────────────────────────────────────── */}
      <div style={CARD} data-testid="card-updates">
        <CardHeader icon={Download} token="var(--cc-macro)" name="Updates" />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0 2px" }}>
          <ActionButton
            label={result.kind === CHECKING ? "Checking…" : "Check for updates"}
            icon={RefreshCw}
            accent
            testId="check-updates"
            onClick={desktop ? check : undefined}
            disabled={!desktop || result.kind === CHECKING}
            title={desktop ? "Ask GitHub Releases whether a newer build exists" : DISABLED_REASON}
          />
          {result.kind === IDLE && (
            <span data-testid="check-idle" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
              Not checked yet in this session.
            </span>
          )}
        </div>

        {!desktop && (
          <Callout testId="updates-browser-only">{DISABLED_REASON}</Callout>
        )}

        {/* Exactly one verdict renders, and only for a check that actually ran. */}
        {result.kind === UP_TO_DATE && (
          <Callout token="var(--cc-idle)" icon={CircleCheck} testId="update-uptodate">
            You are up to date — GitHub Releases has nothing newer than v{appVersion || "?"}.
          </Callout>
        )}

        {result.kind === AVAILABLE && (
          <Callout token="var(--cc-accent)" icon={Download} testId="update-available">
            Update available:{" "}
            <strong data-testid="update-available-version">
              {result.version ? `v${result.version}` : "a newer build (version not reported)"}
            </strong>
            . Cockpit shows an install prompt with an{" "}
            <em>Install &amp; Restart</em> action when it finds one — restart the app to get that
            prompt, or wait for the next launch check.
          </Callout>
        )}

        {result.kind === FAILED && (
          <Callout token="var(--cc-error)" testId="update-failed" alert>
            The update check failed, so Cockpit does <strong>not</strong> know whether a newer
            build exists: {result.error}
          </Callout>
        )}

        {result.kind === UNAVAILABLE && (
          <Callout testId="update-unavailable">
            Cockpit could not run an update check, so it cannot say whether a newer build exists.{" "}
            {result.reason}
          </Callout>
        )}

        <div
          role="note"
          data-testid="updates-behaviour-note"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 8 }}
        >
          The desktop app checks GitHub Releases automatically every time it launches, and offers an{" "}
          <em>Install &amp; Restart</em> action if a newer signed build is published. There is no
          release-channel setting and no way to switch the launch check off yet — Cockpit stores no
          update preferences, so this page shows no controls for them rather than offering switches
          that would save nothing.
        </div>

        <div
          role="note"
          data-testid="updates-server-note"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 6 }}
        >
          Cockpit&apos;s own server never contacts the internet for versions — the check above is
          the desktop updater, which is why it is unavailable in a browser.
        </div>
      </div>
    </div>
  );
}
