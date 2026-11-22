/**
 * Studio peers ("other machines"), the desktop half of docs/studio-peers-v1.md.
 *
 * A peer session is an ordinary session record with `machine` set to the peer's
 * id and `remoteId` set to the session id ON THAT PEER. Its `terminalId` stays
 * null on purpose: every poll and route in App.jsx that is keyed on a LOCAL
 * terminal id (usage, workflows, subagents, bridge, popout, rename, upload,
 * quick-resume undo) already skips a session without one, so a peer pane cannot
 * leak a peer's session id into a local route. `machine` absent means null,
 * which means "this computer", so every stored record and caller is unchanged.
 *
 * The page never sees a peer token or Access secret: the sidecar holds both and
 * every call here goes through /api/peers*.
 */

export const PEER_UNAVAILABLE = "Not available for a session on another machine";

/** Each status reason has its own wording and its own remedy, because the
 *  remedies are different: waiting fixes `unreachable`, pairing again fixes
 *  `unauthorized`, and an Access token fixes the two Access reasons. */
export const PEER_REASONS = {
  unreachable: {
    label: "Unreachable",
    remedy: "No connection to that machine. Check that its Studio is running and its tunnel is up; this retries on its own.",
    token: "var(--cc-muted)",
  },
  unauthorized: {
    label: "Not authorized",
    remedy: "That Studio refused this computer's device token (revoked or unknown). Remove the machine and pair it again with a new code.",
    token: "var(--cc-error)",
  },
  access_required: {
    label: "Cloudflare Access required",
    remedy: "The machine sits behind Cloudflare Access. Set an Access service token (client id and secret) for it below.",
    token: "var(--cc-waiting)",
  },
  access_refused: {
    label: "Access token refused",
    remedy: "Cloudflare Access rejected the stored service token: it is wrong, expired or not allowed by the Access policy. Set a new one below.",
    token: "var(--cc-error)",
  },
  remote_disabled: {
    label: "Remote access is off",
    remedy: "That Studio has Studio Remote turned off. Turn it on in its Settings > Remote.",
    token: "var(--cc-waiting)",
  },
  unexpected: {
    label: "Unexpected answer",
    remedy: "The machine answered with something Studio did not recognise (a server error or a wrong address). Check the address.",
    token: "var(--cc-error)",
  },
  unknown_peer: {
    label: "Unknown machine",
    remedy: "This computer no longer knows that machine. Pair it again.",
    token: "var(--cc-error)",
  },
};

/** { ok, label, remedy, token } for a /status body, or a "checking" placeholder. */
export function describePeerStatus(status) {
  if (!status) return { ok: false, label: "Checking", remedy: "", token: "var(--cc-muted)", reason: null };
  if (!status.reason && status.reachable && status.authorized) {
    return { ok: true, label: "Connected", remedy: "", token: "var(--cc-idle)", reason: null };
  }
  const r = PEER_REASONS[status.reason] || PEER_REASONS.unexpected;
  return { ok: false, ...r, reason: status.reason || "unexpected" };
}

/** True when the session lives on another machine. */
export function isPeerSession(session) {
  return !!session?.machine;
}

/** The WebSocket path a pane connects to, or null while there is nothing to attach. */
export function sessionSocketPath(session) {
  if (!session) return null;
  if (session.machine) {
    return session.remoteId
      ? `/ws/peer/${encodeURIComponent(session.machine)}/${encodeURIComponent(session.remoteId)}`
      : null;
  }
  return session.terminalId ? `/ws/terminal/${session.terminalId}` : null;
}

// ── drag data ─────────────────────────────────────────────

export const PEER_DRAG_PREFIX = "peer:";

export function peerDragData(peerId, remoteId) {
  return `${PEER_DRAG_PREFIX}${encodeURIComponent(peerId)}/${encodeURIComponent(remoteId)}`;
}

/** { peerId, remoteId } or null. */
export function parsePeerDragData(data) {
  if (typeof data !== "string" || !data.startsWith(PEER_DRAG_PREFIX)) return null;
  const [p, s] = data.slice(PEER_DRAG_PREFIX.length).split("/");
  if (!p || !s) return null;
  try {
    return { peerId: decodeURIComponent(p), remoteId: decodeURIComponent(s) };
  } catch {
    return null;
  }
}

// ── API ───────────────────────────────────────────────────

/** Every call resolves to { ok, status, data, error, reason } and never throws:
 *  a caller renders `error`/`reason` inline instead of catching. */
async function call(path, { method = "GET", body, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(path, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data?.reason || null;
      const error = data?.error || data?.detail
        || (reason ? (PEER_REASONS[reason]?.label || reason) : `Studio answered ${res.status}`);
      return { ok: false, status: res.status, data, error, reason };
    }
    return { ok: true, status: res.status, data, error: null, reason: null };
  } catch {
    return { ok: false, status: 0, data: null, error: "Studio did not answer; try again.", reason: null };
  }
}

const seg = (v) => encodeURIComponent(v);

