/**
 * useSettings — the single data hook behind the Settings section.
 *
 * Settings are INTENT, not live state: we fetch once on mount and never poll.
 * Local edits are recorded as a draft plus a Set of dirty dotted paths; save()
 * builds a MINIMAL nested patch from exactly those paths (the backend
 * deep-merges), so two people editing different sections never clobber each
 * other's fields and we never PUT a stale copy of the whole blob.
 *
 * Backend contract (pinned):
 *   GET  /api/settings         -> { path, settings }
 *   PUT  /api/settings         -> body = partial nested patch
 *                                 200 { path, settings }  (new EFFECTIVE settings)
 *                                 400 { error }
 *   POST /api/settings/reveal  -> always 200 { ok, path, error? }
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Leaves the backend REPLACES wholesale instead of deep-merging.
 *
 * These are free-form maps (arbitrary user-chosen keys), so a per-leaf merge
 * would make DELETION impossible — you could never remove a token override or
 * unbind a key. The backend is right to replace them; the consequence is that a
 * narrow patch like {appearance:{token_overrides:{"--cc-bg":"..."}}} would wipe
 * every other override the user had saved. buildPatch therefore promotes any
 * dirty path at or beneath one of these prefixes to the WHOLE dict from `draft`.
 *
 * This lives in the hook, not the pages, so no future page can get it wrong.
 *
 * CAVEAT for system.keybindings: its KEYS themselves contain dots
 * ("pane.next"), so a dotted leaf path like "system.keybindings.pane.next" is
 * ambiguous with a nested {pane:{next}} and CANNOT be addressed per-leaf. Such
 * a path is a safe no-op (never a partial write). Edit that dict with a single
 * whole-dict call instead — setField("system.keybindings", nextMap) — which is
 * safe precisely because the backend replaces the key wholesale.
 */
export const WHOLE_DICT_PATHS = [
  "appearance.token_overrides",
  "appearance.user_palettes",
  "system.keybindings",
];

/** The whole-dict prefix governing `dottedPath`, or null if none does. */
export function wholeDictPrefixFor(dottedPath) {
  if (typeof dottedPath !== "string") return null;
  for (const prefix of WHOLE_DICT_PATHS) {
    if (dottedPath === prefix || dottedPath.startsWith(`${prefix}.`)) return prefix;
  }
  return null;
}

/** Split "providers.lmstudio.base_url" -> ["providers","lmstudio","base_url"]. */
function splitPath(dottedPath) {
  if (typeof dottedPath !== "string" || dottedPath.length === 0) return [];
  return dottedPath.split(".");
}

