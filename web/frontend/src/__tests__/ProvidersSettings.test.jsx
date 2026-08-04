/**
 * ProvidersSettings — Settings ▸ Providers & Endpoints page.
 *
 * The contract under test is the Settings-shell prop contract
 * ({get, setField, isDirty}) plus the honesty rules the spec pins:
 *   - all four provider cards render even when live probes fail
 *   - every edit flows through setField with the exact dotted path
 *   - a dirty field is highlighted with --cc-waiting (not just tracked)
 *   - capability chips DIM for undeclared capabilities instead of vanishing
 *   - the OpenRouter card never puts a full key on screen
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import ProvidersSettings from "../components/settings/ProvidersSettings";

const PROVIDERS = {
  providers: [
    {
      id: "lmstudio-local",
      label: "LM Studio (local)",
      kind: "lmstudio",
      scope: "local",
      // Deliberately the full broker vocabulary MINUS "traces" so the dim path
      // is exercised on a card that otherwise looks fully capable.
      capabilities: ["models", "health"],
    },
    {
      id: "vllm-local",
      label: "vLLM (local)",
      kind: "vllm",
      scope: "local",
      capabilities: ["models", "health"],
    },
  ],
};

const STATUS = {
  reachable: true,
  compatible: true,
  service: "lane-broker",
  detail: "lane broker contract verified via /queue",
  url: "http://127.0.0.1:1235",
  managed: true,
};

// GET /api/local/vllm/ownership — the three states the vLLM card must tell apart.
const OWNERSHIP_EXTERNAL = {
  effective: false, configured: false, external: false, source: "settings",
  pending_restart: false, requires_restart: false, env_set: false,
  reason: "vLLM is external — start and stop it where you started it.",
};
const OWNERSHIP_PENDING = {
  effective: false, configured: true, external: false, source: "settings",
  pending_restart: true, requires_restart: true, env_set: false,
  reason: "Saved. Plexar Studio starts the vLLM container during startup…",
};
const OWNERSHIP_PORT_HELD = {
  effective: false, configured: true, external: true, source: "external",
  pending_restart: false, requires_restart: false, env_set: false,
  reason: "An external vLLM is already answering on this port…",
};
const OWNERSHIP_MANAGED = {
  effective: true, configured: true, external: false, source: "settings",
  pending_restart: false, requires_restart: false, env_set: false,
  reason: "Plexar Studio owns this vLLM container.",
};

const OPENROUTER = { configured: true, source: "ui", masked: "sk-or-v1…4f21" };

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body });

function installFetch(overrides = {}) {
  const impl = vi.fn(async (url, init) => {
    const u = String(url);
    if (u === "/api/local/providers") return jsonOk(overrides.providers ?? PROVIDERS);
    if (u === "/api/local/vllm/ownership") {
      // null override = the route is unreachable (best-effort surface).
      return "ownership" in overrides
        ? (overrides.ownership === null
            ? { ok: false, status: 404, json: async () => ({}) }
            : jsonOk(overrides.ownership))
        : jsonOk(OWNERSHIP_EXTERNAL);
    }
    if (u.endsWith("/health")) {
      return jsonOk({ broker: { reachable: true }, provider: { reachable: true, models_loaded: 2 }, ok: true });
    }
    if (u === "/api/settings/openrouter") {
      if (init?.method === "DELETE") return jsonOk({ ok: true, configured: false, source: null, masked: null });
      if (init?.method === "POST") return jsonOk({ ok: true, masked: "sk-or-v1…9aa1" });
      return jsonOk(overrides.openrouter ?? OPENROUTER);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  globalThis.fetch = impl;
  return impl;
}

/** A minimal stand-in for the Settings shell's draft store. */
function makeShell({ draft = {}, dirtyPaths = [] } = {}) {
  const setField = vi.fn();
  return {
    get: (path, fallback) => (path in draft ? draft[path] : fallback),
    setField,
    isDirty: (path) => dirtyPaths.includes(path),
  };
}

