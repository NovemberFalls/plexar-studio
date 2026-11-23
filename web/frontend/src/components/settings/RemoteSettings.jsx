/**
 * RemoteSettings — the Settings ▸ Remote page (Studio Remote / Plexar Mobile pairing).
 *
 * Two tabs, because the page serves two unrelated jobs. "Let devices in" is a
 * 1-2-3 flow in the order a person has to do it: (1) turn remote access on,
 * (2) say how other devices reach this machine, (3) pair a device, then the
 * paired devices. Once steps 1 and 2 are saved they fold into one status line,
 * since setup happens once and the device list is what people come back for.
 * "Control another machine" is the OTHER direction (PeersCard) and needs none
 * of those steps. The Plexar Harness card lives in Keys & secrets.
 *
 * Step 2 has three answers. Two are an address that reaches this machine from
 * outside (a tunnel Studio runs, or one the user already has). The third,
 * "Only devices on this network", is `remote.lan.enabled`: Studio opens a
 * second port that serves only the paired-device routes (remote_lan.py), so no
 * account or domain is needed. It is the one answer that IS a setting.
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
import { Cloud, Copy, RadioTower, QrCode, ShieldOff, Smartphone, TriangleAlert } from "lucide-react";
import QRCode from "qrcode";
import PeersCard from "./PeersCard";

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

/** An active device not seen for this long is flagged: it is still a live credential. */
const STALE_AFTER_DAYS = 30;

// Which tab was open last. A per-viewer convenience, not a setting.
const TAB_KEY = "plexar-remote-tab";
function readTab() {
  try {
    return localStorage.getItem(TAB_KEY) === "control" ? "control" : "host";
  } catch {
    return "host";
  }
}

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

/** Whole days since `iso`, or null when it is missing or unreadable. */
function daysSince(iso, now) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86400000);
}

