/**
 * RemoteSettings — the Settings ▸ Remote page (Studio Remote / Plexar Mobile pairing).
 *
 * Remote access is OPT-IN and OFF by default (SPEC §1). This page:
 *   - toggles `remote.enabled` and edits `remote.hostname` through useSettings
 *     (the normal draft/save flow the rest of Settings uses — a change here is
 *     not live until "Save changes" is clicked, exactly like every other page).
 *   - reads live server state from GET /api/remote/status (enabled devices,
 *     hostname as the server currently sees it, protocol version) — this is
 *     NOT the same as the draft above; the draft is what will be saved, the
 *     status call is what the server is doing right now.
 *   - starts a pairing via POST /api/remote/pairings and renders the code, an
 *     expiry countdown, and a QR of the server's `qr_payload` string rendered
 *     VERBATIM (never re-serialized) with the `qrcode` package.
 *   - revokes a device via an in-app confirm (never window.confirm) that AWAITS
 *     DELETE /api/remote/devices/{id} and only removes the row on success.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Cloud, Copy, KeyRound, Plug, RadioTower, QrCode, ShieldOff, Smartphone, TriangleAlert } from "lucide-react";
import QRCode from "qrcode";

const PROBE_HINTS = {
  access: "Cloudflare Access answered — the tunnel is up and gated by Access.",
  guarded: "Studio answered through the tunnel and refused the request — the tunnel is up.",
  disabled: "The tunnel reached this machine, but remote access is off. Enable it above and save.",
  unreachable: "No response — check the cloudflared service is running and DNS has propagated.",
  unexpected: "Got a response that didn't match any known shape. Check the hostname and try again.",
};

/** Connector state → the token its dot and word are painted in. */
const TUNNEL_STATE_TOKEN = {
  running: "var(--cc-idle)",
  starting: "var(--cc-working)",
  stopping: "var(--cc-working)",
  crashed: "var(--cc-error)",
  stopped: "var(--cc-muted)",
};

const TUNNEL_POLL_MS = 3000;

const WINGET_LINE = "winget install --id Cloudflare.cloudflared";

const ACCENT_FG = "#0f1216";
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

const MONO = "var(--font-mono, monospace)";

const FIELD_GRID = {
  display: "grid",
  gridTemplateColumns: "200px 1fr 108px",
  gap: 8,
  alignItems: "center",
  padding: "6px 0",
};

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

function ActionButton({ label, onClick, disabled, title, accent, testId, icon: Icon, danger }) {
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
        color: accent && !disabled ? ACCENT_FG : danger ? "var(--cc-error)" : "var(--cc-fg)",
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

/** Copy-to-clipboard button with an inline "Copied" confirmation / error — no native dialogs. */
function CopyButton({ text, testId, label = "Copy" }) {
  const [state, setState] = useState("idle"); // idle | copied | error
  const timer = useRef(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text ?? "");
      setState("copied");
    } catch {
      setState("error");
    } finally {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2000);
    }
  }, [text]);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <ActionButton label={label} icon={Copy} testId={testId} onClick={onClick} />
      {state === "copied" && (
        <span data-testid={`${testId}-copied`} style={{ fontSize: 10, color: "var(--cc-idle)" }}>
          Copied
        </span>
      )}
      {state === "error" && (
        <span data-testid={`${testId}-error`} role="alert" style={{ fontSize: 10, color: "var(--cc-error)" }}>
          Could not copy
        </span>
      )}
    </span>
  );
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function secondsLeft(expiresAt, now) {
  if (typeof expiresAt !== "number") return 0;
  return Math.max(0, Math.round(expiresAt - now / 1000));
}

