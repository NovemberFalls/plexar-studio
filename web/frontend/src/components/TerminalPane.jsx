import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { X, GripVertical, GitFork, Search, Link2, ExternalLink, Workflow, OctagonX, EllipsisVertical } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import StateIcon from "./StateIcon";
import WorkflowsPanel from "./WorkflowsPanel";
import PaneActionsMenu from "./PaneActionsMenu";
import { useModelCatalog } from "../modelCatalog";
import { isContainerMeasurable, dimsChanged, debounce } from "../utils/terminalFit";
import { getPlatformInfo, getPlatformInfoSync, PLATFORM_INFO_PENDING, buildWindowsPtyOption } from "../utils/platformInfo";
import { buildXtermTheme } from "../utils/xtermTheme";
import { diagnoseSocketFailure, WS_REFUSED, REFUSED_MESSAGE } from "../wsDiagnose";
import "@xterm/xterm/css/xterm.css";

const TerminalPane = forwardRef(function TerminalPane({
  session,       // { id, name, terminalId, model, status, activityState }
  onClose,       // () => void
  paneIndex,     // number — position in the grid
  onSwap,        // (fromIndex, toIndex) => void
  onDragSourceChange, // (paneIndex | null) => void — notify parent of drag start/end
  onMakeFeatured,  // () => void | undefined — promote this pane into the featured cell (3/5/7 layouts only; undefined when already featured or the layout has no featured cell)
  terminalZoom = 13, // terminal font size (zoom level)
  toast,           // (msg, type) => void — optional toast notification
  onFork,          // () => void — fork session (new session, same workdir)
  onOpenBridge,    // () => void — open the bridge modal pre-selected to this pane
  activeBridge,    // null | { bridge_id, from_name, to_name, turns_used, max_turns } — active bridge involving this pane
  onEndBridge,     // (bridgeId: string) => void — terminate an active bridge
  onPopout,        // (session) => void — open terminal in separate window
  workflowSummary, // { count: number, inProgressCount: number, items: array } | null — recent workflows
  onRenameSession, // (newName: string, syncClaude: boolean) => Promise<void> — PATCH rename, owned by App.jsx (updates sidebar name)
  usage,           // { total_tokens, est_cost_usd, effort, tokensPerSec } | null | undefined — live usage summary for this session
}, ref) {
  const termRef = useRef(null);       // DOM ref
  const xtermRef = useRef(null);      // Terminal instance
  const fitRef = useRef(null);        // FitAddon instance
  const canvasAddonRef = useRef(null); // CanvasAddon instance (for explicit pre-dispose)
  const wsRef = useRef(null);         // WebSocket
  const resizeObserver = useRef(null);
  const lastSentDimsRef = useRef(null); // { cols, rows } last successfully sent to the backend — dedupes redundant resize sends
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  // Sticky: once the server has told us this origin is not allowed, reconnecting
  // cannot fix it. Without this the pane retries forever under a message claiming
  // the backend is down — a false statement about the machine's state.
  const originRefused = useRef(false);
  const pendingDataRef = useRef("");  // Batched WS data for xterm
  const writeRafRef = useRef(null);   // rAF handle for batched writes
  const searchRef = useRef(null);       // SearchAddon instance
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSyncClaude, setRenameSyncClaude] = useState(true);
  const searchInputRef = useRef(null);
  const renameInputRef = useRef(null);
  const actionsMenuBtnRef = useRef(null);
  const { theme, accent, tokenOverrides } = useTheme();

  // Latest theme inputs, readable from the mount-only terminal-construction
  // effect without adding them to its dep list.
  const xtermThemeInputsRef = useRef({ theme, accent, tokenOverrides });
  xtermThemeInputsRef.current = { theme, accent, tokenOverrides };

  // Long OpenRouter slugs (e.g. "deepseek/deepseek-v4-pro") would overflow the
  // pill in the header — display the friendly label when the id is known,
  // falling back to the raw string (covers unrecognized/future model ids).
  const { models: modelList } = useModelCatalog();
  const modelLabel = modelList.find((m) => m.id === session.model)?.label || session.model;

  // Compact number formatter for header usage stats: 1.2M / 45.3k / 812
  const fmtTokens = useCallback((n) => {
    if (n == null || Number.isNaN(n)) return "0";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
  }, []);

  // Expose focus() to parent via ref
  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
    /** Send ESC to the PTY — what the Inspector's "Interrupt" button and the
     *  Esc shortcut both do. Goes over the SAME wsRef the keyboard uses, so it
     *  is serialized by the backend's per-session write lock like any keystroke.
     *  No-ops when the socket is not open rather than throwing. */
    interrupt: () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send("\x1b");
        return true;
      }
      return false;
    },
  }));

  const searchNext = useCallback(() => {
    if (searchRef.current && searchQuery) {
      searchRef.current.findNext(searchQuery, { regex: false, caseSensitive: false });
    }
  }, [searchQuery]);

  const searchPrev = useCallback(() => {
    if (searchRef.current && searchQuery) {
      searchRef.current.findPrevious(searchQuery, { regex: false, caseSensitive: false });
    }
  }, [searchQuery]);

  // Safe fit: guard against zero-dimension containers and send resize to PTY.
  // Skips (rather than fits) while the pane is hidden/zero-sized — the caller
  // is expected to re-invoke once the pane becomes visible/sized again (the
  // debounced ResizeObserver below does this naturally, since a hidden->visible
  // transition is itself a resize; the visibilitychange listener is a second
  // safety net for tab/window backgrounding, where no DOM resize occurs).
  const safeFit = useCallback(() => {
    const el = termRef.current;
    const fit = fitRef.current;
    const term = xtermRef.current;
    if (!isContainerMeasurable(el) || !fit || !term) return;
    try {
      fit.fit();
      const next = { cols: term.cols, rows: term.rows };
      const ws = wsRef.current;
      // Dedupe: only notify the backend when cols/rows actually changed since
      // the last successful send. lastSentDimsRef is only updated on a
      // successful send, so a fit() that runs while the WS is briefly closed
      // (e.g. mid-reconnect) still looks "changed" once the WS reopens.
      if (ws?.readyState === WebSocket.OPEN && dimsChanged(lastSentDimsRef.current, next)) {
        ws.send(JSON.stringify({
          type: "resize",
          cols: next.cols,
          rows: next.rows,
        }));
        lastSentDimsRef.current = next;
      }
    } catch {
      // fit() can throw if terminal is disposed during resize
    }
  }, []);

  // Ref so connectWs can schedule itself recursively without a stale closure.
  // The ref is assigned immediately after the useCallback declaration below.
  const connectWsRef = useRef(null);

  // Connect terminal to PTY via WebSocket
  const connectWs = useCallback((terminalId) => {
    if (!xtermRef.current) return;
    if (originRefused.current) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${terminalId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      // Fit on connect to send initial dimensions
      safeFit();
    };

    ws.onmessage = (evt) => {
      // Handle heartbeat pings from server
      if (evt.data && evt.data.startsWith('{"type":"ping"}')) {
        try { ws.send('{"type":"pong"}'); } catch {}
        return;
      }
      // The backend could not apply our last resize (e.g. ConPTY briefly
      // unavailable). Clear the dedupe cache so the NEXT safeFit() re-sends
      // the current dims instead of assuming the backend already has them —
      // without this, a failed resize is silently recorded as "sent" and the
      // PTY size can diverge from xterm's size permanently. Self-healing;
      // no user-facing toast needed.
      if (evt.data && evt.data.startsWith('{"type":"resize_failed"}')) {
        lastSentDimsRef.current = null;
        return;
      }
      // Batch writes: accumulate data and flush once per animation frame.
      // During heavy output, this reduces hundreds of xterm.write() calls
      // per second down to ~60 (one per frame), preventing UI freezes.
      pendingDataRef.current += evt.data;
      if (!writeRafRef.current) {
        writeRafRef.current = requestAnimationFrame(() => {
          if (xtermRef.current && pendingDataRef.current) {
            xtermRef.current.write(pendingDataRef.current);
          }
          pendingDataRef.current = "";
          writeRafRef.current = null;
        });
      }
    };

    ws.onclose = (evt) => {
      // Don't reconnect if intentionally closed or terminal not found on server
      if (evt.code === 1000 || evt.code === 4004) {
        if (evt.code === 4004 && xtermRef.current) {
          xtermRef.current.write(
            "\r\n\x1b[31m[Terminal no longer exists on server]\x1b[0m\r\n"
          );
        }
        return;
      }

      // A refused origin arrives as 1006, indistinguishable here from a dead
      // backend — the server's 4403 never survives the failed handshake. Ask.
      diagnoseSocketFailure().then((verdict) => {
        if (verdict !== WS_REFUSED) return;
        originRefused.current = true;
        clearTimeout(reconnectTimer.current);
        xtermRef.current?.write(REFUSED_MESSAGE);
      });

      // Auto-reconnect: fast backoff (1s/2s/4s), then slow poll (10s) indefinitely
      const attempt = reconnectAttempts.current;
      const delay = attempt < 3
        ? Math.min(1000 * Math.pow(2, attempt), 4000)  // 1s, 2s, 4s
        : 10000;  // Then every 10s while waiting for backend recovery
      reconnectAttempts.current++;
      if (xtermRef.current) {
        if (attempt < 3) {
          xtermRef.current.write(
            `\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`
          );
        } else if (attempt === 3) {
          xtermRef.current.write(
            "\r\n\x1b[33m[Backend down — waiting for recovery...]\x1b[0m\r\n"
          );
        }
        // After attempt 3, reconnect silently every 10s
      }
      // Use the ref to avoid a stale closure on connectWs itself
      reconnectTimer.current = setTimeout(() => connectWsRef.current?.(terminalId), delay);
    };

    ws.onerror = () => {
      // onclose will handle reconnection
    };
  }, [safeFit]);

  // Keep ref in sync so the recursive setTimeout always calls the latest version
  connectWsRef.current = connectWs;

  // Initialize xterm.js
  useEffect(() => {
    if (!termRef.current) return;

    // windowsPty MUST be present at Terminal construction time — xterm reads
    // it to configure buffer/reflow behavior and it cannot be set
    // meaningfully afterwards. That means construction has to wait for the
    // (cached, app-lifetime) platform-info fetch to resolve. getPlatformInfo()
    // already times out and falls back to null on any failure, so this never
    // hangs terminal creation indefinitely — worst case we wait
    // FETCH_TIMEOUT_MS and then construct without the option, identical to
    // today's behavior.
    let cancelled = false;
    let cleanup = () => {};

    const buildTerminal = (windowsPty) => {
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: terminalZoom,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace",
        lineHeight: 1.3,
        // Built from the ref so a theme/accent/override change that lands while
        // the async platform-info fetch is in flight is not missed.
        theme: buildXtermTheme(xtermThemeInputsRef.current.theme, xtermThemeInputsRef.current),
        allowTransparency: false,
        scrollback: 10000,
        convertEol: true,
        ...(windowsPty ? { windowsPty } : {}),
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        fetch("/api/open-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: uri }),
        })
          .then((r) => { if (!r.ok) throw new Error(r.status); })
          .catch(() => window.open(uri, "_blank"));
      });

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(termRef.current);

      // Canvas renderer — no GPU texture atlas, so it is immune to the
      // multi-context glyph-atlas desync that corrupted WebGL output across
      // many panes. DOM renderer is the implicit final fallback.
      //
      // Guard: CanvasAddon.activate() reads core.linkifier to build LinkRenderLayer.
      // linkifier is undefined until late in open() AND becomes undefined again on
      // dispose (MutableDisposable clears its value). Meanwhile term.element is set
      // earlier (line ~417) and is NOT cleared the same way — so there is a window
      // where element is truthy but linkifier is undefined. CanvasAddon does not
      // guard for that, producing the "Cannot read properties of undefined (reading
      // 'onShowLinkUnderline')" crash that surfaces on popout re-mount timing.
      // Checking linkifier here (right after open()) is safe: open() sets it before
      // returning, so Canvas still loads in the normal case.
      try {
        const core = term._core; // private but stable; same accessor CanvasAddon uses internally
        if (core && core.linkifier) {
          const canvas = new CanvasAddon();
          term.loadAddon(canvas);
          canvasAddonRef.current = canvas;
        }
        // else: xterm's default DOM renderer (created during open()) stays active — correct, safe fallback.
      } catch {
        // DOM renderer remains active.
      }

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchRef.current = searchAddon;

      xtermRef.current = term;
      fitRef.current = fitAddon;

      // Capture-phase paste handler — runs BEFORE xterm's own paste listener on
      // the textarea. stopPropagation() prevents xterm from also handling it,
      // eliminating the double-paste race. terminal.paste(text) uses xterm's
      // own bracketed-paste-mode-aware path, so onData fires exactly once with
      // correctly framed data.
      const pasteHandler = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Image: synchronous detection from clipboardData.items
        const items = Array.from(e.clipboardData?.items || []);
        const imageItem = items.find(
          (it) => it.kind === "file" && it.type?.startsWith("image/")
        );

        if (imageItem) {
          const blob = imageItem.getAsFile();
          if (!blob) {
            toast?.("Image paste failed: empty blob", "error");
            return;
          }
          const ext = imageItem.type.split("/")[1]?.split("+")[0] || "png";
          const file = new File([blob], `paste.${ext}`, { type: imageItem.type });
          const formData = new FormData();
          formData.append("files", file);
          try {
            const res = await fetch("/api/upload", { method: "POST", body: formData });
            const data = await res.json();
            if (data.paths?.length && wsRef.current?.readyState === WebSocket.OPEN) {
              const p = data.paths[0];
              xtermRef.current.paste(p.includes(" ") ? `"${p}"` : p);
              toast?.("Image pasted", "success");
            } else if (data.errors?.length) {
              toast?.(`Image paste failed: ${data.errors[0]}`, "error");
            }
          } catch (err) {
            toast?.(`Image paste failed: ${err.message}`, "error");
          }
          return;
        }

        // Text: defer to xterm's paste() which respects bracketed-paste mode.
        // This fires onData exactly once with the wrapped text, which then
        // gets sent through the existing wsRef.current.send path.
        const text = e.clipboardData?.getData("text/plain");
        if (text && xtermRef.current) {
          xtermRef.current.paste(text);
        }
      };
      const termEl = termRef.current;
      termEl.addEventListener("paste", pasteHandler, { capture: true });

      // Alt+V paste handler — mirrors the Ctrl+V paste handler above but reads from
      // navigator.clipboard.read() since there is no DOM paste event for Alt+V.
      // Claude Code uses Alt+V as its native image-paste shortcut; ConPTY cannot
      // access the system clipboard, so we must intercept here and upload the image
      // before injecting the path into the PTY.
      const handleAltVPaste = async () => {
        try {
          const clipboardItems = await navigator.clipboard.read();
          let handledImage = false;

          for (const item of clipboardItems) {
            const imageType = item.types.find((t) => t.startsWith("image/"));
            if (imageType) {
              const blob = await item.getType(imageType);
              const ext = imageType.split("/")[1]?.split("+")[0] || "png";
              const file = new File([blob], `paste.${ext}`, { type: imageType });
              const formData = new FormData();
              formData.append("files", file);
              try {
                const res = await fetch("/api/upload", { method: "POST", body: formData });
                const data = await res.json();
                if (data.paths?.length && wsRef.current?.readyState === WebSocket.OPEN) {
                  const p = data.paths[0];
                  xtermRef.current.paste(p.includes(" ") ? `"${p}"` : p);
                  toast?.("Image pasted", "success");
                } else if (data.errors?.length) {
                  toast?.(`Image paste failed: ${data.errors[0]}`, "error");
                }
              } catch (err) {
                toast?.(`Image paste failed: ${err.message}`, "error");
              }
              handledImage = true;
              break;
            }
          }

          if (!handledImage) {
            // No image — fall back to text
            const text = await navigator.clipboard.readText();
            if (text && xtermRef.current) {
              xtermRef.current.paste(text);
            }
          }
        } catch (err) {
          // Clipboard API unavailable or permission denied — log silently
          toast?.(`Paste failed: ${err.message}`, "error");
        }
      };

      // Fit once mounted (double-rAF to ensure layout is settled)
      requestAnimationFrame(() => requestAnimationFrame(() => safeFit()));

      // Ctrl+C / Ctrl+V handling: copy when text is selected, interrupt only when not.
      // Prevents accidental SIGINT when the user just wants to copy, and avoids
      // session lockups caused by sending \x03 to an unresponsive process.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;

        // Ctrl+Shift+F: toggle terminal search
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key === "F") {
          setSearchVisible((v) => {
            if (!v) setTimeout(() => searchInputRef.current?.focus(), 0);
            else searchRef.current?.clearDecorations();
            return !v;
          });
          return false;
        }

        // Ctrl+C: copy if selection exists, otherwise let terminal send \x03
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "c" && !ev.shiftKey) {
          if (term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).catch(() => {});
            return false; // Don't send \x03
          }
          return true; // No selection — send interrupt
        }

        // Ctrl+Shift+C: always copy (terminal convention)
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key === "C") {
          if (term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          }
          return false;
        }

        // Ctrl+V / Ctrl+Shift+V: prevent xterm from sending raw \x16. The actual
        // paste is handled by a capture-phase 'paste' DOM listener on termRef
        // (registered earlier in this effect) — that gives us synchronous access
        // to clipboardData, blocks xterm's own paste listener via stopPropagation,
        // and uses xterm.paste() for correct bracketed-paste-mode handling.
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === "v" || ev.key === "V")) {
          return false;
        }

        // Alt+V: intercept Claude Code's native image-paste shortcut. The PTY
        // process cannot access the system clipboard, so we read it here via the
        // Clipboard API and upload any image to the backend before injecting the
        // path — matching exactly what the Ctrl+V capture-phase handler does.
        if (ev.altKey && (ev.key === "v" || ev.key === "V") && !ev.ctrlKey && !ev.metaKey) {
          handleAltVPaste(); // async — fire-and-forget from sync handler
          return false;
        }

        return true; // All other keys handled normally
      });

      // Terminal input -> WebSocket
      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });

      // Resize observer with debounce. Catches window resize, sidebar toggle,
      // pane count/layout changes, and popout-reclaim remount — anything that
      // changes the container's actual box size. It does NOT catch zoom
      // (font-size change with an unchanged box size), which is refit
      // explicitly by the terminalZoom effect below.
      const debouncedFit = debounce(safeFit, 150);
      resizeObserver.current = new ResizeObserver(debouncedFit);
      resizeObserver.current.observe(termRef.current);

      // Safety net for tab/window backgrounding: no DOM resize occurs while a
      // pane is merely occluded (minimized window, backgrounded browser tab),
      // so the ResizeObserver above never fires. Re-measure once the document
      // is visible again in case the OS/monitor geometry changed while hidden.
      const handleVisibilityChange = () => {
        if (!document.hidden) safeFit();
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      // Connect to PTY if we have a terminalId
      if (session.terminalId) {
        connectWs(session.terminalId);
      }

      cleanup = () => {
        termEl.removeEventListener("paste", pasteHandler, { capture: true });
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        debouncedFit.cancel();
        clearTimeout(reconnectTimer.current);
        cancelAnimationFrame(writeRafRef.current);
        resizeObserver.current?.disconnect();
        wsRef.current?.close();
        // Dispose CanvasAddon explicitly BEFORE term.dispose() so its internal
        // renderer-recreation runs while the linkifier is still alive. If we let
        // term.dispose() drive it, xterm tears down the linkifier MutableDisposable
        // first, leaving it undefined when CanvasAddon's dispose handler calls
        // _createRenderer() → DomRenderer constructor → linkifier.onShowLinkUnderline
        // → TypeError. Disposing here prevents that path.
        try { canvasAddonRef.current?.dispose(); } catch { /* renderer-recreation race on teardown */ }
        canvasAddonRef.current = null;
        // Safety net: even if some other xterm teardown path throws (e.g. a future
        // xterm release changes dispose order), it must NOT escape to the React
        // ErrorBoundary and blank the main window. The terminal and WS are already
        // being torn down — swallowing teardown errors is safe here.
        try {
          term.dispose();
        } catch { /* teardown race; safe to ignore */ }
        xtermRef.current = null;
        fitRef.current = null;
        searchRef.current = null;
        pendingDataRef.current = "";
        writeRafRef.current = null;
      };
    };

    // Ensure the (app-lifetime, single-fetch) cache is populated — cheap/idempotent
    // if another pane already triggered it. Most panes are NOT the first one
    // mounted, so the fast path below (synchronous, no gate at all) is the
    // common case in practice; only the very first TerminalPane/PopoutTerminal
    // of the session pays the async-wait cost.
    getPlatformInfo();
    const cachedPlatformInfo = getPlatformInfoSync();
    if (cachedPlatformInfo !== PLATFORM_INFO_PENDING) {
      buildTerminal(buildWindowsPtyOption(cachedPlatformInfo));
    } else {
      (async () => {
        const platformInfo = await getPlatformInfo();
        if (cancelled || !termRef.current) return;
        buildTerminal(buildWindowsPtyOption(platformInfo));
      })();
    }

    return () => {
      cancelled = true;
      cleanup();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: this effect runs once on mount only; theme/zoom/session changes are handled by dedicated effects below
  }, []); // Only run once on mount

  // Update theme when the theme, the accent, or any per-token override changes
  // — Canvas re-rasterizes automatically. The override map must be in the deps:
  // the ANSI palette is derived from the `--cc-*` tokens, so an override that
  // is not observed here would never reach the terminal.
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = buildXtermTheme(theme, { accent, tokenOverrides });
    }
  }, [theme, accent, tokenOverrides]);

  // Update font size when zoom changes — font size changes cols/rows WITHOUT
  // changing the container's box size, so the ResizeObserver above can never
  // catch it; this is the only path that refits after a zoom change.
  // Double-rAF (mirrors the initial-mount fit below): a single frame is not
  // always enough for the browser to settle the font-size-driven layout
  // before FitAddon reads DOM measurements. The trailing delayed fit is a
  // safety net for slower reflows, matching the paneIndex "wait for CSS to
  // settle" pattern below.
  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.fontSize = terminalZoom;
    let cancelled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) safeFit(); }));
    const fallback = setTimeout(() => { if (!cancelled) safeFit(); }, 120);
    return () => { cancelled = true; clearTimeout(fallback); };
  }, [terminalZoom, safeFit]);

  // Connect/reconnect when terminalId changes
  useEffect(() => {
    if (session.terminalId && xtermRef.current) {
      // Close old connection and cancel pending reconnects
      clearTimeout(reconnectTimer.current);
      reconnectAttempts.current = 0;
      wsRef.current?.close();
      // Reset terminal
      xtermRef.current.clear();
      // A different terminalId is a different backend PTY that has no
      // knowledge of the size we last reported to the previous one — forget
      // the dedupe cache so the post-connect safeFit() always sends fresh
      // dims even if they happen to match the old terminal's last-known size.
      lastSentDimsRef.current = null;
      connectWs(session.terminalId);
    }
  }, [session.terminalId, connectWs]);

  // Refit when pane position changes (layout switch causes external size change)
  useEffect(() => {
    // Double-delayed fit: first wait for CSS grid to settle, then fit
    const timer1 = setTimeout(safeFit, 50);
    const timer2 = setTimeout(safeFit, 200);
    return () => { clearTimeout(timer1); clearTimeout(timer2); };
  }, [paneIndex, safeFit]);

  // File drop handler — only intercept actual file drops; let pane-swap drags bubble
  const handleDrop = useCallback(async (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return; // Not a file drop — let it propagate for pane reordering

    e.preventDefault();
    e.stopPropagation();

    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));

    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.error) {
        toast?.(`Upload failed: ${data.error}`, "error");
        return;
      }
      if (data.paths?.length && wsRef.current?.readyState === WebSocket.OPEN) {
        // Paste file paths into the terminal (quote paths with spaces)
        const pathStr = data.paths
          .map((p) => (p.includes(" ") ? `"${p}"` : p))
          .join(" ");
        xtermRef.current.paste(pathStr);
        toast?.(`Dropped ${data.paths.length} file${data.paths.length > 1 ? "s" : ""}`, "success");
      } else if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        toast?.("Session not connected — cannot drop files", "error");
      }
    } catch (err) {
      toast?.(`Upload failed: ${err.message}`, "error");
    }
  }, [toast]);

  const handleDragOver = useCallback((e) => {
    // Only intercept file drags — pane-swap drags must bubble to the parent wrapper
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Interrupt (ESC) the busy generation — never gated on server side, so no
  // 409 handling needed here (unlike the /command endpoint used by PaneActionsMenu).
  const handleInterrupt = useCallback(async () => {
    if (!session.terminalId) return;
    try {
      const res = await fetch(`/api/terminals/${session.terminalId}/interrupt`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast?.(data.error || "Interrupt failed", "error");
      }
    } catch (err) {
      toast?.(`Interrupt failed: ${err.message}`, "error");
    }
  }, [session.terminalId, toast]);

  // Rename: enter inline-edit mode. Triggered by double-click on the pane
  // header name or by the "Rename…" row in PaneActionsMenu.
  // renameCommittedRef guards against a double-fire: unmounting the focused
  // <input> (React removing it from the DOM after Enter/Escape) synchronously
  // fires a native 'blur' event, which would otherwise re-invoke commitRename
  // via onBlur with the same stale value and send a duplicate PATCH.
  const renameCommittedRef = useRef(false);

  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenameValue(session.name);
    setRenameSyncClaude(true);
    setRenaming(true);
  }, [session.name]);

  const cancelRename = useCallback(() => {
    renameCommittedRef.current = true;
    setRenaming(false);
  }, []);

  const commitRename = useCallback(async () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (!trimmed || trimmed === session.name) return;
    await onRenameSession?.(trimmed, renameSyncClaude);
  }, [renameValue, renameSyncClaude, session.name, onRenameSession]);

  const activityState = session.activityState || (session.status === "running" ? "idle" : session.status);
  const isBusy = activityState === "busy";
  const isBridged = !!activeBridge;
  // Map the app's fine-grained activity states onto the shared glow-state
  // vocabulary (working|thinking|waiting|idle|error) consumed by the
  // [data-glowable][data-state] CSS contract (SPEC-FACELIFT §A/§D).
  const dataState =
    activityState === "busy" ? "working"
    : activityState === "thinking" ? "thinking"
    : activityState === "waiting" ? "waiting"
    : activityState === "error" ? "error"
    : "idle"; // idle, running, starting, history
  const stateWord = dataState.toUpperCase();

  // Bridge overlays keep their own dedicated color (salmon/red) per spec,
  // overriding the generic state glow via inline style precedence.
  const wrapperStyle = isBridged
    ? {
        boxShadow: "inset 0 0 0 2px #ff0033, 0 0 18px rgba(255, 0, 51, 0.55)",
        animation: "bridge-active-glow 2s ease-in-out infinite",
        transition: "box-shadow 0.3s ease",
      }
    : { transition: "box-shadow 0.3s ease" };

  return (
    <div
      className="flex flex-col h-full min-w-0"
      style={wrapperStyle}
    >
      {/* Pane header */}
      <div
        className="flex items-center justify-between px-3 flex-shrink-0"
        style={{
          height: 38,
          borderBottom: "1px solid var(--cc-line, var(--border-color))",
          cursor: onSwap ? "grab" : "default",
        }}
        draggable={onSwap != null && !renaming}
        onDragStart={(e) => {
          if (paneIndex == null) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", `pane:${paneIndex}`);
          // Use a minimal drag image so the browser ghost doesn't obscure the drop overlay
          const ghost = document.createElement("div");
          ghost.textContent = session.name;
          ghost.style.cssText = `
            position: fixed; top: -100px;
            padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 600;
            background: var(--bg-elevated); color: var(--accent);
            border: 1px solid var(--accent); white-space: nowrap;
          `;
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
          requestAnimationFrame(() => document.body.removeChild(ghost));
          onDragSourceChange?.(paneIndex);
        }}
        onDragEnd={() => {
          onDragSourceChange?.(null);
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {onSwap && (
            <GripVertical
              size={12}
              className="flex-shrink-0 cursor-grab"
              style={{ color: "var(--text-muted)" }}
            />
          )}
          <span className="cc-chip" data-state={dataState}>
            <StateIcon state={activityState} size={10} color={`var(--cc-${dataState})`} />
            {stateWord}
          </span>
          {renaming ? (
            <div className="flex items-center gap-1.5 min-w-0" onMouseDown={(e) => e.stopPropagation()}>
              <input
                ref={renameInputRef}
                autoFocus
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") cancelRename();
                }}
                onBlur={commitRename}
                aria-label="Session name"
                className="text-xs font-medium px-1 py-0.5 rounded min-w-0"
                style={{
                  color: "var(--text-primary)",
                  backgroundColor: "var(--bg-surface)",
                  border: "1px solid var(--accent)",
                  outline: "none",
                  width: 120,
                }}
              />
              <label
                className="flex items-center gap-1 text-[9px] flex-shrink-0"
                style={{ color: "var(--text-muted)" }}
                title="Also send /rename inside the Claude Code session"
              >
                <input
                  type="checkbox"
                  checked={renameSyncClaude}
                  onChange={(e) => setRenameSyncClaude(e.target.checked)}
                  onMouseDown={(e) => e.stopPropagation()}
                  aria-label="Also rename in Claude session"
                />
                sync
              </label>
            </div>
          ) : (
            <span
              className="truncate"
              style={{ color: "var(--cc-fg, var(--text-primary))", fontSize: 13, fontWeight: 700 }}
              onDoubleClick={startRename}
              title="Double-click to rename"
            >
              {session.name}
            </span>
          )}
          <span
            className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
            style={{
              color: "var(--cc-muted, var(--text-muted))",
              border: "1px solid var(--cc-border, var(--border-color))",
            }}
          >
            {modelLabel}
          </span>
          {session.bypassPermissions && (
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0"
              style={{
                color: "var(--cc-waiting, var(--yellow))",
                backgroundColor: "color-mix(in srgb, var(--cc-waiting, var(--yellow)) 12%, transparent)",
              }}
              title="Bypass permissions is armed for this session"
            >
              BYPASS
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {usage && (
            <div className="pane-usage-stats flex items-center gap-2 min-w-0 flex-shrink overflow-hidden">
              {usage.effort && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                  style={{
                    color: "var(--text-muted)",
                    backgroundColor: "var(--bg-surface)",
                  }}
                  title="Thinking effort"
                >
                  {usage.effort}
                </span>
              )}
              <span
                className="text-[10px] truncate"
                style={{ color: "var(--cc-muted, var(--text-muted))" }}
                title={
                  typeof usage.est_cost_usd === "number"
                    ? "Total tokens this session · estimated API-equivalent cost (what these tokens would cost at pay-as-you-go API rates — not your subscription bill)"
                    : "Total tokens this session"
                }
              >
                {"⏶"}{fmtTokens(usage.total_tokens)}
                {typeof usage.est_cost_usd === "number" && ` · $${usage.est_cost_usd.toFixed(2)}`}
              </span>
              {usage.tokensPerSec > 0 && (
                <span
                  className="text-[10px] font-semibold flex-shrink-0"
                  style={{ color: "var(--cc-fn, var(--accent))" }}
                  title="Output tokens per second"
                >
                  {usage.tokensPerSec}t/s
                </span>
              )}
            </div>
          )}
          {session.context_percent != null && (
            <span
              className="flex items-center gap-0.5 flex-shrink-0"
              title={`Context used: ${Math.round(session.context_percent)}%`}
            >
              <svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="7" fill="none" stroke="var(--cc-border, rgba(255,255,255,.1))" strokeWidth="2.5" />
                <circle
                  cx="10" cy="10" r="7" fill="none"
                  stroke={
                    session.context_percent > 75
                      ? "var(--cc-error, var(--red))"
                      : session.context_percent > 50
                        ? "var(--cc-waiting, var(--yellow))"
                        : "var(--cc-idle, var(--green))"
                  }
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray="44"
                  strokeDashoffset={44 - (44 * Math.min(100, Math.max(0, session.context_percent))) / 100}
                  transform="rotate(-90 10 10)"
                />
              </svg>
              <span className="text-[10px]" style={{ color: "var(--cc-dim, var(--text-muted))" }}>
                {Math.round(session.context_percent)}%
              </span>
            </span>
          )}
          {isBusy && (
            <button
              type="button"
              onClick={handleInterrupt}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated"
              style={{ color: "var(--red)" }}
              data-tooltip="Interrupt"
              aria-label="Interrupt session"
              title="Interrupt (Esc)"
            >
              <OctagonX size={13} />
            </button>
          )}
          {onPopout && (
            <button
              type="button"
              onClick={() => onPopout(session)}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              data-tooltip="Pop out"
              aria-label="Open terminal in separate window"
            >
              <ExternalLink size={13} />
            </button>
          )}
          {onFork && (
            <button
              type="button"
              onClick={onFork}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              data-tooltip="Fork"
              aria-label="Fork session (new session, same workdir)"
            >
              <GitFork size={13} />
            </button>
          )}
          {workflowSummary && workflowSummary.count > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setWorkflowsOpen((o) => !o)}
                className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
                style={{ color: "var(--text-muted)", position: "relative" }}
                data-tooltip="Workflows"
                aria-label={
                  workflowSummary.inProgressCount > 0
                    ? `${workflowSummary.inProgressCount} workflow(s) in progress`
                    : `${workflowSummary.count} recent workflow(s)`
                }
                title={
                  workflowSummary.inProgressCount > 0
                    ? `${workflowSummary.inProgressCount} workflow(s) in progress`
                    : `${workflowSummary.count} recent workflow(s)`
                }
              >
                <Workflow size={13} />
                {workflowSummary.inProgressCount > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: -2,
                      right: -2,
                      minWidth: 10,
                      height: 10,
                      borderRadius: "50%",
                      backgroundColor: "var(--accent)",
                      fontSize: 8,
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--bg-base)",
                      lineHeight: 1,
                      pointerEvents: "none",
                    }}
                    aria-hidden="true"
                  >
                    {workflowSummary.inProgressCount}
                  </span>
                )}
              </button>
              {workflowsOpen && (
                <WorkflowsPanel
                  workflows={workflowSummary?.items || []}
                  onClose={() => setWorkflowsOpen(false)}
                />
              )}
            </div>
          )}
          {onOpenBridge && (
            <button
              type="button"
              onClick={onOpenBridge}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              data-tooltip="Bridge"
              aria-label="Bridge to another session"
            >
              <Link2 size={13} />
            </button>
          )}
          <div className="relative">
            <button
              ref={actionsMenuBtnRef}
              type="button"
              onClick={() => setActionsMenuOpen((o) => !o)}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              data-tooltip="More actions"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={actionsMenuOpen}
            >
              <EllipsisVertical size={13} />
            </button>
            {actionsMenuOpen && (
              <PaneActionsMenu
                session={session}
                busy={isBusy}
                toast={toast}
                onClose={() => {
                  setActionsMenuOpen(false);
                  actionsMenuBtnRef.current?.focus();
                }}
                onStartRename={startRename}
                onMakeFeatured={onMakeFeatured}
              />
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-red"
            style={{ color: "var(--text-muted)" }}
            data-tooltip="Close"
            aria-label="Close session"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Search bar */}
      {searchVisible && (
        <div
          className="flex items-center gap-1 px-2 h-8 flex-shrink-0"
          style={{
            borderBottom: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-surface)",
          }}
        >
          <Search size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            ref={searchInputRef}
            className="flex-1 text-xs px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: "var(--bg-elevated)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              outline: "none",
              minWidth: 0,
            }}
            placeholder="Search terminal..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) {
                searchRef.current?.findNext(e.target.value, { regex: false, caseSensitive: false });
              } else {
                searchRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) searchPrev();
                else searchNext();
              }
              if (e.key === "Escape") {
                setSearchVisible(false);
                setSearchQuery("");
                searchRef.current?.clearDecorations();
                xtermRef.current?.focus();
              }
            }}
          />
          <button
            onClick={searchPrev}
            className="text-[10px] px-1.5 py-0.5 rounded hover-bg-elevated"
            style={{ color: "var(--text-muted)" }}
            title="Previous (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={searchNext}
            className="text-[10px] px-1.5 py-0.5 rounded hover-bg-elevated"
            style={{ color: "var(--text-muted)" }}
            title="Next (Enter)"
          >
            ↓
          </button>
          <button
            onClick={() => {
              setSearchVisible(false);
              setSearchQuery("");
              searchRef.current?.clearDecorations();
              xtermRef.current?.focus();
            }}
            className="text-[10px] px-1 py-0.5 rounded hover-bg-elevated"
            style={{ color: "var(--text-muted)" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Terminal area. Padding lives here, on termRef's PARENT, not on
          termRef itself: FitAddon.proposeDimensions() subtracts padding read
          from term.element (xterm's own generated .xterm div, which has zero
          padding) but measures available width/height from term.element's
          parentElement. Padding placed directly on termRef (term.element's
          parent) would inflate FitAddon's computed cols/rows by the padding
          size, since it is included in the measured box but never
          subtracted — a small but constant resize-accuracy bug. */}
      <div
        className="flex-1 min-h-0"
        style={{
          position: "relative",
          padding: "4px 8px",
          backgroundColor: "var(--cc-term, " + theme.bg + ")",
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <div ref={termRef} className="w-full h-full" />
        {activeBridge && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 30,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 6,
              backgroundColor: "rgba(255, 0, 51, 0.15)",
              border: "1px solid #ff5577",
              backdropFilter: "blur(4px)",
              fontSize: 11,
              fontWeight: 600,
              color: "#ff5577",
              pointerEvents: "auto",
            }}
          >
            <span>BRIDGE · turn {activeBridge.turns_used}/{activeBridge.max_turns}</span>
            <button
              type="button"
              onClick={() => onEndBridge?.(activeBridge.bridge_id)}
              className="px-2 py-0.5 rounded"
              style={{
                background: "#ff0033",
                color: "#fff",
                border: "none",
                fontSize: 10,
                fontWeight: 700,
                cursor: "pointer",
              }}
              title="End the bridge immediately"
              aria-label="End bridge"
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

export default TerminalPane;
