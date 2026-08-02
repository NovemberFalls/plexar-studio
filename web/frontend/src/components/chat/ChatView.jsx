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
 * HONEST GAPS. No permission gate, no message actions. Voice, @-mention and
 * slash commands are now wired to the extent that is honest: @ and / open
 * real menus over real handlers (VoiceButton.jsx / MentionPopover.jsx /
 * CommandsPopover.jsx); the mic stays disabled-with-reason always, because
 * `/api/voice/status` being `available:true` on some future machine still
 * would not mean Chat has a capture pipeline — see VoiceButton.jsx's own
 * comment before "fixing" that.
 *
 * Attachments (paperclip / image, drag-and-drop onto the composer, and image
 * paste) upload via the existing /api/upload and record against the
 * conversation via /api/chat/conversations/{id}/attachments — bytes stay on
 * disk, only the path is stored. The path is also folded into the prompt
 * text sent to /respond, clearly marked, because the harness's own
 * read-only Read tool can only open a path it was actually told about.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare, Plus, FolderPlus, Trash2, Download, Search,
  PanelRight, Paperclip, Image as ImageIcon, AtSign, Slash, ArrowUp,
} from "lucide-react";

import AttachmentChip from "./AttachmentChip.jsx";
import ChatMessage from "./ChatMessage.jsx";
import ChatModelPicker from "./ChatModelPicker.jsx";
import ChatStreak from "./ChatStreak.jsx";
import ToolStrip from "./ToolStrip.jsx";
import VoiceButton from "./VoiceButton.jsx";
import MentionPopover from "./MentionPopover.jsx";
import CommandsPopover from "./CommandsPopover.jsx";
import { meter } from "./contextMeter.js";
import useLocalModels from "../../hooks/useLocalModels.js";

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
  // Read-only subscriber to the ONE app-wide /models store — never a fetch of
  // its own — so a local model's published context window is knowable here.
  const { byProvider: localModelsByProvider } = useLocalModels();
  // Uploaded-but-not-yet-sent attachments. Only recorded against the
  // conversation (and folded into the prompt) once the message they ride
  // with is actually sent — an attachment picked and never sent should not
  // appear in the Artifacts rail.
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  // @-mention and /-command popovers. Both are small, self-contained menus
  // over things ChatView already has (attachments already fetched for the
  // Artifacts rail; command handlers that already exist below).
  const [mentionOpen, setMentionOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const endRef = useRef(null);
  const paperclipInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const draftRef = useRef(null);

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

  // Uploads ONE file to the existing /api/upload (one at a time, not a
  // batch) so the returned path maps unambiguously back to the file that
  // produced it — /api/upload skips rejected files inline rather than
  // padding the paths array, so a batch of N files can return M < N paths
  // with no positional way to tell which file each path belongs to.
  const uploadOne = async (file) => {
    const fd = new FormData();
    fd.append("files", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    // The route answers 200 even for a rejected file (too big / wrong
    // extension) with the reason in `errors` — surface that reason, naming
    // the file, rather than a generic failure.
    if (body?.errors?.length) throw new Error(body.errors[0]);
    const path = body?.paths?.[0];
    if (!path) throw new Error(`Upload of "${file.name}" did not return a path.`);
    return path;
  };

  const attachFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setError(null);
    for (const file of files) {
      try {
        const path = await uploadOne(file);
        setPendingAttachments((prev) => [...prev, {
          filename: file.name, path,
          kind: file.type.startsWith("image/") ? "image" : "file",
          mime: file.type || null, size_bytes: file.size,
        }]);
      } catch (e) {
        setError(e.message);
      }
    }
    setUploading(false);
  };

  const removePendingAttachment = (idx) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  // Two independent DnD systems can share a drop target elsewhere in the app
  // (see CLAUDE.md "Drag-and-Drop Architecture") — Chat has no pane-swap
  // handler competing for this one, but the same defensive check belongs
  // here anyway: only intercept a drag that actually carries files.
  const onComposerDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  };
  const onComposerDrop = (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files?.length) attachFiles(e.dataTransfer.files);
  };
  // Capture image paste before the browser inserts it as anything else.
  // Plain-text paste is left completely alone.
  const onComposerPaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter((it) => it.type?.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) attachFiles(files);
  };

  const send = async () => {
    const content = draft;
    if (!content.trim() || !activeId || busy) return;
    setBusy(true);
    setError(null);
    setStreaming("");
    setLiveTools([]);
    // Attachment paths ride IN the prompt, clearly marked, because the
    // harness's own read-only Read tool can only open a path it was
    // actually told about — an uploaded file the model is never told the
    // path of is decoration, not an attachment.
    const attachmentsToSend = pendingAttachments;
    const promptContent = attachmentsToSend.length
      ? `${content}${NL}${NL}[Attached files — read these with your Read tool]${NL}`
        + attachmentsToSend.map((a) => `- ${a.path} (${a.filename})`).join(NL)
      : content;
    try {
      // ONE call sends and replies. Two calls would let a failure between them
      // leave the user's message saved with nothing answering it, which the UI
      // cannot tell apart from a slow model.
      const res = await fetch(`/api/chat/conversations/${activeId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: promptContent }),
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
      const afterUser = await api(`/conversations/${activeId}`);
      setThread(afterUser);

      if (attachmentsToSend.length) {
        // Record against the message that actually carried them, so the
        // Artifacts rail and the transcript agree on which turn they rode
        // with.
        const lastUser = [...(afterUser.messages || [])].reverse()
          .find((m) => m.role === "user");
        for (const a of attachmentsToSend) {
          try {
            await api(`/conversations/${activeId}/attachments`, {
              method: "POST",
              body: JSON.stringify({
                filename: a.filename, path: a.path, kind: a.kind,
                mime: a.mime, size_bytes: a.size_bytes,
                message_id: lastUser?.id,
              }),
            });
          } catch (e) {
            setError(`Could not record attachment "${a.filename}": ${e.message}`);
          }
        }
        setPendingAttachments([]);
        setThread(await api(`/conversations/${activeId}`));
      }

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

  // Typing "@" opens the mention popover; typing "/" as the FIRST character
  // of an otherwise-empty draft opens the commands popover. Both are cheap
  // checks on the value React already handed us in onChange — no keystroke
  // interception, so nothing here can eat a character the user typed.
  const onDraftChange = (e) => {
    const val = e.target.value;
    setDraft(val);
    if (val.endsWith("@")) setMentionOpen(true);
    if (val === "/") setCommandsOpen(true);
  };

  // Inserts *path* at the textarea's cursor, consuming a trailing "@" if
  // that is what triggered the popover — so picking a file replaces the
  // trigger character rather than leaving a stray "@" behind it.
  const insertMention = (path) => {
    const el = draftRef.current;
    if (!el) {
      setDraft((d) => (d.endsWith("@") ? d.slice(0, -1) : d) + path + " ");
      setMentionOpen(false);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    let before = draft.slice(0, start);
    const after = draft.slice(end);
    if (before.endsWith("@")) before = before.slice(0, -1);
    const next = `${before}${path} ${after}`;
    setDraft(next);
    setMentionOpen(false);
    const pos = before.length + path.length + 1;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  };

  const conv = thread?.conversation;

  // Only handlers that ALREADY EXIST and already work — no new backend calls
  // invented for this menu (see CommandsPopover.jsx). Guarded so an entry
  // with no live conversation cannot fire and error.
  const runCommand = (fn) => () => {
    setCommandsOpen(false);
    setDraft("");
    fn();
  };
  const exportConversation = () => {
    if (!activeId) return;
    const a = document.createElement("a");
    a.href = `/api/chat/conversations/${activeId}/export`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const commands = [
    { label: "new-chat", run: runCommand(() => newConversation(conv?.group_id || ROOT.id)) },
    { label: "new-group", run: runCommand(newGroup) },
    {
      label: "export", disabled: !activeId,
      run: runCommand(exportConversation),
    },
    {
      label: "toggle-artifacts",
      run: runCommand(() => setArtifactsOpen((v) => !v)),
    },
    {
      label: "delete-chat", disabled: !activeId,
      run: runCommand(() => removeConversation(activeId)),
    },
  ];

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
                      borderTop: "1px solid var(--cc-line)" }}
             title="Conversations are stored locally in a SQLite database under your Plexar data folder. Nothing is uploaded.">
          <span>Stored locally</span>
          <span>on this machine</span>
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
                {(() => {
                  const m = meter(thread?.messages, conv?.model, localModelsByProvider);
                  return (
                    <>
                      {/* No bar when the limit is unknown: a bar implies a
                          proportion, and inventing a denominator would make the
                          most reassuring reading the one shown when we
                          understand the least. */}
                      {m.pct != null && (
                        <span style={{ width: 70, height: 4, borderRadius: 2,
                                       background: "var(--cc-elev)", overflow: "hidden" }}>
                          <span style={{
                            display: "block", height: "100%",
                            width: `${m.pct}%`,
                            background: m.over ? "var(--cc-fg)" : "var(--cc-dim)",
                          }} />
                        </span>
                      )}
                      <span style={{ fontFamily: MONO,
                                     color: m.over ? "var(--cc-fg)" : "var(--cc-muted)" }}>
                        {m.label}
                      </span>
                    </>
                  );
                })()}
              </div>

              <div style={{ marginBottom: 8, padding: "6px 10px", fontSize: 10,
                            lineHeight: 1.5, color: "var(--cc-dim)",
                            border: "1px solid var(--cc-border)", borderRadius: 8 }}>
                Replies run through your local `claude` CLI with a READ-ONLY
                tool set. Attach a file with the paperclip or image icon, or
                drag one onto the box, and the model reads it with its own
                Read tool. There is no permission gate yet. Voice input stays
                disabled on this machine — click the mic icon for why.
              </div>

              {error && (
                <div style={{ marginBottom: 8, padding: "6px 10px", fontSize: 10,
                              lineHeight: 1.5, color: "var(--cc-fg)",
                              border: "1px solid var(--cc-border)",
                              borderLeft: "2px solid var(--cc-fg)", borderRadius: 8 }}>
                  {error}
                </div>
              )}

              <div
                onDragOver={onComposerDragOver}
                onDrop={onComposerDrop}
                style={{ borderRadius: 12, background: "var(--cc-surface)",
                         border: "1px solid var(--cc-border)" }}
              >
                {pendingAttachments.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6,
                                padding: "8px 12px 0" }}>
                    {pendingAttachments.map((a, i) => (
                      <AttachmentChip
                        key={i}
                        attachment={a}
                        onRemove={() => removePendingAttachment(i)}
                      />
                    ))}
                    {uploading && (
                      <span style={{ fontSize: 10.5, color: "var(--cc-muted)" }}>
                        uploading…
                      </span>
                    )}
                  </div>
                )}
                <textarea
                  ref={draftRef}
                  value={draft}
                  onChange={onDraftChange}
                  onKeyDown={onKeyDown}
                  onPaste={onComposerPaste}
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
                  <input
                    ref={paperclipInputRef}
                    type="file"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => { attachFiles(e.target.files); e.target.value = ""; }}
                  />
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => { attachFiles(e.target.files); e.target.value = ""; }}
                  />
                  <button
                    type="button"
                    onClick={() => paperclipInputRef.current?.click()}
                    aria-label="Attach a file"
                    title="Attach a file"
                    style={{ ...bareBtn, color: "var(--cc-dim)" }}
                  >
                    <Paperclip size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    aria-label="Attach an image"
                    title="Attach an image"
                    style={{ ...bareBtn, color: "var(--cc-dim)" }}
                  >
                    <ImageIcon size={13} />
                  </button>
                  <VoiceButton />
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setMentionOpen((v) => !v)}
                      aria-label="Mention a file"
                      title="Mention a file from this conversation"
                      style={{ ...bareBtn, color: mentionOpen ? "var(--cc-fg)" : "var(--cc-dim)" }}
                    >
                      <AtSign size={13} />
                    </button>
                    <MentionPopover
                      open={mentionOpen}
                      onClose={() => setMentionOpen(false)}
                      attachments={thread?.attachments || []}
                      onInsert={insertMention}
                    />
                  </div>
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setCommandsOpen((v) => !v)}
                      aria-label="Commands"
                      title="Commands"
                      style={{ ...bareBtn, color: commandsOpen ? "var(--cc-fg)" : "var(--cc-dim)" }}
                    >
                      <Slash size={13} />
                    </button>
                    <CommandsPopover
                      open={commandsOpen}
                      onClose={() => setCommandsOpen(false)}
                      commands={commands}
                    />
                  </div>
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
                <div key={a.id} style={{ marginBottom: 8 }}>
                  <AttachmentChip attachment={a} />
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
