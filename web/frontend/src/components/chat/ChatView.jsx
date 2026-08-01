/**
 * ChatView — the Chat destination, built to CHAT.md design 6a.
 *
 * 6a is the NEUTRAL variant and is what this implements. 5a (the higher-colour
 * reference) is explicitly not to be built: no coloured badges, no glowing
 * permission gate, no blue primary buttons, no syntax rainbow, no tinted card
 * backgrounds. Hierarchy comes from BRIGHTNESS — a thing that needs the user is
 * `--cc-fg`, a resolved thing falls to `--cc-dim` then `--cc-muted`. The only
 * hue in the whole surface is the five artifact TYPE tones, and only on a type
 * icon and its label.
 *
 * Shell is four full-height columns (§3): nav rail (owned by App) · 272
 * conversation list · flexible transcript, min 560 · 288 artifacts rail. The
 * transcript's scrolling body carries `minHeight: 0`, which is load-bearing —
 * without it the composer is pushed off-screen by a long thread.
 *
 * Backed by `/api/chat/*`, Cockpit's first SYSTEM OF RECORD. Two rules follow
 * from that and are unchanged from the first implementation:
 *   · a sent message is rendered from what the SERVER returned, never from
 *     optimistic local state — the store owns `seq`;
 *   · a 413 keeps the user's text in the composer, because nothing was saved.
 *
 * Replies stream from `/respond`, which sends and answers in ONE call — split
 * across two, a failure between them leaves the user's message saved with
 * nothing answering it, and the UI cannot tell that apart from a slow model.
 * The streamed text is held OUTSIDE `thread` because it is not yet persisted;
 * the turn that survives a reload is the one the store returns.
 *
 * HONEST GAPS. No tool strip, no permission gate, no artifacts, no message
 * actions and no voice — build-order steps 6–12 in CHAT.md. The surfaces say
 * so rather than rendering convincing empty furniture.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare, Plus, FolderPlus, Trash2, Download, Search,
  PanelRight, Paperclip, Image as ImageIcon, AtSign, Slash, ArrowUp,
} from "lucide-react";

import ChatMessage from "./ChatMessage.jsx";
import ChatModelPicker from "./ChatModelPicker.jsx";
import ChatStreak from "./ChatStreak.jsx";
import ToolStrip from "./ToolStrip.jsx";

const LIST_W = 272;      // §3
const ARTIFACTS_W = 288; // §3
const HEADER_H = 52;     // §3

/** Root group is not a row in the DB; synthesised for display only. */
const ROOT = { id: "root", name: "Ungrouped" };

const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** SSE line terminator, built from a char code so no tooling layer can rewrite
 *  it into a literal newline inside the source. */
const NL = String.fromCharCode(10);

/** §2 — section labels: mono, 9.5px, wide tracking, uppercase, muted. */
const LABEL = {
  fontFamily: MONO, fontSize: 9.5, letterSpacing: ".09em",
  textTransform: "uppercase", color: "var(--cc-muted)",
};

