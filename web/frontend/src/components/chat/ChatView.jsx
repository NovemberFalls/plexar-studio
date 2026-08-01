/**
 * ChatView — the Chat destination.
 *
 * Backed by `/api/chat/*` (chat_store.py), which is Cockpit's first SYSTEM OF
 * RECORD: it holds the user's own words, and there is no upstream to re-ingest
 * from. Two consequences show up directly in this UI:
 *
 *   · A message is rendered from what the SERVER returned, never from local
 *     optimistic state alone. If the write failed, the message must not appear
 *     to have been sent — a chat that shows a message it did not persist is
 *     lying about the one thing it exists to do.
 *   · Ordering follows the server's `seq`, never a client timestamp.
 *
 * HONESTY: there is no completion backend wired yet. This surface persists and
 * renders conversations; it does NOT produce assistant replies. Rather than
 * fake a reply or leave the user waiting on a spinner that will never resolve,
 * it says so plainly. See backlog/10.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, FolderPlus, Trash2, Download } from "lucide-react";

import ChatMessage from "./ChatMessage.jsx";

const PANEL = {
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  borderRadius: 12,
};

/** Root group is not a row in the DB, so it is synthesised for display only. */
const ROOT = { id: "root", name: "Ungrouped" };

async function api(path, opts) {
  const res = await fetch(`/api/chat${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
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
  const [thread, setThread] = useState(null); // {conversation, messages, attachments}
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const refreshLists = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([
        api("/groups"),
        api("/conversations"),
      ]);
      setGroups(g.groups || []);
      setConversations(c.conversations || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refreshLists();
  }, [refreshLists]);

  // Load the selected thread. A conversation that vanished (deleted in another
  // window) clears the selection rather than rendering a stale thread.
  useEffect(() => {
    let cancelled = false;
    if (!activeId) {
      setThread(null);
      return undefined;
    }
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
    // Optional-call the method too, not just the ref: scrollIntoView is absent
    // in jsdom and in some embedded webviews, and an unguarded call there
    // throws inside an effect — which unmounts the whole thread, turning a
    // cosmetic scroll into a blank chat.
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
    } catch (e) {
      setError(e.message);
    }
  };

  const newGroup = async () => {
    const name = window.prompt("Group name");
    if (!name?.trim()) return;
    try {
      await api("/groups", { method: "POST", body: JSON.stringify({ name }) });
      await refreshLists();
    } catch (e) {
      setError(e.message);
    }
  };

  const moveConversation = async (conversationId, groupId) => {
    try {
      // `null` is a REAL value here — "move to the root" — which is why the key
      // is always present in the body rather than omitted when empty.
      await api(`/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ group_id: groupId === ROOT.id ? null : groupId }),
      });
      await refreshLists();
    } catch (e) {
      setError(e.message);
    }
  };

  const removeConversation = async (conversationId) => {
    // Genuinely destructive: a conversation DOES contain its messages.
    if (!window.confirm("Delete this conversation and all of its messages?")) return;
    try {
      await api(`/conversations/${conversationId}`, { method: "DELETE" });
      if (activeId === conversationId) setActiveId(null);
      await refreshLists();
    } catch (e) {
      setError(e.message);
    }
  };

  const send = async () => {
    const content = draft;
    if (!content.trim() || !activeId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/conversations/${activeId}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content }),
      });
      // Re-read rather than append locally: the server owns `seq`, and showing
      // a message the store did not accept is the one failure this surface
      // must never have.
      const data = await api(`/conversations/${activeId}`);
      setThread(data);
      setDraft("");
      refreshLists();
    } catch (e) {
      setError(
        e.status === 413
          ? "That message is too large to store. Nothing was saved — your text is still in the box."
          : e.message
      );
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    // Enter sends, Shift+Enter is a newline — and a large PASTE must never be
    // submitted by the newlines inside it, which is why this checks the key
    // rather than listening for input.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, gap: 12, padding: 12 }}>
      {/* Conversation list, grouped */}
      <aside style={{ ...PANEL, width: 264, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", gap: 6, padding: 10, borderBottom: "1px solid var(--cc-border)" }}>
          <button onClick={() => newConversation(ROOT.id)} className="hover-bg-elevated"
            style={btn} title="New chat">
            <Plus size={13} /> New chat
          </button>
          <button onClick={newGroup} className="hover-bg-elevated" style={iconBtn} title="New group">
            <FolderPlus size={13} />
          </button>
        </div>

        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "6px 0" }}>
          {[ROOT, ...groups].map((g) => {
            const items = byGroup.get(g.id) || [];
            return (
              <div key={g.id} style={{ marginBottom: 8 }}>
                <div style={groupHeader}>
                  <span>{g.name}</span>
                  <span style={{ color: "var(--cc-muted)" }}>{items.length}</span>
                </div>
                {items.length === 0 && (
                  <div style={{ ...rowText, color: "var(--cc-muted)", fontStyle: "italic" }}>
                    empty
                  </div>
                )}
                {items.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => setActiveId(c.id)}
                    className="hover-bg-elevated"
                    style={{
                      ...row,
                      background: c.id === activeId ? "var(--cc-elevated)" : "transparent",
                      borderLeft: `2px solid ${c.id === activeId ? "var(--cc-accent)" : "transparent"}`,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={rowText}>{c.title}</div>
                      <div style={{ fontSize: 10, color: "var(--cc-muted)" }}>
                        {c.message_count} message{c.message_count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <select
                      value={c.group_id || ROOT.id}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => moveConversation(c.id, e.target.value)}
                      aria-label={`Move ${c.title}`}
                      style={miniSelect}
                    >
                      <option value={ROOT.id}>{ROOT.name}</option>
                      {groups.map((gg) => (
                        <option key={gg.id} value={gg.id}>{gg.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Thread */}
      <section style={{ ...PANEL, flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
        {!activeId ? (
          <Empty />
        ) : (
          <>
            <header style={threadHeader}>
              <MessageSquare size={13} style={{ color: "var(--cc-accent)" }} />
              <span style={{ fontSize: 12, fontWeight: 700, flex: 1, minWidth: 0 }}>
                {thread?.conversation?.title || "…"}
              </span>
              <a href={`/api/chat/conversations/${activeId}/export`} style={iconBtn}
                 title="Export this conversation" download>
                <Download size={13} />
              </a>
              <button onClick={() => removeConversation(activeId)} className="hover-color-red"
                      style={iconBtn} title="Delete conversation">
                <Trash2 size={13} />
              </button>
            </header>

            <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "12px 16px" }}>
              {(thread?.messages || []).map((m) => <ChatMessage key={m.id} message={m} />)}
              {thread?.messages?.length === 0 && (
                <p style={{ fontSize: 11, color: "var(--cc-muted)" }}>
                  Nothing here yet. Anything you send is stored verbatim.
                </p>
              )}
              <div ref={endRef} />
            </div>

            {/* The honest banner. A chat surface with no model behind it must
                say so rather than accept a message into a void. */}
            <div style={notice}>
              No model is wired to Chat yet — messages are stored, but nothing
              replies. Voice and model routing are tracked in backlog/10.
            </div>

            {error && (
              <div style={{ ...notice, color: "var(--cc-error)", borderColor: "var(--cc-error)" }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--cc-border)" }}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Send a message…  (Enter to send, Shift+Enter for a newline)"
                aria-label="Message"
                rows={3}
                style={composer}
              />
              <button onClick={send} disabled={busy || !draft.trim()} style={sendBtn}>
                {busy ? "Saving…" : "Send"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Empty() {
  return (
    <div style={{ margin: "auto", textAlign: "center", padding: 32, maxWidth: 420 }}>
      <MessageSquare size={28} style={{ color: "var(--cc-muted)", marginBottom: 10 }} />
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>No conversation selected</div>
      <p style={{ fontSize: 11, color: "var(--cc-dim)", lineHeight: 1.6, margin: 0 }}>
        Pick one on the left, or start a new chat. Conversations can be filed
        into groups; deleting a group never deletes the chats inside it.
      </p>
    </div>
  );
}

const btn = {
  display: "flex", alignItems: "center", gap: 5, flex: 1, justifyContent: "center",
  fontSize: 11, fontWeight: 600, padding: "5px 8px", borderRadius: 7,
  border: "1px solid var(--cc-border)", background: "transparent", color: "var(--cc-fg)",
  cursor: "pointer",
};
const iconBtn = {
  display: "flex", alignItems: "center", justifyContent: "center", padding: "5px 7px",
  borderRadius: 7, border: "1px solid var(--cc-border)", background: "transparent",
  color: "var(--cc-dim)", cursor: "pointer",
};
const groupHeader = {
  display: "flex", justifyContent: "space-between", padding: "4px 12px",
  fontSize: 9, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
  color: "var(--cc-muted)",
};
const row = {
  display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", cursor: "pointer",
};
const rowText = {
  fontSize: 11, color: "var(--cc-fg)", overflow: "hidden",
  textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const miniSelect = {
  fontSize: 9, background: "var(--cc-surface)", color: "var(--cc-muted)",
  border: "1px solid var(--cc-border)", borderRadius: 5, maxWidth: 74,
};
const threadHeader = {
  display: "flex", alignItems: "center", gap: 7, padding: "9px 12px",
  borderBottom: "1px solid var(--cc-border)",
};
const notice = {
  margin: "0 10px 8px", padding: "6px 10px", fontSize: 10, lineHeight: 1.5,
  color: "var(--cc-waiting)", border: "1px solid var(--cc-border)", borderRadius: 7,
};
const composer = {
  flex: 1, resize: "vertical", fontSize: 12, lineHeight: 1.5, padding: "7px 9px",
  borderRadius: 8, border: "1px solid var(--cc-border)", background: "var(--cc-bg)",
  color: "var(--cc-fg)", fontFamily: "inherit", minHeight: 54,
};
const sendBtn = {
  alignSelf: "flex-end", fontSize: 11, fontWeight: 700, padding: "8px 16px",
  borderRadius: 8, border: "1px solid var(--cc-accent)", background: "transparent",
  color: "var(--cc-accent)", cursor: "pointer",
};