describe("ProvidersSettings", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("renders all four provider cards — Lane broker deleted (T9), Claude CLI moved", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);

    // Wait for the mount probes to settle so no act() warning leaks.
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    for (const id of [
      "card-lmstudio",
      "card-vllm",
      "card-ollama",
      "card-openrouter",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("still renders every card when the live probes fail", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);

    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());
    expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument();
    expect(screen.getByTestId("card-vllm")).toBeInTheDocument();
    expect(screen.getByTestId("card-ollama")).toBeInTheDocument();
    // Reachability degrades to "unknown", never to a fake green.
    expect(screen.getByTestId("lmstudio-health")).toHaveTextContent(/unknown/i);
  });

  it("routes a base-URL edit through setField with the exact dotted path", async () => {
    const shell = makeShell({ draft: { "providers.lmstudio.base_url": "http://127.0.0.1:1234" } });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("field-providers.lmstudio.base_url"), {
      target: { value: "http://127.0.0.1:9999" },
    });

    expect(shell.setField).toHaveBeenCalledWith(
      "providers.lmstudio.base_url",
      "http://127.0.0.1:9999"
    );
  });

  /* REMOVED T9: "routes the concurrency slider and the autostart toggle
     through setField". Both controls lived on the Lane broker card and both
     were declared not-enforced against their own values -- the server reads
     COCKPIT_MANAGED_BROKER for autostart and nothing at all reads concurrency.
     The card is gone, so there is no longer a control for setField to route.
     Deleted rather than re-pointed at another card: the assertion was about
     THOSE two paths, and pointing it at a different one would keep a green
     test whose subject no longer exists. The surviving guard is
     ProvidersSettings.laneBrokerHonesty.test.jsx, which now fails if any
     providers.lane_broker.* control comes back. */

  it("highlights a dirty field with --cc-waiting on both border and value text", async () => {
    const path = "providers.vllm.base_url";
    const shell = makeShell({
      draft: { [path]: "http://127.0.0.1:8001" },
      dirtyPaths: [path],
    });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    // jsdom's cssstyle drops var() out of the typed properties, so the inline
    // style attribute is the honest place to assert the token landed.
    const dirtyInput = screen.getByTestId(`field-${path}`);
    expect(dirtyInput).toHaveAttribute("data-dirty", "true");
    const dirtyStyle = dirtyInput.getAttribute("style");
    // border AND value text both carry the waiting token.
    expect(dirtyStyle).toMatch(/border:\s*1px solid var\(--cc-waiting\)/);
    expect(dirtyStyle).toMatch(/color:\s*var\(--cc-waiting\)/);

    // A clean sibling field must NOT be highlighted.
    const cleanInput = screen.getByTestId("field-providers.lmstudio.base_url");
    expect(cleanInput).toHaveAttribute("data-dirty", "false");
    const cleanStyle = cleanInput.getAttribute("style");
    expect(cleanStyle).toMatch(/border:\s*1px solid var\(--cc-border\)/);
    expect(cleanStyle).not.toMatch(/--cc-waiting/);
  });

  it("dims capability chips for capabilities a backend does not declare", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    // T11: `queue` and `traces` are no longer capabilities at all, so the
    // chip set is what a backend can really promise. LM Studio declares
    // models+health but not metrics; vLLM declares metrics.
    const lmCard = screen.getByTestId("card-lmstudio");
    const vllmCard = screen.getByTestId("card-vllm");

    const lmModels = lmCard.querySelector('[data-testid="cap-models"]');
    const lmMetrics = lmCard.querySelector('[data-testid="cap-metrics"]');
    const vllmModels = vllmCard.querySelector('[data-testid="cap-models"]');

    expect(lmModels).toHaveAttribute("data-present", "true");
    expect(lmModels.style.opacity).toBe("1");

    // Absent capabilities are shown-but-dimmed, never hidden.
    expect(lmMetrics).toHaveAttribute("data-present", "false");
    expect(lmMetrics.style.opacity).toBe("0.5");
    expect(vllmModels).toHaveAttribute("data-present", "true");
  });

  it("never renders an unmasked OpenRouter key", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-masked")).toHaveTextContent("sk-or-v1…4f21")
    );
    expect(screen.getByTestId("openrouter-key-pill")).toHaveTextContent(/key saved/i);

    // The paste field holds only what the user types — it is never seeded from
    // the server, and it is a password field until the user opts to peek.
    const input = screen.getByTestId("openrouter-key-input");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");

    // Nothing anywhere on the page looks like a whole key.
    expect(document.body.textContent).not.toMatch(/sk-or-v1-[A-Za-z0-9]{8,}/);
  });

  it("posts a pasted OpenRouter key and clears the field on success", async () => {
    const fetchMock = installFetch();
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);
    await waitFor(() =>
      expect(screen.getByTestId("openrouter-masked")).toHaveTextContent("sk-or-v1…4f21")
    );

    const input = screen.getByTestId("openrouter-key-input");
    fireEvent.change(input, { target: { value: "sk-or-v1-brandnewkey" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-masked")).toHaveTextContent("sk-or-v1…9aa1")
    );
    expect(input).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/openrouter",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("keeps the inert controls inert (Browse, Start engine, overflow) with an explanatory title", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    const browse = screen.getByTestId("browse-providers.lmstudio.models_dir");
    expect(browse).toBeDisabled();
    expect(browse.getAttribute("title")).toMatch(/Phase 9/);

    const start = screen.getByTestId("vllm-start");
    expect(start).toBeDisabled();
    // The reason names OWNERSHIP, not a future phase: Plexar Studio must not start a
    // container it does not own, and there is no start-on-demand endpoint.
    expect(start.getAttribute("title")).toMatch(/does not own this vLLM/i);
    expect(screen.getByTestId("vllm-launch-command-note")).toHaveTextContent(
      /does not read this launch command/i
    );

    expect(screen.getByTestId("overflow-vLLM")).toBeDisabled();
  });

  // ── vLLM "Managed by Plexar Studio" — the toggle that used to lie ──
  //
  // It writes providers.vllm.managed, which the server NOW reads, but only at
  // startup (the container is launched there). So the card must say what state
  // the user is in, and the three states have different fixes.
  describe("vLLM ownership caveats", () => {
    const renderWith = async (ownership, shell = makeShell()) => {
      installFetch({ ownership });
      render(<ProvidersSettings {...shell} />);
      await waitFor(() => expect(screen.getByTestId("card-vllm")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId("vllm-managed-pill")).toBeInTheDocument());
    };

    it("renders the restart caveat when the toggle is saved but not in effect", async () => {
      // Saved: the draft mirrors settings.json, and the server confirms the
      // value has not reached the running container yet.
      await renderWith(OWNERSHIP_PENDING, makeShell({ draft: { "providers.vllm.managed": true } }));
      expect(screen.getByTestId("vllm-managed-pending-restart")).toHaveTextContent(
        /takes effect the next time Plexar Studio restarts/i
      );
      expect(screen.queryByTestId("vllm-managed-external")).not.toBeInTheDocument();
      // Ownership is server-reported, so the pill must NOT claim "Managed" yet.
      expect(screen.getByTestId("vllm-managed-pill")).toHaveTextContent(/External/);
    });

    it("renders the restart caveat when the draft flips the toggle on", async () => {
      // Not yet saved: the server still reports external, but the user has
      // already changed the control, so the caveat must be on screen with it.
      await renderWith(
        OWNERSHIP_EXTERNAL,
        makeShell({ draft: { "providers.vllm.managed": true }, dirtyPaths: ["providers.vllm.managed"] })
      );
      expect(screen.getByTestId("vllm-managed-pending-restart")).toBeInTheDocument();
    });

    it("explains the external-vLLM case DISTINCTLY — a restart will not help", async () => {
      await renderWith(OWNERSHIP_PORT_HELD);
      const note = screen.getByTestId("vllm-managed-external");
      expect(note).toHaveTextContent(/already answering on this port/i);
      expect(note).toHaveTextContent(/Restarting Plexar Studio will not change this/i);
      expect(screen.queryByTestId("vllm-managed-pending-restart")).not.toBeInTheDocument();
    });

    it("says the env var wins when COCKPIT_MANAGED_VLLM is set", async () => {
      await renderWith(
        { ...OWNERSHIP_MANAGED, source: "env", env_set: true },
        makeShell({ draft: { "providers.vllm.managed": false } })
      );
      expect(screen.getByTestId("vllm-managed-env-pinned")).toHaveTextContent(
        /COCKPIT_MANAGED_VLLM.*wins over this toggle/i
      );
      expect(screen.queryByTestId("vllm-managed-pending-restart")).not.toBeInTheDocument();
    });

    it("shows no caveat when configured and effective agree", async () => {
      await renderWith(
        OWNERSHIP_MANAGED,
        makeShell({ draft: { "providers.vllm.managed": true } })
      );
      expect(screen.getByTestId("vllm-managed-pill")).toHaveTextContent(/Managed/);
      expect(screen.queryByTestId("vllm-managed-pending-restart")).not.toBeInTheDocument();
      expect(screen.queryByTestId("vllm-managed-external")).not.toBeInTheDocument();
      expect(screen.queryByTestId("vllm-managed-env-pinned")).not.toBeInTheDocument();
    });

    it("claims nothing when the ownership route is unreachable", async () => {
      await renderWith(null, makeShell({ draft: { "providers.vllm.managed": true } }));
      expect(screen.queryByTestId("vllm-managed-pending-restart")).not.toBeInTheDocument();
      expect(screen.queryByTestId("vllm-managed-external")).not.toBeInTheDocument();
    });
  });

  it("enables Browse and reports the dotted path when onBrowse is supplied", async () => {
    const onBrowse = vi.fn();
    const shell = makeShell();
    render(<ProvidersSettings {...shell} onBrowse={onBrowse} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    // Repointed from claude_cli.binary_path to a SURVIVING Browse field when the
    // Claude CLI card was removed. The mechanism under test is Browse itself —
    // still live for LM Studio's CLI binary and models folder — so this keeps its
    // coverage instead of losing it with the card.
    const browse = screen.getByTestId("browse-providers.lmstudio.cli_path");
    expect(browse).toBeEnabled();
    fireEvent.click(browse);
    expect(onBrowse).toHaveBeenCalledWith("providers.lmstudio.cli_path");
  });

  /* The two Claude CLI assertions that were here (em-dash version, wrong-binary
     warning) moved WITH the behaviour to Settings ▸ Claude CLI, which reads the
     real GET /api/cli instead of the settings keys nothing on the server read.
     They are covered by ClaudeCliSettings.test.jsx — "renders an em dash for a
     null version and invents nothing" and its name_matches:false fixture — so
     this is a relocation, not a coverage loss. The old em-dash test also
     asserted a "backlog 03" note that became false when GET /api/cli landed. */

  it("re-probes only on an explicit Test click — never on an interval", async () => {
    // Settings is intent, not a live dashboard: the page must not install a
    // poller. Spying on setInterval is a stabler proof than advancing fake
    // timers (and keeps async state updates inside act()).
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const fetchMock = installFetch();
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);
    // Checked before any waitFor — waitFor itself installs a polling interval.
    expect(intervalSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());
    const afterMount = fetchMock.mock.calls.filter((c) => c[0] === "/api/local/providers").length;
    expect(afterMount).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId("test-lmstudio"));
    });
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/local/providers").length).toBe(2);
  });
});

