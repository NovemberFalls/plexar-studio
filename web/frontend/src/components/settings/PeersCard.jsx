/**
 * Settings > Remote > "Machines this one controls": pair this Studio with another
 * machine's Studio (docs/studio-peers-v1.md), see each one's status, remove
 * it, and set or clear its Cloudflare Access service token.
 *
 * Secrets are WRITE-ONLY here. The server never returns a device token or an
 * Access secret (only `access_token_set`), and these fields are cleared after
 * every submit, so nothing typed is ever shown back. Every submit is awaited
 * and its failure rendered inline; there is no native dialog anywhere.
 */
import { useEffect, useState } from "react";
import { Monitor, TriangleAlert } from "lucide-react";
import usePeers, { refreshPeers, checkPeerStatus } from "../../hooks/usePeers";
import { peersApi, describePeerStatus, accessPairError, parsePairingLink } from "../../utils/peers";

const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

const INPUT = {
  height: 28,
  padding: "0 9px",
  borderRadius: 7,
  fontSize: 11,
  fontFamily: "inherit",
  color: "var(--cc-fg)",
  background: "var(--cc-elev)",
  border: "1px solid var(--cc-border)",
  outline: "none",
  minWidth: 0,
};

function Button({ label, onClick, disabled, accent, danger, testId, type = "button" }) {
  return (
    <button
      type={type}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded transition-colors hover-bg-elevated"
      style={{
        height: 26,
        padding: "0 12px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 7,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: accent && !disabled ? "#0f1216" : danger ? "var(--cc-error)" : "var(--cc-fg)",
        border: `1px solid ${accent && !disabled ? "transparent" : "var(--cc-border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function InlineError({ text, testId }) {
  if (!text) return null;
  return (
    <div role="alert" data-testid={testId} style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--cc-error)", marginTop: 6 }}>
      <TriangleAlert size={12} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

/** One status line. Each reason has its own label, colour and remedy. */
export function PeerStatusLine({ status }) {
  const d = describePeerStatus(status);
  return (
    <div data-testid="peer-status" data-reason={d.reason || (d.ok ? "ok" : "checking")} style={{ fontSize: 11, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 700, color: d.token }}>{d.label}</span>
      {d.remedy && <span style={{ color: "var(--cc-dim)" }}>{` · ${d.remedy}`}</span>}
    </div>
  );
}

function AccessForm({ peer, onDone }) {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (clear) => {
    const bad = clear ? "" : accessPairError(id, secret);
    if (bad || (!clear && !id.trim())) { setError(bad || "Give the client id and secret, or use Clear."); return; }
    setBusy(true);
    setError("");
    const body = clear ? { cf_client_id: null, cf_client_secret: null } : { cf_client_id: id.trim(), cf_client_secret: secret.trim() };
    const r = await peersApi.setAccess(peer.id, body);
    setBusy(false);
    setId("");
    setSecret("");
    if (!r.ok) { setError(r.error); return; }
    await refreshPeers();
    await checkPeerStatus(peer.id);
    onDone();
  };

  return (
    <div data-testid="peer-access-form" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input style={{ ...INPUT, flex: 1 }} aria-label="Access client id" placeholder="Access client id" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" />
        <input style={{ ...INPUT, flex: 1 }} type="password" aria-label="Access client secret" placeholder="Access client secret" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button label="Save token" accent onClick={() => submit(false)} disabled={busy} testId="peer-access-save" />
        {peer.access_token_set && <Button label="Clear token" onClick={() => submit(true)} disabled={busy} testId="peer-access-clear" />}
        <Button label="Cancel" onClick={onDone} disabled={busy} />
      </div>
      <InlineError text={error} testId="peer-access-error" />
    </div>
  );
}

function PeerRow({ peer, live }) {
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const remove = async () => {
    setBusy(true);
    setError("");
    const r = await peersApi.remove(peer.id);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setConfirmRemove(false);
    await refreshPeers();
  };

  return (
    <div data-testid={`peer-row-${peer.id}`} style={{ padding: "10px 0", borderBottom: "1px solid var(--cc-line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>{peer.label || peer.id}</span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)", fontFamily: "var(--font-mono, monospace)" }}>{peer.url}</span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
          {peer.access_token_set ? "Access token set" : "No Access token"}
        </span>
        <span style={{ flex: 1 }} />
        <Button label="Check" onClick={() => checkPeerStatus(peer.id)} testId={`peer-check-${peer.id}`} />
        <Button label={peer.access_token_set ? "Change Access token" : "Set Access token"} onClick={() => setAccessOpen((v) => !v)} testId={`peer-access-${peer.id}`} />
        <Button label="Remove" danger onClick={() => setConfirmRemove(true)} testId={`peer-remove-${peer.id}`} />
      </div>
      <PeerStatusLine status={live?.status} />
      {accessOpen && <AccessForm peer={peer} onDone={() => setAccessOpen(false)} />}
      {confirmRemove && (
        <div role="group" aria-label="Confirm remove" data-testid="peer-remove-confirm" style={{ marginTop: 8, padding: "8px 10px", borderRadius: 9, background: tint("var(--cc-error)", 8), border: `1px solid ${tint("var(--cc-error)", 35)}` }}>
          <div style={{ fontSize: 11, color: "var(--cc-fg)", marginBottom: 6 }}>
            Forget {peer.label || peer.id}? This removes its token here only. To cut it off on that side too, revoke this computer in its Settings &gt; Remote.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button label="Forget machine" danger onClick={remove} disabled={busy} testId="peer-remove-yes" />
            <Button label="Keep" onClick={() => setConfirmRemove(false)} disabled={busy} />
          </div>
        </div>
      )}
      <InlineError text={error} testId="peer-remove-error" />
    </div>
  );
}

function AddPeerForm() {
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkOk, setLinkOk] = useState(false);
  const [linkAccess, setLinkAccess] = useState(false);
  const [accessFailed, setAccessFailed] = useState(false);
  const [manual, setManual] = useState(false);
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [cfId, setCfId] = useState("");
  const [cfSecret, setCfSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onLink = (text) => {
    setLink(text);
    if (!text.trim()) { setLinkError(""); setLinkOk(false); setLinkAccess(false); return; }
    const r = parsePairingLink(text);
    if (!r.ok) { setLinkError(r.error); setLinkOk(false); setLinkAccess(false); return; }
    setLinkError("");
    setLinkOk(true);
    setLinkAccess(r.access);
    setUrl(r.url);
    setCode(r.code);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim() || !code.trim()) { setError("Paste the pairing link from the other computer's Settings > Remote, or enter its address and a pairing code by hand."); return; }
    const bad = accessPairError(cfId, cfSecret);
    if (bad) { setError(bad); return; }
    setBusy(true);
    setError("");
    const r = await peersApi.add({
      url: url.trim(),
      code: code.trim(),
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(cfId.trim() ? { cf_client_id: cfId.trim(), cf_client_secret: cfSecret.trim() } : {}),
    });
    setBusy(false);
    // Secrets never stay in the form, whatever the outcome. The link carries the
    // code, so it goes too.
    setCfSecret("");
    setCode("");
    setLink("");
    setLinkOk(false);
    if (!r.ok) {
      if (r.reason === "access_required" || r.reason === "access_refused") setAccessFailed(true);
      setError(r.reason ? `${r.error}: ${describePeerStatus({ reason: r.reason }).remedy}` : r.error);
      return;
    }
    setUrl("");
    setLabel("");
    setCfId("");
    setLinkAccess(false);
    setAccessFailed(false);
    await refreshPeers();
    if (r.data?.peer?.id) checkPeerStatus(r.data.peer.id);
  };

  const showFields = manual || linkOk || accessFailed;
  const showAccess = linkAccess || accessFailed;

  return (
    <form onSubmit={submit} data-testid="peer-add-form" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--cc-fg)" }}>Pair another machine</div>
      <input style={{ ...INPUT, width: "100%" }} aria-label="Pairing link" placeholder="Paste the pairing link from the other computer" value={link} onChange={(e) => onLink(e.target.value)} autoComplete="off" spellCheck={false} />
      <InlineError text={linkError} testId="peer-link-error" />
      <div>
        <Button label={manual ? "Hide the details" : "Enter the details by hand"} onClick={() => setManual((v) => !v)} testId="peer-manual-toggle" />
      </div>
      {showFields && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input style={{ ...INPUT, flex: 2 }} aria-label="Machine address" placeholder="https://studio.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input style={{ ...INPUT, flex: 1 }} aria-label="Pairing code" placeholder="Pairing code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
          <input style={{ ...INPUT, flex: 1 }} aria-label="Label" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      )}
      {showAccess && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input style={{ ...INPUT, flex: 1 }} aria-label="Access client id (optional)" placeholder="Access client id (optional)" value={cfId} onChange={(e) => setCfId(e.target.value)} autoComplete="off" />
          <input style={{ ...INPUT, flex: 1 }} type="password" aria-label="Access client secret (optional)" placeholder="Access client secret (optional)" value={cfSecret} onChange={(e) => setCfSecret(e.target.value)} autoComplete="new-password" />
        </div>
      )}
      <div><Button type="submit" label={busy ? "Pairing..." : "Pair machine"} accent disabled={busy} testId="peer-add" /></div>
      <InlineError text={error} testId="peer-add-error" />
    </form>
  );
}

export default function PeersCard() {
  const { peers, live, loaded, error } = usePeers();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await refreshPeers();
      if (cancelled || !r.ok) return;
      for (const p of r.data?.peers || []) checkPeerStatus(p.id);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={CARD} data-testid="card-peers">
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 10, borderBottom: "1px solid var(--cc-line)" }}>
        <Monitor size={13} style={{ color: "var(--cc-accent)" }} aria-hidden="true" />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>Other machines</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--cc-dim)", marginTop: 8, lineHeight: 1.5 }}>
        On the other computer open Settings &gt; Remote, click Pair a device, copy the pairing link, and paste it here. Its sessions then appear in the sidebar.
      </div>
      <InlineError text={error} testId="peers-load-error" />
      {loaded && peers.length === 0 && !error && (
        <div style={{ fontSize: 11, color: "var(--cc-muted)", marginTop: 8 }}>No machines paired yet.</div>
      )}
      {peers.map((p) => <PeerRow key={p.id} peer={p} live={live[p.id]} />)}
      <AddPeerForm />
    </div>
  );
}