function DevicesTable({ devices, onRevokeRequest, now }) {
  const [showRevoked, setShowRevoked] = useState(false);
  const all = devices || [];
  if (all.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--cc-muted)", padding: "10px 0" }}>
        No devices paired yet.
      </div>
    );
  }
  const seen = (d) => Date.parse(d.last_seen || d.created_at || "") || 0;
  // Most recently seen first: the device in use is the one being looked for.
  const active = all.filter((d) => !d.revoked_at).sort((a, b) => seen(b) - seen(a));
  const revoked = all.filter((d) => d.revoked_at);
  const rows = showRevoked ? [...active, ...revoked] : active;
  return (
    <>
      {active.length === 0 && (
        <div data-testid="devices-none-active" style={{ fontSize: 11, color: "var(--cc-muted)", padding: "10px 0 0" }}>
          No device can reach this machine right now.
        </div>
      )}
      {rows.length > 0 && (
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
            {rows.map((d) => {
              const isRevoked = Boolean(d.revoked_at);
              const idle = isRevoked ? null : daysSince(d.last_seen || d.created_at, now);
              const stale = idle !== null && idle >= STALE_AFTER_DAYS;
              return (
                <tr key={d.id} data-testid={`device-row-${d.id}`} style={{ borderTop: "1px solid var(--cc-line)" }}>
                  <td style={{ padding: "6px" }}>{d.name}</td>
                  <td style={{ padding: "6px", color: "var(--cc-dim)" }}>{fmtTime(d.created_at)}</td>
                  <td style={{ padding: "6px", color: "var(--cc-dim)" }}>{fmtTime(d.last_seen)}</td>
                  <td
                    style={{
                      padding: "6px",
                      color: isRevoked ? "var(--cc-error)" : stale ? "var(--cc-waiting)" : "var(--cc-idle)",
                    }}
                  >
                    {isRevoked ? "Revoked" : "Active"}
                    {stale && (
                      <span data-testid={`device-stale-${d.id}`}>
                        {" "}· not seen for {idle} days. Still has access; revoke it if it is not in use.
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "6px", textAlign: "right" }}>
                    {!isRevoked && (
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
      )}
      {revoked.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <ActionButton
            label={showRevoked ? "Hide revoked" : `Show ${revoked.length} revoked`}
            testId="devices-show-revoked"
            onClick={() => setShowRevoked((v) => !v)}
          />
        </div>
      )}
    </>
  );
}

export default function RemoteSettings({ get, setField }) {
  const enabledDraft = Boolean(get("remote.enabled", false));
  // The address devices use. The setting key is `remote.hostname`.
  const hostnameDraft = get("remote.hostname", "") || "";
  const accessRequiredDraft = Boolean(get("remote.access_required", false));

  const [cfStatus, setCfStatus] = useState(null); // {installed, path, version, running}
  const [cfStatusError, setCfStatusError] = useState(null);

  // Which "how do devices reach me" answer is showing. null = not chosen yet, so
  // it follows what the connector says; choosing writes NO setting.
  const [reach, setReach] = useState(null);
  const [configOpen, setConfigOpen] = useState(false);

  const [tab, setTab] = useState(readTab);
  const chooseTab = useCallback((next) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Remembering the tab is a convenience; the page works without it.
    }
  }, []);
  // null = follow the saved state: steps 1 and 2 fold away once both are saved.
  const [setupOpen, setSetupOpen] = useState(null);

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

  // Polled like the connector below: saving turns remote access or the local
  // listener on, and the pairing gate must follow without a page revisit.
  useEffect(() => {
    loadStatus();
    const id = setInterval(loadStatus, TUNNEL_POLL_MS);
    return () => clearInterval(id);
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
  const defaultReach = tokenSet || Boolean(get("remote.tunnel.enabled", false)) ? "studio-tunnel" : "own-address";
  const lanDraft = Boolean(get("remote.lan.enabled", false));
  const lanPortDraft = get("remote.lan.port", 8421);
  const reachChoice = lanDraft ? "lan" : reach ?? defaultReach;
  // Only the local-network answer is a setting; the other two are just which
  // fields to show, so choosing between them writes nothing.
  const chooseReach = (id) => {
    if (id === "lan") {
      if (!lanDraft) setField("remote.lan.enabled", true);
      return;
    }
    if (lanDraft) setField("remote.lan.enabled", false);
    setReach(id);
  };
  // Pairing needs both facts to be SAVED: the server's view, not the draft.
  const lan = status?.lan;
  const lanMode = Boolean(lan?.enabled);
  const savedAddress = lanMode ? Boolean(lan?.running) : Boolean(status?.hostname);
  const pairBlockedReason = !status?.enabled
    ? "Turn on remote access in step 1 and save."
    : !savedAddress
      ? lanMode
        ? lan?.error || "The local network listener is not running yet."
        : "Set this machine's address in step 2 and save."
      : null;
  const statusLoading = status === null && !statusError;
  const setupDone = Boolean(status?.enabled) && savedAddress;
  const showSetup = !statusLoading && (setupOpen ?? !setupDone);
  const foreignWhileHealthy = tunnelState === "running" && (tunnel?.connections ?? 0) > 0;

  const addressField = (
    <div style={{ marginTop: 8 }}>
      <div style={LABEL}>Address</div>
      <input
        type="text"
        data-testid="remote-hostname-input"
        aria-label="Address devices use to reach this machine"
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
        The web address a phone or another computer uses to reach this machine. Save changes after editing it.
      </p>
    </div>
  );

  const accessToggle = (
    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0 4px", cursor: "pointer" }}>
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
  );

  const testUrl = (
    <div style={{ marginTop: 6 }}>
      <ActionButton
        label={probeBusy ? "Testing…" : "Test public URL"}
        testId="probe-public-url"
        onClick={hostnameDraft ? runProbe : undefined}
        disabled={!hostnameDraft || probeBusy}
        title={hostnameDraft ? "Probe your public hostname from this server" : "Enter an address above first."}
      />
      {!hostnameDraft && (
        <span data-testid="cloudflare-tools-disabled-reason" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
          {" "}Enter an address above to test it.
        </span>
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
  );

  const REACH_OPTIONS = [
    { id: "studio-tunnel", label: "I have a Cloudflare Tunnel token (Studio runs the connector)" },
    { id: "own-address", label: "I already have an address for this machine" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      <div role="tablist" aria-label="Remote" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[
          { id: "host", label: "Let devices in" },
          { id: "control", label: "Control another machine" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`remote-tab-${t.id}`}
            onClick={() => chooseTab(t.id)}
            className="rounded transition-colors hover-bg-elevated"
            style={{
              height: 28,
              padding: "0 14px",
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 8,
              cursor: "pointer",
              background: tab === t.id ? tint("var(--cc-accent)", 14) : "var(--cc-elev)",
              color: tab === t.id ? "var(--cc-accent)" : "var(--cc-dim)",
              border: `1px solid ${tab === t.id ? tint("var(--cc-accent)", 45) : "var(--cc-border)"}`,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "host" && (
        <>
      {statusLoading && (
        <div data-testid="remote-loading" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
          Loading…
        </div>
      )}

      {setupDone && (
        <div style={CARD} data-testid="card-setup-summary">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-idle)" }}>Remote access is on</span>
            <span data-testid="setup-summary-address" style={{ fontSize: 12, color: "var(--cc-fg)", overflowWrap: "anywhere" }}>
              {lanMode ? lan.url : status.hostname}
            </span>
            {lanMode && (
              <span data-testid="setup-summary-lan" style={{ fontSize: 11, color: "var(--cc-dim)" }}>
                this network only
              </span>
            )}
            {!lanMode && reachChoice === "studio-tunnel" && (
              <span data-testid="setup-summary-tunnel" style={{ fontSize: 11, color: tunnelToken }}>
                connector {tunnelState}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <ActionButton
              label={showSetup ? "Hide setup" : "Change setup"}
              testId="setup-change"
              onClick={() => setSetupOpen(!showSetup)}
            />
          </div>
        </div>
      )}

      {showSetup && (
        <>
      {/* ── 1 · Remote access toggle ─────────────────────── */}
      <div style={CARD} data-testid="card-remote-toggle">
        <CardHeader icon={RadioTower} token="var(--cc-accent)" name="1 · Turn on remote access" />

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
            Enable remote access to this machine
          </span>
        </label>
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 8px" }}>
          Off by default, and while it is off nothing outside this computer can reach Studio.
          Turning this on and saving lets a device you have paired see your sessions, start one,
          and type into it.
        </p>

        {statusError && (
          <Callout token="var(--cc-error)" testId="status-error" alert>
            {statusError}
          </Callout>
        )}
      </div>

      {/* ── 2 · How devices reach this machine ───────────── */}
      <div style={CARD} data-testid="card-reach">
        <CardHeader icon={Cloud} token="var(--cc-macro)" name="2 · How devices reach this machine" />
        {!hostnameDraft && reachChoice !== "lan" && (
          <div data-testid="reach-status" style={{ fontSize: 11, color: "var(--cc-waiting)", padding: "6px 0 0" }}>
            No address set
          </div>
        )}
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "6px 0 8px" }}>
          The address only gets a device to this machine. It still has to be paired in step 3
          before it can do anything.
        </p>

        <div role="radiogroup" aria-label="How devices reach this machine" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {REACH_OPTIONS.map((o) => (
            <label key={o.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="radio"
                name="remote-reach"
                data-testid={`reach-${o.id}`}
                value={o.id}
                checked={reachChoice === o.id}
                onChange={() => chooseReach(o.id)}
              />
              <span style={{ fontSize: 12, color: "var(--cc-fg)" }}>{o.label}</span>
            </label>
          ))}
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="radio"
              name="remote-reach"
              data-testid="reach-lan"
              value="lan"
              checked={reachChoice === "lan"}
              onChange={() => chooseReach("lan")}
            />
            <span style={{ fontSize: 12, color: "var(--cc-fg)" }}>Only devices on this network</span>
          </label>
        </div>

        {reachChoice === "lan" && (
          <div data-testid="reach-lan-fields" style={{ marginTop: 8 }}>
            <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: 0 }}>
              Works while the other device is on the same network as this computer, such as your
              home Wi-Fi. No account, domain or tunnel is needed. Away from this network the
              device cannot connect.
            </p>
            <div data-testid="lan-state" style={{ fontSize: 12, padding: "8px 0 2px", color: lan?.running ? "var(--cc-idle)" : "var(--cc-dim)", overflowWrap: "anywhere" }}>
              {lan?.running && lanMode
                ? `Listening at ${lan.url}`
                : lanMode
                  ? "Not listening."
                  : "Save changes to start listening."}
            </div>
            {lan?.error && lanMode && (
              <Callout token="var(--cc-error)" testId="lan-error" alert>
                {lan.error}
              </Callout>
            )}
            <div style={{ marginTop: 8 }}>
              <div style={LABEL}>Port</div>
              <input
                type="number"
                min={1024}
                max={65535}
                data-testid="lan-port-input"
                aria-label="Port for devices on this network"
                value={lanPortDraft}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) setField("remote.lan.port", n);
                }}
                style={{
                  width: 110,
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
            </div>
            <ul data-testid="lan-notes" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: "10px 0 0", paddingLeft: 18 }}>
              <li>Windows may ask whether to allow Plexar Studio on the network. Allow it for private networks.</li>
              <li>This connection is not encrypted. Use it only on a network you trust.</li>
              <li>Only a paired device gets anything, and only the paired-device routes are offered on this port. The rest of Studio stays unreachable from the network.</li>
              <li>Another computer running Studio can connect this way today. Plexar Mobile on Android does not yet accept an unencrypted local address.</li>
            </ul>
          </div>
        )}

        {reachChoice === "studio-tunnel" && (
          <div data-testid="reach-studio-tunnel-fields" style={{ marginTop: 8 }}>
            {addressField}
            {accessToggle}
            {testUrl}
            <div style={{ marginTop: 12 }} data-testid="tunnel-connector">
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 8px" }}>
          You create the tunnel and its public hostname in your Cloudflare dashboard, then paste
          its connector token here. Studio starts the <code>cloudflared</code> program installed on
          this computer, keeps it hidden, and restarts it if it stops. The token is stored with
          your API keys, never in the exportable settings file, and is never shown again.
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
          <Callout token={foreignWhileHealthy ? "var(--cc-muted)" : "var(--cc-waiting)"} testId="tunnel-foreign-note">
            {foreignWhileHealthy
              ? "Another cloudflared is also running on this computer. That is fine if it serves a different tunnel (another app's, for example). Stop one only if both are connectors for this same tunnel."
              : "Another cloudflared is already running outside Studio. If it is a connector for this same tunnel, stop it first or leave this off: two connectors for one tunnel fight over the hostname. A connector for a different tunnel is fine."}
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
          </div>
        )}

        {reachChoice === "own-address" && (
          <div data-testid="reach-own-address-fields" style={{ marginTop: 8 }}>
            <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: 0 }}>
              Use any address that reaches this computer&rsquo;s Studio: a Cloudflare Tunnel you run
              yourself, Tailscale, a VPN, or your own reverse proxy.
            </p>
            {addressField}
            {accessToggle}
            {testUrl}

            <div style={{ marginTop: 12 }}>
              <ActionButton
                label="Cloudflare tunnel config example"
                testId="config-example-toggle"
                onClick={() => setConfigOpen((v) => !v)}
              />
              {configOpen && (
                <div data-testid="config-example" style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--cc-dim)", margin: "0 0 10px" }}>
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
                  <ActionButton
                    label={cfConfigBusy ? "Generating…" : "Generate config"}
                    testId="generate-config"
                    onClick={hostnameDraft ? generateConfig : undefined}
                    disabled={!hostnameDraft || cfConfigBusy}
                    title={hostnameDraft ? "Generate the cloudflared config and commands" : "Enter an address above first."}
                  />
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
                </div>
              )}
            </div>
          </div>
        )}
      </div>
        </>
      )}

      {/* ── 3 · Pair a device ────────────────────────────── */}
      <div style={CARD} data-testid="card-pairing">
        <CardHeader icon={QrCode} token="var(--cc-macro)" name="3 · Pair a device" />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0 2px" }}>
          <ActionButton
            label={pairingBusy ? "Starting…" : "Pair a device"}
            icon={Smartphone}
            accent
            testId="start-pairing"
            onClick={pairBlockedReason ? undefined : startPairing}
            disabled={Boolean(pairBlockedReason) || pairingBusy}
            title={pairBlockedReason || "Generate a one-time pairing code, QR and link"}
          />
          {pairBlockedReason && (
            <span data-testid="pairing-blocked-reason" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
              {pairBlockedReason}
            </span>
          )}
        </div>

        {pairingError && (
          <Callout token="var(--cc-error)" testId="pairing-error" alert>
            {pairingError}
          </Callout>
        )}

        {pairing && (
          <div data-testid="pairing-result" style={{ marginTop: 12 }}>
            <div style={LABEL}>Phone: scan this in Plexar Mobile</div>
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginTop: 6, flexWrap: "wrap" }}>
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

            <div style={{ ...LABEL, marginTop: 14 }}>Another computer: copy this pairing link</div>
            <div style={{ marginTop: 6 }}>
              <CopyButton text={pairing.qr_payload} testId="copy-pairing-link" label="Copy pairing link" />
            </div>
            <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "6px 0 0" }}>
              On the other computer, paste it into Settings &gt; Remote &gt; Control another machine.
            </p>
          </div>
        )}
      </div>

      {/* ── Devices ───────────────────────────────────────── */}
      <div style={CARD} data-testid="card-devices">
        <CardHeader icon={ShieldOff} token="var(--cc-waiting)" name="Devices that can reach this machine" />
        <DevicesTable devices={status?.devices} onRevokeRequest={requestRevoke} now={now} />
      </div>

        </>
      )}

      {/* ── The other direction ───────────────────────────── */}
      {tab === "control" && (
        <>
          <div data-testid="heading-controls">
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--cc-fg)" }}>Machines this one controls</div>
            <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 0" }}>
              Use another computer&rsquo;s Studio from this one. Nothing on the other tab needs to
              be turned on here for this to work.
            </p>
          </div>
          <PeersCard />
        </>
      )}

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