/**
 * The stale-URL rule. A probe can only ever hit the SAVED url the server is
 * using, so a green pill sitting next to an edited-but-unsaved URL field reads
 * as "Plexar Studio told me this URL was fine" — true about the system, a lie about
 * the screen. Test must refuse; the pill must be qualified, not blanked.
 */
describe("ProvidersSettings — unsaved URL cannot be tested", () => {
  beforeEach(() => {
    installFetch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  /* THE EXEMPLAR CARD FOR THIS RULE MOVED, T9. Every test below used the Lane
     broker card as its dirty subject; that card is deleted, so they now use LM
     Studio, which has a real base-URL control the server also does not read
     from settings. The RULE is unchanged and so are the assertions - only the
     card the rule is demonstrated on. Deleting them instead would have left the
     stale-URL rule with no coverage at all. */
  it("disables that card's Test and shows the qualifying note when its base URL is dirty", async () => {
    const shell = makeShell({ dirtyPaths: ["providers.lmstudio.base_url"] });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    const test = screen.getByTestId("test-lmstudio");
    expect(test).toBeDisabled();
    expect(test.getAttribute("title")).toBe(
      "Save changes first — Test probes the URL the server is currently using, not the edited value."
    );
    expect(screen.getByTestId("stale-url-lmstudio")).toBeInTheDocument();
  });

  it("qualifies the stale pill rather than blanking it", async () => {
    const shell = makeShell({ dirtyPaths: ["providers.lmstudio.base_url"] });
    render(<ProvidersSettings {...shell} />);

    // The reading still appears, but it is explicitly attributed to the saved
    // URL and recolored to the waiting token. Blanking it would be the other
    // lie: no pill reads as "not checked yet".
    await waitFor(() =>
      expect(screen.getByTestId("lmstudio-health")).toHaveTextContent(/saved URL/i)
    );
    expect(screen.getByTestId("lmstudio-health").getAttribute("style")).toMatch(/--cc-waiting/);
    expect(screen.getByTestId("lmstudio-health").getAttribute("title")).toMatch(/not your edit/i);
  });

  it("leaves clean sibling cards fully testable", async () => {
    const shell = makeShell({ dirtyPaths: ["providers.lmstudio.base_url"] });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    // Only the LM Studio card is gated.
    expect(screen.getByTestId("test-lmstudio")).toBeDisabled();
    expect(screen.getByTestId("test-vllm")).toBeEnabled();
    expect(screen.getByTestId("test-ollama")).toBeEnabled();
    expect(screen.queryByTestId("stale-url-vllm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stale-url-ollama")).not.toBeInTheDocument();
  });

  it("gates each backend card independently and qualifies its own health pill", async () => {
    const shell = makeShell({ dirtyPaths: ["providers.vllm.base_url"] });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() =>
      expect(screen.getByTestId("vllm-health")).toHaveTextContent(/saved URL/i)
    );

    expect(screen.getByTestId("test-vllm")).toBeDisabled();
    expect(screen.getByTestId("stale-url-vllm")).toBeInTheDocument();
    // The vLLM Managed/External lifecycle pill depends on the same URL.
    expect(screen.getByTestId("vllm-managed-pill")).toHaveTextContent(/saved URL/i);
    // LM Studio is untouched.
    expect(screen.getByTestId("test-lmstudio")).toBeEnabled();
    expect(screen.getByTestId("lmstudio-health")).not.toHaveTextContent(/saved URL/i);
  });

  it("drops the note and re-enables Test once the field is no longer dirty", async () => {
    const dirty = makeShell({ dirtyPaths: ["providers.ollama.base_url"] });
    const { unmount } = render(<ProvidersSettings {...dirty} />);
    await waitFor(() => expect(screen.getByTestId("stale-url-ollama")).toBeInTheDocument());
    expect(screen.getByTestId("test-ollama")).toBeDisabled();
    unmount();

    // Same page, isDirty now false everywhere (i.e. after the shell saved).
    const clean = makeShell();
    render(<ProvidersSettings {...clean} />);
    await waitFor(() => expect(screen.getByTestId("test-ollama")).toBeEnabled());
    expect(screen.queryByTestId("stale-url-ollama")).not.toBeInTheDocument();
    expect(screen.getByTestId("ollama-health")).not.toHaveTextContent(/saved URL/i);
  });

  it("says plainly which saved values the server does not enforce yet", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    // GPU utilisation persists but is still env-driven — a slider that saves
    // cleanly and changes nothing is a trap.
    //
    // The three lane-broker notes this test also asserted are gone WITH their
    // controls (T9): the strongest resolution of the defect they annotated,
    // since a control that cannot mislead beats one that apologises.
    // ProvidersSettings.laneBrokerHonesty.test.jsx fails if any of them returns.
    expect(screen.queryByTestId("not-enforced-lane-broker-concurrency")).toBeNull();
    expect(screen.getByTestId("not-enforced-vllm")).toHaveTextContent(
      /GPU memory utilisation is saved, but Plexar Studio does not apply it yet/i
    );
  });

  it("explains why Default backend is LM Studio only", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    expect(screen.getByTestId("field-providers.lmstudio.default").getAttribute("title")).toMatch(
      /only backend/i
    );
  });

  /**
   * Service identity, re-homed from the deleted LocalBrokerView test that
   * asserted a wrong-service broker reads as offline rather than healthy.
   *
   * This branch was LIVE and had NO coverage on this page — every other case
   * here passes compatible:true. It matters because LM Studio's dev server
   * answers unknown paths with "200 anyway" plus an error body, so a reachable
   * probe is not evidence of the right service. A green pill here would tell the
   * user the lane broker is fine while something else holds the port.
   */
  /**
   * Models-folder config, re-homed from the deleted LocalBrokerView
   * DirectProviderConnectionCard (LocalBrokerView.modelsFolder.test.jsx).
   *
   * The behaviour CHANGED on purpose and these tests pin the new contract
   * rather than the old one: LocalBrokerView PUT the path straight to
   * /api/local/{id}/models-dir on a per-card Save and toasted the server's
   * reply. Settings owns configuration now, so the field is draft intent
   * written through setField and committed by the shell's save. Asserting the
   * old PUT here would be asserting a behaviour the product no longer has.
   */
  it("routes a models-folder edit through setField with the exact dotted path", async () => {
    const shell = makeShell({ draft: { "providers.lmstudio.models_dir": "~/.lmstudio/models" } });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    const field = screen.getByTestId("field-providers.lmstudio.models_dir");
    expect(field).toHaveValue("~/.lmstudio/models");

    fireEvent.change(field, { target: { value: "D:\\models" } });
    expect(shell.setField).toHaveBeenCalledWith("providers.lmstudio.models_dir", "D:\\models");
  });

  it("does not write the models folder to the server itself — the shell's save owns that", async () => {
    const fetchMock = installFetch();
    const shell = makeShell({ draft: { "providers.lmstudio.models_dir": "/models" } });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("field-providers.lmstudio.models_dir"), {
      target: { value: "/mnt/models" },
    });

    // No PUT anywhere, and specifically nothing to the models-dir route the old
    // LocalBrokerView card wrote to. A page that both drafts AND writes would
    // give the user two competing sources of truth for one path.
    await act(async () => {});
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(writes).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("models-dir"))).toBe(false);
  });
});