/** In-app confirm dialog — NEVER window.confirm. Awaits the caller's action. */
function RevokeConfirm({ device, onCancel, onConfirm, busy, error }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Revoke device"
      data-testid="revoke-confirm"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, black 55%, transparent)",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          ...CARD,
          width: 340,
          background: "var(--cc-bg2)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
          Revoke &ldquo;{device?.name}&rdquo;?
        </div>
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-dim)", margin: "0 0 12px" }}>
          This device will lose access immediately and any open stream from it will be closed. It
          will need to be paired again to reconnect.
        </p>
        {error && (
          <div
            role="alert"
            data-testid="revoke-error"
            style={{ fontSize: 11, color: "var(--cc-error)", marginBottom: 10, lineHeight: 1.5 }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <ActionButton label="Cancel" onClick={onCancel} disabled={busy} testId="revoke-cancel" />
          <ActionButton
            label={busy ? "Revoking…" : "Revoke"}
            onClick={onConfirm}
            disabled={busy}
            danger
            testId="revoke-confirm-button"
          />
        </div>
      </div>
    </div>
  );
}

function DevicesTable({ devices, onRevokeRequest }) {
  if (!devices || devices.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--cc-muted)", padding: "10px 0" }}>
        No devices paired yet.
      </div>
    );
  }
  return (
    <table
      data-testid="devices-table"
      style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginTop: 6 }}
    >
      <thead>
        <tr style={{ textAlign: "left", color: "var(--cc-muted)" }}>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Name</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Created</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Last seen</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Status</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }} />
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => {
          const revoked = Boolean(d.revoked_at);
          return (
            <tr key={d.id} data-testid={`device-row-${d.id}`} style={{ borderTop: "1px solid var(--cc-line)" }}>
              <td style={{ padding: "6px" }}>{d.name}</td>
              <td style={{ padding: "6px", color: "var(--cc-dim)" }}>{fmtTime(d.created_at)}</td>
              <td style={{ padding: "6px", color: "var(--cc-dim)" }}>{fmtTime(d.last_seen)}</td>
              <td style={{ padding: "6px", color: revoked ? "var(--cc-error)" : "var(--cc-idle)" }}>
                {revoked ? "Revoked" : "Active"}
              </td>
              <td style={{ padding: "6px", textAlign: "right" }}>
                {!revoked && (
                  <ActionButton
                    label="Revoke"
                    danger
                    testId={`revoke-${d.id}`}
                    onClick={() => onRevokeRequest(d)}
                  />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const HARNESS_PERMISSION_MODES = [
  { id: "read-only", label: "Read-only" },
  { id: "workspace-write", label: "Workspace write" },
];

/**
 * Plexar Harness card — Settings ▸ Remote (this page is the closest existing
 * home for a "third-party endpoint + credential" card; see the task brief).
 *
 * The key field follows KeysSettings' NO DRAFT STATE / MASKING IS ABSOLUTE
 * contract: PUT /api/harness/key writes through immediately, the key is never
 * echoed back, and a successful save clears the field and shows only
 * confirmation text. The permission-mode select is an ordinary settings field
 * (`harness.permission_mode`) through the normal useSettings get/setField/save
 * draft flow — it is NOT a live API call like the key.
 */
function HarnessCard({ get, setField }) {
  // Same fallback as harness_manager.permission_mode() and DEFAULT_SETTINGS, so the
  // picker never shows a mode the backend is not actually using.
  const permissionModeDraft = get("harness.permission_mode", "workspace-write") || "workspace-write";

  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/harness/status")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("bad status"))))
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatusError("Could not load Plexar Harness status");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await fetch("/api/harness/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKeyError(data?.error || "Could not save the key");
        return;
      }
      setKeyDraft("");
      setKeySaved(true);
      setStatus((prev) => (prev ? { ...prev, key_set: true, key_source: "settings" } : prev));
    } catch {
      setKeyError("Could not save the key");
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async () => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await fetch("/api/harness/key", { method: "DELETE" });
      if (!res.ok) {
        setKeyError("Could not clear the key");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setKeyDraft("");
      setKeySaved(false);
      // A key can remain in the environment after the saved one is cleared.
      setStatus((prev) => (prev ? { ...prev, key_set: !!data.key_set, key_source: data.key_source ?? null } : prev));
    } catch {
      setKeyError("Could not clear the key");
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <div style={CARD} data-testid="card-harness">
      <CardHeader icon={Bot} token="var(--cc-accent)" name="Plexar Harness" />

      {statusError && (
        <Callout token="var(--cc-error)" testId="harness-status-error" alert>
          {statusError}
        </Callout>
      )}
      {status && (
        <div data-testid="harness-status" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--cc-dim)", marginBottom: 10 }}>
          <span>Launcher: {status.launcher || "not found"}</span>
          <span>Node: {status.node_version || "unknown"} {status.node_ok ? "(ok)" : "(too old)"}</span>
        </div>
      )}

      <div style={FIELD_GRID}>
        <span style={LABEL}>Key</span>
        <input
          type="password"
          data-testid="harness-key-input"
          aria-label="Plexar Harness key"
          placeholder="plx_…"
          value={keyDraft}
          disabled={keyBusy}
          onChange={(e) => {
            setKeyDraft(e.target.value);
            setKeySaved(false);
          }}
          style={{
            height: 30,
            padding: "0 9px",
            borderRadius: 8,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
            fontFamily: MONO,
            fontSize: 12,
          }}
        />
        <div className="flex items-center gap-2">
          <ActionButton label="Save" accent testId="harness-key-save" onClick={saveKey} disabled={keyBusy || !keyDraft.trim()} />
          <ActionButton label="Clear" testId="harness-key-clear" onClick={clearKey} disabled={keyBusy || status?.key_source !== "settings"} icon={KeyRound} />
        </div>
      </div>
      {status?.key_source === "environment" && !keySaved && (
        <Callout token="var(--cc-idle)" testId="harness-key-env">
          Using PLEXAR_HARNESS_KEY from your environment. Save a key here to override it.
        </Callout>
      )}
      {status?.key_source === "settings" && !keySaved && (
        <Callout token="var(--cc-idle)" testId="harness-key-settings">
          A key is saved in Studio.
        </Callout>
      )}
      {keySaved && (
        <Callout token="var(--cc-idle)" testId="harness-key-saved">
          Key saved.
        </Callout>
      )}
      {keyError && (
        <Callout token="var(--cc-error)" testId="harness-key-error" alert>
          {keyError}
        </Callout>
      )}

      <div style={{ ...FIELD_GRID, gridTemplateColumns: "200px 1fr" }}>
        <span style={LABEL}>Permission mode</span>
        <select
          aria-label="Plexar Harness permission mode"
          data-testid="harness-permission-mode"
          value={permissionModeDraft}
          onChange={(e) => setField("harness.permission_mode", e.target.value)}
          style={{
            height: 30,
            padding: "0 9px",
            borderRadius: 8,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
            fontSize: 12,
          }}
        >
          {HARNESS_PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default function RemoteSettings({ get, setField }) {
  const enabledDraft = Boolean(get("remote.enabled", false));
  const hostnameDraft = get("remote.hostname", "") || "";
  const accessRequiredDraft = Boolean(get("remote.access_required", false));

  const [cfStatus, setCfStatus] = useState(null); // {installed, path, version, running}
  const [cfStatusError, setCfStatusError] = useState(null);

  const [cfConfig, setCfConfig] = useState(null); // {hostname, config_yml, commands}
  const [cfConfigError, setCfConfigError] = useState(null);
  const [cfConfigBusy, setCfConfigBusy] = useState(false);

  const [probeResult, setProbeResult] = useState(null); // {hostname, classification, status}
  const [probeError, setProbeError] = useState(null);
  const [probeBusy, setProbeBusy] = useState(false);

  const [status, setStatus] = useState(null); // {enabled, hostname, protocol, devices}
  const [statusError, setStatusError] = useState(null);

  const [pairing, setPairing] = useState(null); // {code, expires_at, url, qr_payload}
  const [pairingError, setPairingError] = useState(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState(null);

  // ── Studio-managed connector ───────────────────────────
  // `tokenDraft` is the ONLY place the token ever lives in this component, and
  // it is cleared the moment the PUT lands. Nothing reads it back from the
  // server — the server never returns it.
  const [tunnel, setTunnel] = useState(null);
  const [tunnelError, setTunnelError] = useState(null);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenEditing, setTokenEditing] = useState(false);
  const [tokenError, setTokenError] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState(null);

  const [now, setNow] = useState(Date.now());
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/remote/status");
      const data = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!res.ok) {
        setStatusError(data?.error || "Could not load remote status");
        return;
      }
      setStatus(data);
      setStatusError(null);
    } catch {
      if (mounted.current) setStatusError("Could not load remote status");
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const loadCloudflaredStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/remote/cloudflared");
      const data = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!res.ok) {
        setCfStatusError(data?.error || "Could not read cloudflared status");
        return;
      }
      setCfStatus(data);
      setCfStatusError(null);
    } catch {
      if (mounted.current) setCfStatusError("Could not read cloudflared status");
    }
  }, []);

  useEffect(() => {
    loadCloudflaredStatus();
  }, [loadCloudflaredStatus]);

  const generateConfig = useCallback(async () => {
    setCfConfigBusy(true);
    setCfConfigError(null);
    try {
      const res = await fetch(
        `/api/remote/cloudflared-config?hostname=${encodeURIComponent(hostnameDraft)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCfConfigError(data?.error || "Could not generate config");
        setCfConfig(null);
        return;
      }
      setCfConfig(data);
    } catch {
      setCfConfigError("Could not generate config");
      setCfConfig(null);
    } finally {
      if (mounted.current) setCfConfigBusy(false);
    }
  }, [hostnameDraft]);

  const runProbe = useCallback(async () => {
    setProbeBusy(true);
    setProbeError(null);
    try {
      const res = await fetch("/api/remote/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: hostnameDraft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProbeError(data?.error || "Could not test public URL");
        setProbeResult(null);
        return;
      }
      setProbeResult(data);
    } catch {
      setProbeError("Could not test public URL");
      setProbeResult(null);
    } finally {
      if (mounted.current) setProbeBusy(false);
    }
  }, [hostnameDraft]);

  const loadTunnel = useCallback(async () => {
    try {
      const res = await fetch("/api/remote/tunnel");
      const data = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!res.ok) {
        setTunnelError(data?.error || "Could not read the connector status");
        return;
      }
      setTunnel(data);
      setTunnelError(null);
    } catch {
      if (mounted.current) setTunnelError("Could not read the connector status");
    }
  }, []);

  // Polled while this page is mounted — the connector's state changes without
  // anyone clicking (it crashes, it reconnects), so a one-shot read would go
  // stale on screen.
  useEffect(() => {
    loadTunnel();
    const id = setInterval(loadTunnel, TUNNEL_POLL_MS);
    return () => clearInterval(id);
  }, [loadTunnel]);

  const tunnelAction = useCallback(
    async (path, failure) => {
      setTunnelBusy(true);
      setTunnelError(null);
      try {
        const res = await fetch(path, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setTunnelError(data?.error || failure);
          return;
        }
        setTunnel(data);
      } catch {
        setTunnelError(failure);
      } finally {
        if (mounted.current) setTunnelBusy(false);
      }
    },
    []
  );

  const saveToken = useCallback(async () => {
    const value = tokenDraft.trim();
    if (!value) {
      setTokenError("Paste the connector token first.");
      return;
    }
    setTunnelBusy(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/remote/tunnel/token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTokenError(data?.error || "Could not save the token");
        return;
      }
      // Out of state immediately: a submitted secret has no reason to stay in
      // a React tree that a devtools inspection can read.
      setTokenDraft("");
      setTokenEditing(false);
      await loadTunnel();
    } catch {
      setTokenError("Could not save the token");
    } finally {
      if (mounted.current) setTunnelBusy(false);
    }
  }, [tokenDraft, loadTunnel]);

  // The toggle saves itself (its own PUT to /api/settings) rather than
  // waiting for the page's Save button — "run when Studio starts" is
  // supposed to also mean "run right now", and the server's settings PUT
  // handler reconciles the connector synchronously with the write. Poll the
  // tunnel status right away, plus once more shortly after, so the state dot
  // moves within about a second instead of waiting for the next 3s tick.
  const toggleAutostart = useCallback(
    async (checked) => {
      setField("remote.tunnel.autostart", checked);
      setField("remote.tunnel.enabled", checked);
      setAutostartBusy(true);
      setAutostartError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remote: { tunnel: { autostart: checked, enabled: checked } } }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setAutostartError(data?.error || "Could not save");
          return;
        }
        await loadTunnel();
        setTimeout(loadTunnel, 1000);
      } catch {
        setAutostartError("Could not save");
      } finally {
        if (mounted.current) setAutostartBusy(false);
      }
    },
    [setField, loadTunnel]
  );

  const removeToken = useCallback(async () => {
    setTunnelBusy(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/remote/tunnel/token", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTokenError(data?.error || "Could not remove the token");
        return;
      }
      setTokenDraft("");
      setTokenEditing(false);
      await loadTunnel();
    } catch {
      setTokenError("Could not remove the token");
    } finally {
      if (mounted.current) setTunnelBusy(false);
    }
  }, [loadTunnel]);

  // Live countdown for an active pairing.
  useEffect(() => {
    if (!pairing) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairing]);

  // Render the QR from the server's qr_payload string, verbatim.
  useEffect(() => {
    let cancelled = false;
    if (!pairing?.qr_payload) {
      setQrDataUrl(null);
      return undefined;
    }
    QRCode.toDataURL(pairing.qr_payload, { margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  const startPairing = useCallback(async () => {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const res = await fetch("/api/remote/pairings", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPairingError(data?.error || "Could not start pairing");
        setPairing(null);
        return;
      }
      setPairing(data);
    } catch {
      setPairingError("Could not start pairing");
      setPairing(null);
    } finally {
      if (mounted.current) setPairingBusy(false);
    }
  }, []);

  const requestRevoke = useCallback((device) => {
    setRevokeTarget(device);
    setRevokeError(null);
  }, []);

  const cancelRevoke = useCallback(() => {
    if (revokeBusy) return;
    setRevokeTarget(null);
    setRevokeError(null);
  }, [revokeBusy]);

  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/remote/devices/${encodeURIComponent(revokeTarget.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRevokeError(data?.error || "Could not revoke this device");
        return;
      }
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              devices: prev.devices.filter((d) => d.id !== revokeTarget.id),
            }
          : prev
      );
      setRevokeTarget(null);
    } catch {
      setRevokeError("Could not revoke this device");
    } finally {
      if (mounted.current) setRevokeBusy(false);
    }
  }, [revokeTarget]);

  const left = pairing ? secondsLeft(pairing.expires_at, now) : 0;
  const expired = pairing ? left <= 0 : false;

  const tunnelState = tunnel?.state || "stopped";
  const tunnelToken = TUNNEL_STATE_TOKEN[tunnelState] || "var(--cc-muted)";
  const tunnelInstalled = Boolean(tunnel?.installed);
  const tokenSet = Boolean(tunnel?.token_set);
  const tunnelActive = tunnelState === "running" || tunnelState === "starting";
  // One reason, in the order the user has to fix them.
  const startBlockedReason = !tokenSet
    ? "Paste a connector token first."
    : !tunnelInstalled
      ? "cloudflared is not installed on this machine."
      : null;
  const autostartDraft = Boolean(get("remote.tunnel.autostart", true)) && Boolean(get("remote.tunnel.enabled", false));
  const logTail = (tunnel?.log_tail || []).slice(-20);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      {/* ── Remote access toggle ─────────────────────────── */}
      <div style={CARD} data-testid="card-remote-toggle">
        <CardHeader icon={RadioTower} token="var(--cc-accent)" name="Remote access" />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 0 4px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            data-testid="remote-enabled-toggle"
            checked={enabledDraft}
            onChange={(e) => setField("remote.enabled", e.target.checked)}
          />
          <span style={{ fontSize: 12, color: "var(--cc-fg)" }}>
            Enable remote access from Plexar Mobile
          </span>
        </label>
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 8px" }}>
          Off by default. When off, every <code>/remote/v1/*</code> route (pairing included)
          answers 404. Turning this on and saving lets a paired phone list sessions, start one, and
          attach to its live output through a tunnel you control.
        </p>

        <div style={{ marginTop: 4 }}>
          <div style={LABEL}>Public URL</div>
          <input
            type="text"
            data-testid="remote-hostname-input"
            value={hostnameDraft}
            onChange={(e) => setField("remote.hostname", e.target.value)}
            placeholder="https://studio.example.com"
            style={{
              width: "100%",
              maxWidth: 420,
              height: 28,
              marginTop: 4,
              borderRadius: 8,
              padding: "0 8px",
              fontFamily: "inherit",
              fontSize: 11,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
            }}
          />
          <p style={{ fontSize: 10, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 0" }}>
            The base URL a phone should use, e.g. your Cloudflare Tunnel hostname. Leave empty to
            fall back to this machine&rsquo;s LAN address in the pairing QR.
          </p>
        </div>

        {statusError && (
          <Callout token="var(--cc-error)" testId="status-error" alert>
            {statusError}
          </Callout>
        )}
      </div>

      {/* ── Pair a phone ─────────────────────────────────── */}
      <div style={CARD} data-testid="card-pairing">
        <CardHeader icon={QrCode} token="var(--cc-macro)" name="Pair a phone" />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0 2px" }}>
          <ActionButton
            label={pairingBusy ? "Starting…" : "Pair a phone"}
            icon={Smartphone}
            accent
            testId="start-pairing"
            onClick={status?.enabled ? startPairing : undefined}
            disabled={!status?.enabled || pairingBusy}
            title={
              status?.enabled
                ? "Generate a one-time pairing code and QR for Plexar Mobile"
                : "Enable remote access and save changes first."
            }
          />
          {!status?.enabled && (
            <span data-testid="pairing-disabled-reason" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
              Remote access is off, so pairing is disabled. Enable it above and save changes.
            </span>
          )}
        </div>

        {pairingError && (
          <Callout token="var(--cc-error)" testId="pairing-error" alert>
            {pairingError}
          </Callout>
        )}

        {pairing && (
          <div
            data-testid="pairing-result"
            style={{
              display: "flex",
              gap: 16,
              alignItems: "flex-start",
              marginTop: 12,
              flexWrap: "wrap",
            }}
          >
            {qrDataUrl && (
              <img
                data-testid="pairing-qr"
                src={qrDataUrl}
                alt="Pairing QR code"
                width={140}
                height={140}
                style={{ borderRadius: 8, background: "#fff", padding: 6 }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={LABEL}>Code</div>
              <div
                data-testid="pairing-code"
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  fontFamily: "var(--font-mono, monospace)",
                  letterSpacing: "0.06em",
                  color: expired ? "var(--cc-muted)" : "var(--cc-fg)",
                  padding: "4px 0",
                }}
              >
                {pairing.code}
              </div>
              <div data-testid="pairing-expiry" style={{ fontSize: 11, color: "var(--cc-dim)" }}>
                {expired ? "Expired — start a new pairing." : `Expires in ${left}s`}
              </div>
              {pairing.url && (
                <div style={{ fontSize: 10, color: "var(--cc-muted)", marginTop: 4, overflowWrap: "anywhere" }}>
                  {pairing.url}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Your own Cloudflare deployment ───────────────────── */}
      <div style={CARD} data-testid="card-cloudflare-deployment">
        <CardHeader icon={Cloud} token="var(--cc-macro)" name="Your own Cloudflare deployment" />
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 8px" }}>
          The Cloudflare Tunnel is transport only — it carries traffic to this machine. Pairing is
          the lock: a phone still needs a device token minted above to do anything once it arrives.
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0 8px", cursor: "pointer" }}>
          <input
            type="checkbox"
            data-testid="access-required-toggle"
            checked={accessRequiredDraft}
            onChange={(e) => setField("remote.access_required", e.target.checked)}
          />
          <span style={{ fontSize: 12, color: "var(--cc-fg)" }}>
            Cloudflare Access is required in front of this tunnel
          </span>
        </label>

        <div style={{ fontSize: 11, color: "var(--cc-dim)", margin: "4px 0 10px" }}>
          {cfStatusError ? (
            <span data-testid="cloudflared-status-error" style={{ color: "var(--cc-error)" }}>
              {cfStatusError}
            </span>
          ) : cfStatus ? (
            <span data-testid="cloudflared-status-line">
              cloudflared: {cfStatus.installed ? `installed${cfStatus.version ? ` (${cfStatus.version})` : ""}` : "not found"}
              {" · "}
              {cfStatus.running ? "running" : "not running"}
            </span>
          ) : (
            "Checking cloudflared…"
          )}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ActionButton
            label={cfConfigBusy ? "Generating…" : "Generate config"}
            testId="generate-config"
            onClick={hostnameDraft ? generateConfig : undefined}
            disabled={!hostnameDraft || cfConfigBusy}
            title={hostnameDraft ? "Generate the cloudflared config and commands" : "Enter a public URL above first."}
          />
          <ActionButton
            label={probeBusy ? "Testing…" : "Test public URL"}
            testId="probe-public-url"
            onClick={hostnameDraft ? runProbe : undefined}
            disabled={!hostnameDraft || probeBusy}
            title={hostnameDraft ? "Probe your public hostname from this server" : "Enter a public URL above first."}
          />
        </div>
        {!hostnameDraft && (
          <span data-testid="cloudflare-tools-disabled-reason" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
            {" "}Enter a public URL above to generate a config or test it.
          </span>
        )}

        {cfConfigError && (
          <Callout token="var(--cc-error)" testId="config-error" alert>
            {cfConfigError}
          </Callout>
        )}

        {cfConfig && (
          <div data-testid="cloudflared-config-result" style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={LABEL}>config.yml</div>
              <CopyButton text={cfConfig.config_yml} testId="copy-config-yml" />
            </div>
            <pre
              data-testid="cloudflared-config-yml"
              style={{
                fontSize: 10,
                lineHeight: 1.5,
                background: "var(--cc-elev)",
                border: "1px solid var(--cc-border)",
                borderRadius: 8,
                padding: 10,
                margin: "4px 0 10px",
                overflowX: "auto",
                whiteSpace: "pre",
              }}
            >
              {cfConfig.config_yml}
            </pre>

            <div style={LABEL}>Commands</div>
            <ol data-testid="cloudflared-commands" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {(cfConfig.commands || []).map((cmd, idx) => (
                <li
                  key={idx}
                  style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}
                >
                  <code style={{ fontSize: 10, color: "var(--cc-fg)", overflowWrap: "anywhere" }}>{cmd}</code>
                  <CopyButton text={cmd} testId={`copy-command-${idx}`} label="" />
                </li>
              ))}
            </ol>
          </div>
        )}

        {probeError && (
          <Callout token="var(--cc-error)" testId="probe-error" alert>
            {probeError}
          </Callout>
        )}

        {probeResult && (
          <div data-testid="probe-result" style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>
              {probeResult.classification}
            </div>
            <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-dim)", margin: "4px 0 0" }}>
              {PROBE_HINTS[probeResult.classification] || "Unrecognized classification."}
            </p>
          </div>
        )}
      </div>

      {/* ── Tunnel connector (Studio-managed) ─────────────── */}
      <div style={CARD} data-testid="card-tunnel-connector">
        <CardHeader icon={Plug} token="var(--cc-accent)" name="Tunnel connector" />
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 8px" }}>
          Studio runs <code>cloudflared</code> for you — hidden, and restarted automatically if it
          dies. Paste the connector token from your Cloudflare dashboard and press Start. The token
          is stored with your API keys, never in the exportable settings file, and is never shown
          again.
        </p>

        <div
          data-testid="tunnel-state"
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0 8px" }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: tunnelToken,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: tunnelToken }}>{tunnelState}</span>
          <span style={{ fontSize: 11, color: "var(--cc-dim)" }} data-testid="tunnel-counters">
            {tunnel?.connections ?? 0} connection{(tunnel?.connections ?? 0) === 1 ? "" : "s"}
            {" · "}
            {tunnel?.restarts ?? 0} restart{(tunnel?.restarts ?? 0) === 1 ? "" : "s"}
          </span>
        </div>

        <div style={{ fontSize: 11, color: "var(--cc-dim)", marginBottom: 8 }}>
          {tunnelInstalled ? (
            <span data-testid="tunnel-binary">{tunnel?.binary}</span>
          ) : (
            <span data-testid="tunnel-not-installed">
              cloudflared not found — install it: <code>{WINGET_LINE}</code>
            </span>
          )}
        </div>

        {/* Token */}
        <div style={{ marginBottom: 10 }}>
          <div style={LABEL}>Connector token</div>
          {tokenSet && !tokenEditing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <span data-testid="tunnel-token-set" style={{ fontSize: 11, color: "var(--cc-idle)" }}>
                Token set
              </span>
              <ActionButton
                label="Replace"
                testId="tunnel-token-replace"
                onClick={() => setTokenEditing(true)}
                disabled={tunnelBusy}
              />
              <ActionButton
                label="Remove"
                danger
                testId="tunnel-token-remove"
                onClick={removeToken}
                disabled={tunnelBusy}
              />
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <input
                type="password"
                data-testid="tunnel-token-input"
                aria-label="Connector token"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="eyJhIjoi…"
                autoComplete="off"
                style={{
                  flex: "1 1 260px",
                  maxWidth: 420,
                  height: 28,
                  borderRadius: 8,
                  padding: "0 8px",
                  fontFamily: "inherit",
                  fontSize: 11,
                  background: "var(--cc-elev)",
                  border: "1px solid var(--cc-border)",
                  color: "var(--cc-fg)",
                }}
              />
              <ActionButton
                label={tunnelBusy ? "Saving…" : "Save token"}
                testId="tunnel-token-save"
                onClick={saveToken}
                disabled={tunnelBusy || !tokenDraft.trim()}
                title={tokenDraft.trim() ? "Store the connector token" : "Paste the connector token first."}
              />
              {tokenSet && (
                <ActionButton
                  label="Cancel"
                  testId="tunnel-token-cancel"
                  onClick={() => {
                    setTokenDraft("");
                    setTokenEditing(false);
                  }}
                  disabled={tunnelBusy}
                />
              )}
            </div>
          )}
          {tokenError && (
            <Callout token="var(--cc-error)" testId="tunnel-token-error" alert>
              {tokenError}
            </Callout>
          )}
        </div>

        {/* Start / stop */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {tunnelActive ? (
            <ActionButton
              label={tunnelBusy ? "Stopping…" : "Stop"}
              testId="tunnel-stop"
              onClick={() => tunnelAction("/api/remote/tunnel/stop", "Could not stop the connector")}
              disabled={tunnelBusy}
            />
          ) : (
            <ActionButton
              label={tunnelBusy ? "Starting…" : "Start"}
              accent
              testId="tunnel-start"
              onClick={
                startBlockedReason
                  ? undefined
                  : () => tunnelAction("/api/remote/tunnel/start", "Could not start the connector")
              }
              disabled={Boolean(startBlockedReason) || tunnelBusy}
              title={startBlockedReason || "Start the Cloudflare connector"}
            />
          )}
          {startBlockedReason && !tunnelActive && (
            <span data-testid="tunnel-disabled-reason" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
              {startBlockedReason}
            </span>
          )}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0 2px", cursor: "pointer" }}>
          <input
            type="checkbox"
            data-testid="tunnel-autostart-toggle"
            checked={autostartDraft}
            disabled={autostartBusy}
            onChange={(e) => toggleAutostart(e.target.checked)}
          />
          <span style={{ fontSize: 12, color: "var(--cc-fg)" }}>Run when Studio starts</span>
        </label>
        {autostartError && (
          <Callout token="var(--cc-error)" testId="tunnel-autostart-error" alert>
            {autostartError}
          </Callout>
        )}

        {tunnel?.foreign_running && (
          <Callout token="var(--cc-waiting)" testId="tunnel-foreign-note">
            Another cloudflared is already running outside Studio. Stop it first, or leave this off
            — two connectors for the same tunnel will fight over the same hostname.
          </Callout>
        )}

        {tunnel?.last_error && (
          <Callout token="var(--cc-error)" testId="tunnel-last-error" alert>
            {tunnel.last_error}
          </Callout>
        )}

        {tunnelError && (
          <Callout token="var(--cc-error)" testId="tunnel-error" alert>
            {tunnelError}
          </Callout>
        )}

        <div style={{ marginTop: 10 }}>
          <ActionButton
            label={logOpen ? "Hide log" : "Show log"}
            testId="tunnel-log-toggle"
            onClick={() => setLogOpen((v) => !v)}
          />
          {logOpen && (
            <pre
              data-testid="tunnel-log"
              style={{
                fontSize: 10,
                lineHeight: 1.5,
                background: "var(--cc-elev)",
                border: "1px solid var(--cc-border)",
                borderRadius: 8,
                padding: 10,
                margin: "8px 0 0",
                maxHeight: 220,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {logTail.length ? logTail.join("\n") : "No output yet."}
            </pre>
          )}
        </div>
      </div>

      {/* ── Plexar Harness ────────────────────────────────── */}
      <HarnessCard get={get} setField={setField} />

      {/* ── Devices ───────────────────────────────────────── */}
      <div style={CARD} data-testid="card-devices">
        <CardHeader icon={ShieldOff} token="var(--cc-waiting)" name="Devices" />
        <DevicesTable devices={status?.devices} onRevokeRequest={requestRevoke} />
      </div>

      {revokeTarget && (
        <RevokeConfirm
          device={revokeTarget}
          onCancel={cancelRevoke}
          onConfirm={confirmRevoke}
          busy={revokeBusy}
          error={revokeError}
        />
      )}
    </div>
  );
}