/** Read a dotted path out of a nested object; `fallback` when any hop is missing. */
export function getIn(obj, dottedPath, fallback = undefined) {
  const parts = splitPath(dottedPath);
  if (parts.length === 0) return fallback;
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return fallback;
    if (!(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur === undefined ? fallback : cur;
}

/** Immutably set a dotted path, cloning only the touched spine. */
export function setIn(obj, dottedPath, value) {
  const parts = splitPath(dottedPath);
  if (parts.length === 0) return obj;
  const root = { ...(obj && typeof obj === "object" ? obj : {}) };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = cur[key];
    cur[key] = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

/** Immutably DELETE a dotted path, cloning only the touched spine. No-op if absent. */
export function deleteIn(obj, dottedPath) {
  const parts = splitPath(dottedPath);
  if (parts.length === 0) return obj;
  if (!obj || typeof obj !== "object") return obj;
  const root = { ...obj };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = cur[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) return obj; // nothing to delete
    cur[key] = { ...next };
    cur = cur[key];
  }
  delete cur[parts[parts.length - 1]];
  return root;
}

/**
 * Build the MINIMAL nested patch for the dirty paths.
 *
 * Ordinary paths are emitted as narrow leaves (the backend deep-merges them).
 * Paths governed by WHOLE_DICT_PATHS are promoted to their whole dict, and
 * multiple dirty leaves under the same prefix collapse into ONE entry — the
 * backend replaces that key outright, so it must receive the complete map
 * (including untouched siblings, and excluding anything the user deleted).
 */
export function buildPatch(draft, dirtyPaths) {
  let patch = {};
  const wholeDictPrefixes = new Set();

  for (const p of dirtyPaths) {
    const prefix = wholeDictPrefixFor(p);
    if (prefix) {
      wholeDictPrefixes.add(prefix);
      continue;
    }
    patch = setIn(patch, p, getIn(draft, p, null));
  }

  for (const prefix of wholeDictPrefixes) {
    // Fallback {} matters: if the user deleted every entry, the correct patch is
    // an empty map (clear them all), not a missing key (leave them alone).
    patch = setIn(patch, prefix, getIn(draft, prefix, {}));
  }
  return patch;
}

export default function useSettings() {
  const [path, setPath] = useState(null);
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirtyPaths, setDirtyPaths] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Fetch once. Settings are intent — there is nothing to poll for.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(data?.error || "Could not load settings");
        } else {
          setPath(data?.path ?? null);
          setSettings(data?.settings ?? {});
          setDraft(data?.settings ?? {});
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Could not load settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const get = useCallback(
    (dottedPath, fallback = undefined) => getIn(draft, dottedPath, fallback),
    [draft]
  );

  const setField = useCallback((dottedPath, value) => {
    if (typeof dottedPath !== "string" || dottedPath.length === 0) return;
    setDraft((prev) => setIn(prev || {}, dottedPath, value));
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      next.add(dottedPath);
      return next;
    });
  }, []);

  /**
   * Remove a key entirely (rather than setting it to null). Only truly
   * expressible for paths under WHOLE_DICT_PATHS, because those are replaced
   * wholesale; elsewhere the backend deep-merges, so the best a patch can say
   * is `null` — which is what buildPatch will emit for a deleted ordinary leaf.
   */
  const deleteField = useCallback((dottedPath) => {
    if (typeof dottedPath !== "string" || dottedPath.length === 0) return;
    setDraft((prev) => deleteIn(prev || {}, dottedPath));
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      next.add(dottedPath);
      return next;
    });
  }, []);

  /**
   * True when `dottedPath` itself is dirty OR any leaf beneath it is, so a page
   * can highlight a whole group (e.g. isDirty("appearance.token_overrides")).
   */
  const isDirty = useCallback(
    (dottedPath) => {
      if (typeof dottedPath !== "string" || dottedPath.length === 0) return false;
      if (dirtyPaths.has(dottedPath)) return true;
      const childPrefix = `${dottedPath}.`;
      for (const p of dirtyPaths) {
        if (p.startsWith(childPrefix)) return true;
      }
      return false;
    },
    [dirtyPaths]
  );

  const revert = useCallback(() => {
    setDraft(settings);
    setDirtyPaths(new Set());
    setError(null);
  }, [settings]);

  const save = useCallback(async () => {
    if (dirtyPaths.size === 0) return false;
    setSaving(true);
    const patch = buildPatch(draft, dirtyPaths);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Keep the draft so the user does not lose their edits.
        if (mounted.current) setError(data?.error || "Could not save settings");
        return false;
      }
      if (mounted.current) {
        setPath(data?.path ?? null);
        setSettings(data?.settings ?? {});
        setDraft(data?.settings ?? {});
        setDirtyPaths(new Set());
        setError(null);
      }
      return true;
    } catch {
      if (mounted.current) setError("Could not save settings");
      return false;
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [draft, dirtyPaths]);

  const reveal = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/reveal", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok && mounted.current) {
        setError(data?.error || "Could not reveal the settings file");
      }
      return data;
    } catch {
      if (mounted.current) setError("Could not reveal the settings file");
      return { ok: false };
    }
  }, []);

  const dirty = dirtyPaths.size > 0;

  return useMemo(
    () => ({
      path,
      settings,
      draft,
      loading,
      error,
      saving,
      dirty,
      isDirty,
      get,
      setField,
      deleteField,
      save,
      revert,
      reveal,
    }),
    [
      path,
      settings,
      draft,
      loading,
      error,
      saving,
      dirty,
      isDirty,
      get,
      setField,
      deleteField,
      save,
      revert,
      reveal,
    ]
  );
}