/**
 * The vLLM models-folder section — the re-homed owner of
 * GET|PUT /api/local/{id}/models-dir.
 *
 * These four assertions are restored from the deleted
 * LocalBrokerView.modelsFolder.test.jsx. That component was removed as dead
 * code, but it was the ONLY frontend caller of these routes, so deleting it
 * meant a user could not point managed vLLM at a models directory from the UI
 * at all. The routes were always live; only the caller went missing.
 *
 * Note the contract difference from the LM Studio "Models folder" field tested
 * above: that one IS a settings.json draft (providers.lmstudio.models_dir). This
 * one is a live server write that applies and persists immediately, which is why
 * these tests assert a real PUT rather than a setField call.
 */
const DISCOVERY_PROVIDERS = {
  providers: [
    PROVIDERS.providers[0],
    {
      id: "vllm-local",
      label: "vLLM (local)",
      kind: "vllm",
      scope: "local",
      capabilities: ["models", "health", "model-control", "model-discovery"],
    },
  ],
};

const MODELS_DIR = {
  path: "/home/me/models",
  mount_path: "/models",
  scan_path: "\\\\wsl$\\Ubuntu\\home\\me\\models",
  exists: true,
  writable_config: true,
  current_model: "/models/Qwen3-Coder-30B-A3B-AWQ",
};