async function api(path, opts) {
  const res = await fetch(`/api/chat${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export default function ChatView() {
  const [groups, setGroups] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Live reply text. Held separately from `thread` because it is NOT yet
  // persisted — the store owns the turn that survives a reload.
  const [streaming, setStreaming] = useState("");
  // Tool calls for the turn IN FLIGHT. Cleared per send: they belong to
  // the reply being produced, not to the conversation, which does not
  // persist them yet.
  const [liveTools, setLiveTools] = useState([]);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const endRef = useRef(null);

  const refreshLists = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([api("/groups"), api("/conversations")]);
      setGroups(g.groups || []);
      setConversations(c.conversations || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refreshLists(); }, [refreshLists]);

  useEffect(() => {
    let cancelled = false;
    if (!activeId) { setThread(null); return undefined; }
    (async () => {
      try {
        const data = await api(`/conversations/${activeId}`);
        if (!cancelled) setThread(data);
      } catch (e) {
        if (!cancelled) {
          setThread(null);
          setError(e.status === 404 ? "That conversation no longer exists." : e.message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  useEffect(() => {
    // Optional-call the METHOD too: scrollIntoView is absent in jsdom and in
    // some embedded webviews, where an unguarded call throws inside an effect
    // and unmounts the thread — a cosmetic scroll becoming a blank chat.
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [thread?.messages?.length]);

  const byGroup = useMemo(() => {
    const map = new Map([[ROOT.id, []]]);
    for (const g of groups) map.set(g.id, []);
    for (const c of conversations) {
      const key = c.group_id || ROOT.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    return map;
  }, [groups, conversations]);

  const newConversation = async (groupId) => {
    try {
      const conv = await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "New chat", group_id: groupId === ROOT.id ? null : groupId }),
      });
      await refreshLists();
      setActiveId(conv.id);
      setError(null);
    } catch (e) { setError(e.message); }
  };

  const newGroup = async () => {
    const name = window.prompt("Group name");
    if (!name?.trim()) return;
    try {
      await api("/groups", { method: "POST", body: JSON.stringify({ name }) });
      await refreshLists();
    } catch (e) { setError(e.message); }
  };

  const moveConversation = async (conversationId, groupId) => {
    try {
      // `null` is a REAL value — "move to the root" — so the key is always
      // present rather than omitted when empty.
      await api(`/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ group_id: groupId === ROOT.id ? null : groupId }),
      });
      await refreshLists();
    } catch (e) { setError(e.message); }
  };

  const changeModel = async (nextModel) => {
    if (!activeId) return;
    try {
      await api(`/conversations/${activeId}`, {
        method: "PATCH", body: JSON.stringify({ model: nextModel }),
      });
      setThread(await api(`/conversations/${activeId}`));
      refreshLists();
    } catch (e) { setError(e.message); }
  };

  const removeConversation = async (conversationId) => {
    if (!window.confirm("Delete this conversation and all of its messages?")) return;
    try {
      await api(`/conversations/${conversationId}`, { method: "DELETE" });
      if (activeId === conversationId) setActiveId(null);
      await refreshLists();
    } catch (e) { setError(e.message); }
  };

  const send = async () => {
    const content = draft;
    if (!content.trim() || !activeId || busy) return;
    setBusy(true);
    setError(null);
    setStreaming("");
    setLiveTools([]);
    try {
      // ONE call sends and replies. Two calls would let a failure between them
      // leave the user's message saved with nothing answering it, which the UI
      // cannot tell apart from a slow model.
      const res = await fetch(`/api/chat/conversations/${activeId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const err = new Error(body?.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      // The message was accepted, so the composer can clear. Re-read now so
      // the user's own turn appears immediately rather than after the reply.
      setDraft("");
      setThread(await api(`/conversations/${activeId}`));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; a partial frame stays in
        // the buffer rather than being parsed as truncated JSON.
        const frames = buf.split(NL + NL);
        buf = frames.pop() || "";
        for (const frame of frames) {
          const line = frame.split(NL).find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "delta") {
            acc += ev.text;
            setStreaming(acc);
          } else if (ev.type === "tool") {
            setLiveTools((prev) => [...prev, ev]);
          } else if (ev.type === "tool_result") {
            // Matched by id so a result lands on ITS call rather than the
            // most recent one — tools can overlap.
            setLiveTools((prev) => prev.map(
              (t) => (t.id === ev.id ? { ...t, is_error: ev.is_error } : t)
            ));
          } else if (ev.type === "error") {
            setError(ev.detail || "The reply failed.");
          }
        }
      }
      // Re-read rather than keeping the streamed text: the store owns `seq`,
      // and the persisted turn is the one that survives a reload.
      setThread(await api(`/conversations/${activeId}`));
      refreshLists();
    } catch (e) {
      setError(
        e.status === 413
          ? "That message is too large to store. Nothing was saved — your text is still in the box."
          : e.message
      );
    } finally {
      setBusy(false);
      setStreaming("");
    }
  };

  const onKeyDown = (e) => {
    // Enter sends, Shift+Enter is a newline. Keyed on the KEY, so the newlines
    // inside a multi-thousand-line paste can never submit it.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const conv = thread?.conversation;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, width: "100%" }}>
      {/* ── Conversation list · 272 fixed · --cc-bg2 (§4) ── */}
      <aside
        style={{
          width: LIST_W, flexShrink: 0, display: "flex", flexDirection: "column",
          minHeight: 0, background: "var(--cc-bg2)",
          borderRight: "1px solid var(--cc-border)",
        }}
      >
        <div style={{ ...headerRow, height: HEADER_H }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--cc-fg)", flex: 1 }}>
            Chats
          </span>
          <Search size={13} style={{ color: "var(--cc-dim)" }} />
          <button onClick={() => newConversation(ROOT.id)} style={bareBtn} title="New chat"
                  aria-label="New chat">
            <Plus size={14} style={{ color: "var(--cc-fg)" }} />
          </button>
          <button onClick={newGroup} style={bareBtn} title="New group" aria-label="New group">
            <FolderPlus size={13} style={{ color: "var(--cc-dim)" }} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {[ROOT, ...groups].map((g) => {
            const items = byGroup.get(g.id) || [];
            return (
              <div key={g.id}>
                <div style={{ ...LABEL, display: "flex", justifyContent: "space-between",
                              padding: "10px 14px 5px" }}>
                  <span>{g.name}</span>
                  <span>{items.length}</span>
                </div>
                {items.length === 0 && (
                  <div style={{ padding: "0 14px 8px", fontSize: 11, color: "var(--cc-muted)" }}>
                    empty
                  </div>
                )}
                {items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    groups={groups}
                    selected={c.id === activeId}
                    onSelect={() => setActiveId(c.id)}
                    onMove={(gid) => moveConversation(c.id, gid)}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <div style={{ ...LABEL, height: 34, display: "flex", alignItems: "center",
                      justifyContent: "space-between", padding: "0 14px",
                      borderTop: "1px solid var(--cc-line)" }}>
          <span>Prompt library</span>
          <span>Ctrl+K</span>
        </div>
      </aside>

      {/* ── Transcript · flex, min 560 · --cc-bg (§5, §6) ── */}
      <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex",
                        flexDirection: "column", background: "var(--cc-bg)" }}>
        {!activeId ? (
          <Empty />
        ) : (
          <>
            <header style={{ ...headerRow, height: HEADER_H,
                             borderBottom: "1px solid var(--cc-border)" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--cc-fg)",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {conv?.title || "…"}
                </div>
                {/* §5 subtitle: what this conversation is talking to. */}
                <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--cc-muted)" }}>
                  {conv?.model || "no model set"} · talks only
                </div>
              </div>
              <button
                onClick={() => setArtifactsOpen((v) => !v)}
                title="Toggle artifacts panel"
                aria-label="Toggle artifacts panel"
                style={{
                  ...bareBtn,
                  background: artifactsOpen ? "var(--cc-elev)" : "transparent",
                  color: artifactsOpen ? "var(--cc-fg)" : "var(--cc-dim)",
                  border: artifactsOpen ? "1px solid var(--cc-border)" : "1px solid transparent",
                  borderRadius: 6,
                }}
              >
                <PanelRight size={13} />
              </button>
              <a href={`/api/chat/conversations/${activeId}/export`} style={bareBtn}
                 title="Export this conversation" download>
                <Download size={13} style={{ color: "var(--cc-dim)" }} />
              </a>
              <button onClick={() => removeConversation(activeId)} style={bareBtn}
                      title="Delete conversation" aria-label="Delete conversation">
                <Trash2 size={13} style={{ color: "var(--cc-dim)" }} />
              </button>
            </header>

            <ChatStreak conversations={conversations}
                        activeMessageCount={thread?.messages?.length || 0} />

            {/* minHeight:0 is REQUIRED (§3) or a long thread pushes the
                composer off-screen. */}
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto",
                          padding: "16px 26px 0", display: "flex",
                          flexDirection: "column", gap: 18 }}>
              {(thread?.messages || []).map((m) => <ChatMessage key={m.id} message={m} />)}
              {thread?.messages?.length === 0 && (
                <p style={{ fontSize: 14, lineHeight: 1.65, color: "var(--cc-muted)",
                            maxWidth: 620 }}>
                  Nothing here yet. Anything you send is stored verbatim.
                </p>
              )}
              {liveTools.length > 0 && <ToolStrip calls={liveTools} />}
              {streaming && (
                <div style={{ fontSize: 14, lineHeight: 1.65, maxWidth: 620,
                              color: "var(--cc-muted)", whiteSpace: "pre-wrap" }}>
                  {streaming}
                  <span style={{ display: "inline-block", width: 7, height: 15,
                                 marginLeft: 2, verticalAlign: "text-bottom",
                                 background: "var(--cc-dim)" }} />
                </div>
              )}
              <div ref={endRef} />
            </div>

            {/* Composer (§7). Status row above the box. */}
            <div style={{ padding: "0 26px 14px" }}>
              <div style={{ height: 22, display: "flex", alignItems: "center", gap: 10,
                            fontSize: 10, color: "var(--cc-muted)" }}>
                {/* Only two engine facts are allowed in Chat (§7): context and
                    tok/s. No spill, queue depth, lane class or cost. Neither is
                    known until a model is wired, so neither is invented. */}
                <span>{busy ? "generating" : "not generating"}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: MONO }}>context —</span>
              </div>

              <div style={{ marginBottom: 8, padding: "6px 10px", fontSize: 10,
                            lineHeight: 1.5, color: "var(--cc-dim)",
                            border: "1px solid var(--cc-border)", borderRadius: 8 }}>
                Replies run through your local `claude` CLI with a READ-ONLY
                tool set. Tool calls, permission gates and artifacts follow in
                build order.
              </div>

              {error && (
                <div style={{ marginBottom: 8, padding: "6px 10px", fontSize: 10,
                              lineHeight: 1.5, color: "var(--cc-fg)",
                              border: "1px solid var(--cc-border)",
                              borderLeft: "2px solid var(--cc-fg)", borderRadius: 8 }}>
                  {error}
                </div>
              )}

              <div style={{ borderRadius: 12, background: "var(--cc-surface)",
                            border: "1px solid var(--cc-border)" }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Send a message…  (Enter to send, Shift+Enter for a newline)"
                  aria-label="Message"
                  rows={2}
                  style={{
                    width: "100%", boxSizing: "border-box", resize: "vertical",
                    minHeight: 36, padding: "11px 14px", border: "none",
                    background: "transparent", color: "var(--cc-fg)",
                    fontFamily: "var(--cc-sans, inherit)", fontSize: 14, lineHeight: 1.6,
                    outline: "none",
                  }}
                />
                {/* Bottom bar 44px. The MODEL SELECTOR lives here, not in the
                    header (§5/§7): model and permission mode are the two things
                    you change per-message. */}
                <div style={{ height: 44, display: "flex", alignItems: "center", gap: 10,
                              padding: "0 12px", borderTop: "1px solid var(--cc-line)" }}>
                  <AtSign size={13} style={{ color: "var(--cc-dim)" }} />
                  <Paperclip size={13} style={{ color: "var(--cc-dim)" }} />
                  <ImageIcon size={13} style={{ color: "var(--cc-dim)" }} />
                  <Slash size={13} style={{ color: "var(--cc-dim)" }} />
                  <span style={{ flex: 1 }} />
                  <ChatModelPicker
                    model={conv?.model}
                    messages={thread?.messages}
                    onChange={changeModel}
                  />
                  <button onClick={send} disabled={busy || !draft.trim()}
                          aria-label="Send" title="Send"
                          style={{
                            width: 30, height: 30, borderRadius: "50%", border: "none",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            background: "var(--cc-fg)", color: "var(--cc-bg)",
                            cursor: busy || !draft.trim() ? "default" : "pointer",
                            opacity: busy || !draft.trim() ? 0.4 : 1,
                          }}>
                    <ArrowUp size={15} />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Artifacts rail · 288 fixed · --cc-bg2 (§8) ── */}
      {artifactsOpen && (
        <aside style={{ width: ARTIFACTS_W, flexShrink: 0, display: "flex",
                        flexDirection: "column", minHeight: 0,
                        background: "var(--cc-bg2)",
                        borderLeft: "1px solid var(--cc-border)" }}>
          <div style={{ ...headerRow, height: HEADER_H }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--cc-fg)", flex: 1 }}>
              Artifacts
            </span>
            <span style={{ ...LABEL }}>{(thread?.attachments || []).length}</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 11 }}>
            {(thread?.attachments || []).length === 0 ? (
              <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)" }}>
                Nothing yet. Diffs, runs, snippets, charts and images produced by
                a reply will collect here.
              </p>
            ) : (
              (thread.attachments || []).map((a) => (
                <div key={a.id} style={{ borderRadius: 9, border: "1px solid var(--cc-border)",
                                         padding: "10px 11px", marginBottom: 8 }}>
                  <div style={{ ...LABEL, color: "var(--cc-a-image)" }}>{a.kind || "file"}</div>
                  <div style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--cc-fg)",
                                overflow: "hidden", textOverflow: "ellipsis" }}>
                    {a.filename}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--cc-muted)" }}>
                    {a.size_bytes ? `${a.size_bytes.toLocaleString()} bytes` : "size unknown"}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** §4 — 56px row, three lines, brightness-encoded state. */
function ConversationRow({ conversation: c, groups, selected, onSelect, onMove }) {
  const needsYou = c.attention === "needs_you";
  const unread = (c.unread_count || 0) > 0;
  // Brightness, never hue: a thing that needs you is --cc-fg, a resolved thing
  // falls to --cc-dim then --cc-muted.
  const nameColor = needsYou || unread ? "var(--cc-fg)" : "var(--cc-dim)";
  const previewColor = needsYou ? "var(--cc-fg)" : "var(--cc-muted)";

  return (
    <div
      onClick={onSelect}
      className="hover-bg-elevated"
      style={{
        height: 56, display: "flex", alignItems: "center", gap: 10,
        padding: "0 14px", cursor: "pointer",
        background: selected ? "var(--cc-elev)" : "transparent",
        opacity: c.archived ? 0.6 : 1,
      }}
    >
      <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                    background: "var(--cc-surface)", border: "1px solid var(--cc-border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, color: "var(--cc-dim)" }}>
        {(c.title || "?").trim().charAt(0).toUpperCase()}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, color: nameColor, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.title}
        </div>
        <div style={{ fontSize: 11, color: previewColor, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.message_count} message{c.message_count === 1 ? "" : "s"}
        </div>
        <div style={{ ...LABEL, fontSize: 9.5 }}>{c.model || "no model"}</div>
      </div>
      <select
        value={c.group_id || ROOT.id}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onMove(e.target.value)}
        aria-label={`Move ${c.title}`}
        style={{ fontSize: 9, background: "transparent", color: "var(--cc-muted)",
                 border: "1px solid var(--cc-border)", borderRadius: 5, maxWidth: 62 }}
      >
        <option value={ROOT.id}>{ROOT.name}</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
    </div>
  );
}

function Empty() {
  return (
    <div style={{ margin: "auto", textAlign: "center", padding: 32, maxWidth: 420 }}>
      <MessageSquare size={26} style={{ color: "var(--cc-muted)", marginBottom: 10 }} />
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "var(--cc-fg)" }}>
        No conversation selected
      </div>
      <p style={{ fontSize: 14, lineHeight: 1.65, color: "var(--cc-muted)", margin: 0 }}>
        Pick one on the left, or start a new chat. Conversations can be filed
        into groups; deleting a group never deletes the chats inside it.
      </p>
    </div>
  );
}

const headerRow = {
  display: "flex", alignItems: "center", gap: 8, padding: "0 14px", flexShrink: 0,
};
const bareBtn = {
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: 4, border: "none", background: "transparent", cursor: "pointer",
};
