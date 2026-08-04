/**
 * Reports ▸ Traces — S26.
 *
 * THE MOVE, AND WHAT IT DOES NOT FIX. This tab used to be a "not built" panel
 * pointing at Engine ▸ Requests, which rendered the real trace tree. S26 brings
 * the renderer here, because Reports owns the PAST and a completed request tree
 * is the past.
 *
 * IT MOVES AN EMPTY PANEL, AND IT SAYS SO. The lane broker ships in shadow mode,
 * so no job is ever queued and a trace is written per queued job; Plexar does not
 * publish traces at all. Consolidation must not be allowed to look like it fixed
 * the recorder, so `TRACES_EMPTY_WHY` renders WITH the panel whenever the list
 * comes back empty. The copy that explained the emptiness travelled with it.
 *
 * SOURCED INDEPENDENTLY, like Local engine. Reports' own /api/usage/report call
 * knows nothing about local providers, so this tab reads them itself and is NOT
 * gated on that request's loading/error/empty state — a user with no Claude usage
 * this range can still have traces, and vice versa.
 *
 * There is no range control here on purpose: /traces serves a recent-N window,
 * not a time range, and wiring the range pills to a control that cannot honour
 * them would be a lie in the shape of a feature.
 */
import { useEffect, useState } from "react";

import { TracesCard } from "../engine/EngineRequests.jsx";
import { Note } from "../engine/ui.jsx";
import { TRACES_EMPTY_WHY, TRACES_WILL } from "./notBuilt.js";

const LIMIT = 50;

async function getJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export default function TracesTab() {
  // `undefined` = still reading, `null` = asked and could not read, [] = read and
  // there is nothing. Three states, never collapsed — an empty list and an
  // unreachable backend look identical on screen otherwise, and they mean
  // opposite things.
  const [state, setState] = useState({ loading: true, providers: [], traces: undefined, id: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await getJson("/api/local/providers");
      const providers = Array.isArray(list?.providers) ? list.providers : [];
      const withTraces = providers.filter((p) => (p.capabilities || []).includes("traces"));
      if (cancelled) return;
      if (withTraces.length === 0) {
        setState({ loading: false, providers, traces: undefined, id: null });
        return;
      }
      const id = withTraces[0].id;
      const body = await getJson(`/api/local/${encodeURIComponent(id)}/traces?limit=${LIMIT}`);
      if (cancelled) return;
      setState({
        loading: false,
        providers,
        // A failed read is null, not []. See the three-state note above.
        traces: body === null ? null : Array.isArray(body.traces) ? body.traces : [],
        id,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return (
      <div data-testid="traces-loading" style={{ fontSize: 11, color: "var(--cc-muted)", padding: 4 }}>
        Reading traces…
      </div>
    );
  }

  const hasTraces = state.id !== null;

  return (
    <div data-testid="reports-traces" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <TracesCard
        traces={state.traces === undefined ? [] : state.traces}
        providerId={state.id}
        hasTraces={hasTraces}
        emptyNote={TRACES_EMPTY_WHY}
      />
      <Note testId="traces-will">{`When something records, this becomes: ${TRACES_WILL}`}</Note>
    </div>
  );
}