export const peersApi = {
  list: (o) => call("/api/peers", o),
  add: (body, o) => call("/api/peers", { ...o, method: "POST", body }),
  remove: (id, o) => call(`/api/peers/${seg(id)}`, { ...o, method: "DELETE" }),
  setAccess: (id, body, o) => call(`/api/peers/${seg(id)}/access`, { ...o, method: "PUT", body }),
  status: (id, o) => call(`/api/peers/${seg(id)}/status`, o),
  sessions: (id, o) => call(`/api/peers/${seg(id)}/sessions`, o),
  createSession: (id, body, o) => call(`/api/peers/${seg(id)}/sessions`, { ...o, method: "POST", body }),
  endSession: (id, sid, o) => call(`/api/peers/${seg(id)}/sessions/${seg(sid)}`, { ...o, method: "DELETE" }),
  workdirs: (id, o) => call(`/api/peers/${seg(id)}/workdirs`, o),
  browse: (id, path, o) => call(`/api/peers/${seg(id)}/browse?path=${encodeURIComponent(path || "")}`, o),
  catalog: (id, o) => call(`/api/peers/${seg(id)}/catalog`, o),
};

/** Both or neither, after trimming. Returns an error string or "". */
export function accessPairError(clientId, secret) {
  const a = (clientId || "").trim();
  const b = (secret || "").trim();
  if (!!a !== !!b) return "Give both the Access client id and the client secret, or neither.";
  return "";
}

/** The fields POST /api/peers/{id}/sessions passes through, from the dialog's choices. */
export function peerCreateBody({ name, workdir, harness, model, permissionMode, effort, bypassPermissions }) {
  return {
    name: name || "",
    workdir,
    harness,
    model,
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    ...(effort ? { effort } : {}),
    bypass: !!bypassPermissions,
  };
}

/** A new local record for a session on `peer`. */
export function peerSessionRecord(peer, remote, id) {
  return {
    id,
    machine: peer.id,
    machineLabel: peer.label || peer.id,
    remoteId: remote.id,
    terminalId: null,
    name: remote.name || remote.id,
    model: remote.model || "",
    harness: remote.harness || "claude-code",
    effort: remote.effort || "",
    status: "running",
    activityState: remote.activity_state,
    workdir: remote.working_dir || "",
    adoptedAt: Date.now(),
  };
}

/** Drop records whose machine is no longer paired. Only meaningful once the
 *  peer list has loaded; the same array back when nothing changed. */
export function dropUnpairedPeerSessions(prev, peerIds) {
  const known = new Set(peerIds);
  const next = prev.filter((s) => !s.machine || known.has(s.machine));
  return next.length === prev.length ? prev : next;
}

/**
 * Fold one peer's fresh session list into the local records for that peer:
 * a record whose remote session is gone is dropped (nothing here can bring it
 * back), and name/state follow the peer. Only call this with a list from a
 * SUCCESSFUL poll; an unreachable peer keeps its panes. Same array back when
 * nothing changed.
 */
export const PEER_ADOPT_GRACE_MS = 15000;

export function reconcilePeerSessions(prev, peerId, remotes, now = Date.now()) {
  const byId = new Map((remotes || []).map((r) => [r.id, r]));
  let changed = false;
  const next = [];
  for (const s of prev) {
    if (s.machine !== peerId || !s.remoteId) { next.push(s); continue; }
    const r = byId.get(s.remoteId);
    if (!r || r.alive === false) {
      // A list fetched before this session was created cannot name it yet.
      if (s.adoptedAt && now - s.adoptedAt < PEER_ADOPT_GRACE_MS) { next.push(s); continue; }
      changed = true;
      continue;
    }
    const name = r.name || s.name;
    if (s.activityState === r.activity_state && s.name === name) { next.push(s); continue; }
    changed = true;
    next.push({ ...s, name, activityState: r.activity_state });
  }
  return changed ? next : prev;
}

/**
 * The New session dialog's choices for a peer, from its /catalog body. Local
 * vocabularies stay listed; anything the peer does not offer is marked
 * not-selectable with the reason, never dropped and never silently accepted.
 */
export function peerChoiceOptions(catalog, harnessId, { harnesses, permissionModes, efforts, machineLabel }) {
  const why = `${machineLabel || "That machine"} does not offer this`;
  const peerHarnesses = Array.isArray(catalog?.harnesses) ? catalog.harnesses : [];
  const hIds = new Set(peerHarnesses.map((h) => h.id));
  const harnessOptions = [
    ...harnesses.map((h) => (hIds.has(h.id) ? h : { ...h, disabled: true, reason: why })),
    ...peerHarnesses.filter((h) => !harnesses.some((l) => l.id === h.id)).map((h) => ({ id: h.id, label: h.label || h.id })),
  ];
  const current = peerHarnesses.find((h) => h.id === harnessId) || null;
  const modelOptions = (current?.models || []).map((m) => ({ id: m.id, label: m.label || m.id }));
  const pIds = new Set((catalog?.permission_modes || []).map((p) => p.id));
  const permissionOptions = permissionModes.map((p) => (pIds.has(p.id) ? p : { ...p, disabled: true, reason: why }));
  const eIds = new Set(catalog?.efforts || []);
  // "" is "no effort flag": the peer route treats effort as optional, so it is always honoured.
  const effortOptions = efforts.map((e) => (e.id === "" || eIds.has(e.id) ? e : { ...e, disabled: true, reason: why }));
  return {
    harnessOptions,
    modelOptions,
    permissionOptions,
    effortOptions,
    defaultModel: current?.default_model || "",
    harnessOffered: hIds.has(harnessId),
  };
}