/**
 * Fetch stub that knows the models-dir routes.
 * `modelsDir` seeds the GET; `putResponse` / `putOk` control the PUT.
 */
function installDiscoveryFetch({
  providers = DISCOVERY_PROVIDERS,
  modelsDir = MODELS_DIR,
  putResponse = { ...MODELS_DIR, path: "/mnt/models" },
  putOk = true,
} = {}) {
  const impl = vi.fn(async (url, init) => {
    const u = String(url);
    if (u === "/api/local/providers") return jsonOk(providers);
    if (u.endsWith("/models-dir")) {
      if (init?.method === "PUT") {
        return putOk
          ? jsonOk(putResponse)
          : { ok: false, status: 400, json: async () => putResponse };
      }
      return jsonOk(modelsDir);
    }
    if (u.endsWith("/models")) {
      return jsonOk({ reachable: true, models: [{ id: "/models/newmodel", state: "available" }] });
    }
    if (u.endsWith("/health")) {
      return jsonOk({
        broker: { reachable: true },
        provider: { reachable: true, models_loaded: 1 },
        ok: true,
      });
    }
    if (u === "/api/settings/openrouter") return jsonOk(OPENROUTER);
    return { ok: false, status: 404, json: async () => ({}) };
  });
  globalThis.fetch = impl;
  return impl;
}

