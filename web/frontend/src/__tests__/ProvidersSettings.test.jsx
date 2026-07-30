/**
 * ProvidersSettings — Settings ▸ Providers & Endpoints page.
 *
 * The contract under test is the Settings-shell prop contract
 * ({get, setField, isDirty}) plus the honesty rules the spec pins:
 *   - all five provider cards render even when live probes fail
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
      capabilities: ["models", "health", "queue", "metrics", "spill"],
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

const OPENROUTER = { configured: true, source: "ui", masked: "sk-or-v1…4f21" };

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body });

function installFetch(overrides = {}) {
  const impl = vi.fn(async (url, init) => {
    const u = String(url);
    if (u === "/api/local/providers") return jsonOk(overrides.providers ?? PROVIDERS);
    if (u === "/api/local/status") return jsonOk(overrides.status ?? STATUS);
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

  it("renders all five provider cards plus the Claude CLI card", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);

    // Wait for the mount probes to settle so no act() warning leaks.
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    for (const id of [
      "card-lane-broker",
      "card-lmstudio",
      "card-vllm",
      "card-ollama",
      "card-openrouter",
      "card-claude-cli",
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

    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/unknown/i));
    expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument();
    expect(screen.getByTestId("card-vllm")).toBeInTheDocument();
    expect(screen.getByTestId("card-ollama")).toBeInTheDocument();
    // Reachability degrades to "unknown", never to a fake green.
    expect(screen.getByTestId("lmstudio-health")).toHaveTextContent(/unknown/i);
  });

  it("routes a base-URL edit through setField with the exact dotted path", async () => {
    const shell = makeShell({ draft: { "providers.lmstudio.base_url": "http://127.0.0.1:1234" } });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    fireEvent.change(screen.getByTestId("field-providers.lmstudio.base_url"), {
      target: { value: "http://127.0.0.1:9999" },
    });

    expect(shell.setField).toHaveBeenCalledWith(
      "providers.lmstudio.base_url",
      "http://127.0.0.1:9999"
    );
  });

  it("routes the concurrency slider and the autostart toggle through setField", async () => {
    const shell = makeShell({ draft: { "providers.lane_broker.concurrency": 1 } });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    fireEvent.change(screen.getByTestId("field-providers.lane_broker.concurrency"), {
      target: { value: "4" },
    });
    expect(shell.setField).toHaveBeenCalledWith("providers.lane_broker.concurrency", 4);

    // Toggle is a radiogroup of two segments; clicking "On" records `true`.
    fireEvent.click(screen.getByRole("radio", { name: /Autostart with Cockpit: On/i }));
    expect(shell.setField).toHaveBeenCalledWith("providers.lane_broker.autostart", true);
  });

  it("highlights a dirty field with --cc-waiting on both border and value text", async () => {
    const path = "providers.vllm.base_url";
    const shell = makeShell({
      draft: { [path]: "http://127.0.0.1:8001" },
      dirtyPaths: [path],
    });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

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
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    // LM Studio declares queue but not traces; vLLM declares neither.
    const lmCard = screen.getByTestId("card-lmstudio");
    const vllmCard = screen.getByTestId("card-vllm");

    const lmQueue = lmCard.querySelector('[data-testid="cap-queue"]');
    const lmTraces = lmCard.querySelector('[data-testid="cap-traces"]');
    const vllmQueue = vllmCard.querySelector('[data-testid="cap-queue"]');
    const vllmModels = vllmCard.querySelector('[data-testid="cap-models"]');

    expect(lmQueue).toHaveAttribute("data-present", "true");
    expect(lmQueue.style.opacity).toBe("1");

    // Absent capabilities are shown-but-dimmed, never hidden.
    expect(lmTraces).toHaveAttribute("data-present", "false");
    expect(lmTraces.style.opacity).toBe("0.5");
    expect(vllmQueue).toHaveAttribute("data-present", "false");
    expect(vllmQueue.style.opacity).toBe("0.5");
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
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    const browse = screen.getByTestId("browse-providers.lmstudio.models_dir");
    expect(browse).toBeDisabled();
    expect(browse.getAttribute("title")).toMatch(/Phase 9/);

    const start = screen.getByTestId("vllm-start");
    expect(start).toBeDisabled();
    expect(start.getAttribute("title")).toMatch(/Engine/);

    expect(screen.getByTestId("overflow-vLLM")).toBeDisabled();
  });

  it("enables Browse and reports the dotted path when onBrowse is supplied", async () => {
    const onBrowse = vi.fn();
    const shell = makeShell();
    render(<ProvidersSettings {...shell} onBrowse={onBrowse} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    const browse = screen.getByTestId("browse-claude_cli.binary_path");
    expect(browse).toBeEnabled();
    fireEvent.click(browse);
    expect(onBrowse).toHaveBeenCalledWith("claude_cli.binary_path");
  });

  it("shows an em dash for the undetected Claude CLI version instead of inventing one", async () => {
    const shell = makeShell({ draft: { "claude_cli.detected_version": null } });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    expect(screen.getByTestId("cli-detected-version")).toHaveTextContent("—");
    expect(screen.getByText(/backlog 03/i)).toBeInTheDocument();
  });

  it("warns when the resolved Claude CLI path is not the claude binary", async () => {
    const shell = makeShell({ draft: { "claude_cli.binary_path": "C:/tools/notclaude.exe" } });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));

    expect(screen.getByTestId("cli-mismatch")).toBeInTheDocument();
  });

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

    await waitFor(() => expect(screen.getByTestId("broker-health")).toHaveTextContent(/online/i));
    const afterMount = fetchMock.mock.calls.filter((c) => c[0] === "/api/local/status").length;
    expect(afterMount).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId("test-lane-broker"));
    });
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/local/status").length).toBe(2);
  });
});

/**
 * The stale-URL rule. A probe can only ever hit the SAVED url the server is
 * using, so a green pill sitting next to an edited-but-unsaved URL field reads
 * as "Cockpit told me this URL was fine" — true about the system, a lie about
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

  it("disables that card's Test and shows the qualifying note when its base URL is dirty", async () => {
    const shell = makeShell({ dirtyPaths: ["providers.lane_broker.base_url"] });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());

    const test = screen.getByTestId("test-lane-broker");
    expect(test).toBeDisabled();
    expect(test.getAttribute("title")).toBe(
      "Save changes first — Test probes the URL the server is currently using, not the edited value."
    );
    expect(screen.getByTestId("stale-url-lane-broker")).toBeInTheDocument();
  });

  it("qualifies the stale pill rather than blanking it", async () => {
    const shell = makeShell({ dirtyPaths: ["providers.lane_broker.base_url"] });
    render(<ProvidersSettings {...shell} />);

    // The reading still appears (online), but it is explicitly attributed to
    // the saved URL and recolored to the waiting token.
    await waitFor(() =>
      // "online · <latency>ms · saved URL"
      expect(screen.getByTestId("broker-health")).toHaveTextContent(/online.*saved URL/i)
    );
    expect(screen.getByTestId("broker-health").getAttribute("style")).toMatch(/--cc-waiting/);
    expect(screen.getByTestId("broker-health").getAttribute("title")).toMatch(/not your edit/i);
  });

  it("leaves clean sibling cards fully testable", async () => {
    const shell = makeShell({ dirtyPaths: ["providers.lane_broker.base_url"] });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());

    // Only the lane-broker card is gated.
    expect(screen.getByTestId("test-lane-broker")).toBeDisabled();
    expect(screen.getByTestId("test-lmstudio")).toBeEnabled();
    expect(screen.getByTestId("test-vllm")).toBeEnabled();
    expect(screen.getByTestId("test-ollama")).toBeEnabled();
    expect(screen.queryByTestId("stale-url-lmstudio")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stale-url-vllm")).not.toBeInTheDocument();
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
    // Lane broker is untouched.
    expect(screen.getByTestId("test-lane-broker")).toBeEnabled();
    expect(screen.getByTestId("broker-health")).not.toHaveTextContent(/saved URL/i);
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
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());

    // Lane concurrency and GPU utilisation persist but are still env-driven —
    // a slider that saves cleanly and changes nothing is a trap.
    expect(screen.getByTestId("not-enforced-lane-broker")).toHaveTextContent(
      /Lane concurrency is saved, but Cockpit does not apply it yet/i
    );
    expect(screen.getByTestId("not-enforced-vllm")).toHaveTextContent(
      /GPU memory utilisation is saved, but Cockpit does not apply it yet/i
    );
  });

  it("explains why Default backend is LM Studio only", async () => {
    const shell = makeShell();
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());

    expect(screen.getByTestId("field-providers.lmstudio.default").getAttribute("title")).toMatch(
      /only backend/i
    );
  });
});