describe("ProvidersSettings — vLLM models folder (live server write)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it("renders the section when vLLM declares model-discovery", async () => {
    installDiscoveryFetch();
    render(<ProvidersSettings {...makeShell()} />);

    await waitFor(() => expect(screen.getByTestId("vllm-models-dir")).toBeInTheDocument());
    expect(screen.getByText("Models Folder")).toBeInTheDocument();
    expect(screen.getByLabelText("Host models folder")).toBeInTheDocument();
  });

  it("does not render the section without model-discovery", async () => {
    // PROVIDERS' vLLM entry declares only ["models","health"].
    const fetchMock = installDiscoveryFetch({ providers: PROVIDERS });
    render(<ProvidersSettings {...makeShell()} />);

    await waitFor(() => expect(screen.getByTestId("card-vllm")).toBeInTheDocument());
    await act(async () => {});
    expect(screen.queryByTestId("vllm-models-dir")).not.toBeInTheDocument();
    expect(screen.queryByText("Models Folder")).not.toBeInTheDocument();
    // Absent capability must mean absent traffic too, not a hidden section that
    // still probes the route.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/models-dir"))).toBe(false);
  });

  it("PUTs the entered path to /api/local/{id}/models-dir and re-reads the model list", async () => {
    const fetchMock = installDiscoveryFetch();
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);

    await waitFor(() =>
      expect(screen.getByTestId("vllm-models-dir-input")).toHaveValue("/home/me/models")
    );

    fireEvent.change(screen.getByTestId("vllm-models-dir-input"), {
      target: { value: "/mnt/models" },
    });
    fireEvent.click(screen.getByTestId("vllm-models-dir-save"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/local/vllm-local/models-dir",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ path: "/mnt/models" }) })
      )
    );
    // Changing the folder changes what is discoverable, so the list is re-read.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u) === "/api/local/vllm-local/models")
      ).toBe(true)
    );
    // A live write must NOT also be drafted — that would be two sources of truth
    // for one path, and the draft key is one nothing reads.
    expect(shell.setField).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("vllm-models-dir-saved")).toBeInTheDocument());
  });

  it("surfaces the server's own 400 message verbatim", async () => {
    installDiscoveryFetch({ putOk: false, putResponse: { error: "path must be absolute" } });
    render(<ProvidersSettings {...makeShell()} />);

    await waitFor(() => expect(screen.getByTestId("vllm-models-dir-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("vllm-models-dir-input"), {
      target: { value: "relative/path" },
    });
    fireEvent.click(screen.getByTestId("vllm-models-dir-save"));

    const alert = await screen.findByRole("alert");
    // Verbatim: the server is the only thing that knows what is wrong with the
    // path, so a generic "failed" would throw away the entire diagnostic.
    expect(alert).toHaveTextContent("path must be absolute");
    expect(screen.queryByTestId("vllm-models-dir-saved")).not.toBeInTheDocument();
  });

  it("says the path applies immediately rather than on Save changes", async () => {
    installDiscoveryFetch();
    render(<ProvidersSettings {...makeShell()} />);

    const note = await screen.findByTestId("vllm-models-dir-immediate");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/does not wait for Save changes/i);
    expect(screen.getByTestId("vllm-models-dir")).toHaveTextContent(
      /applies immediately — not on Save changes/i
    );
    // The control itself is labelled as an immediate action, not "Save".
    expect(screen.getByTestId("vllm-models-dir-save")).toHaveAccessibleName("Apply now");
  });

  it("warns that an already-running container is not remounted", async () => {
    installDiscoveryFetch();
    render(<ProvidersSettings {...makeShell()} />);

    const note = await screen.findByTestId("vllm-models-dir-remount");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(
      /does not reconfigure a vLLM container that is already running/i
    );
    expect(note).toHaveTextContent(/restart it/i);
  });

  it("renders mount and scan paths, the exists indicator, and current model when sent", async () => {
    installDiscoveryFetch();
    render(<ProvidersSettings {...makeShell()} />);

    await waitFor(() =>
      expect(screen.getByTestId("vllm-models-dir-path")).toHaveTextContent("/home/me/models")
    );
    expect(screen.getByTestId("vllm-models-dir-exists")).toHaveTextContent("exists");
    expect(screen.getByTestId("vllm-models-dir-mount")).toHaveTextContent("/models");
    expect(screen.getByTestId("vllm-models-dir-scan")).toHaveTextContent("home\\me\\models");
    expect(screen.getByTestId("vllm-models-dir-current-model")).toHaveTextContent(
      "/models/Qwen3-Coder-30B-A3B-AWQ"
    );
  });

  it("omits fields the server did not send instead of fabricating them", async () => {
    installDiscoveryFetch({
      modelsDir: { path: "", mount_path: "", scan_path: "", exists: false, writable_config: true },
    });
    render(<ProvidersSettings {...makeShell()} />);

    await waitFor(() =>
      expect(screen.getByTestId("vllm-models-dir-path")).toHaveTextContent("not set")
    );
    expect(screen.queryByTestId("vllm-models-dir-mount")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vllm-models-dir-scan")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vllm-models-dir-current-model")).not.toBeInTheDocument();
    // No path configured → no exists/not-found verdict to render about it.
    expect(screen.queryByTestId("vllm-models-dir-exists")).not.toBeInTheDocument();
  });

  it("reports a missing folder as not found rather than silently accepting it", async () => {
    installDiscoveryFetch({ modelsDir: { ...MODELS_DIR, exists: false } });
    render(<ProvidersSettings {...makeShell()} />);

    await waitFor(() =>
      expect(screen.getByTestId("vllm-models-dir-exists")).toHaveTextContent("not found")
    );
  });
});
