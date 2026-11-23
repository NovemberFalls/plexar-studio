/**
 * Tests for Settings ▸ Remote.
 *
 * Covers: devices render from GET /api/remote/status; the pair button is
 * disabled with a reason when remote is off; pairing renders a code and a
 * QR image; revoke uses the in-app confirm (never window.confirm), awaits
 * DELETE, and only removes the row on success, keeping it (with an inline
 * error) on failure.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import RemoteSettings from "../components/settings/RemoteSettings.jsx";

const STATUS_ON = {
  enabled: true,
  hostname: "https://studio.example.com",
  protocol: 1,
  devices: [
    {
      id: "dv_abc123",
      name: "Len's Pixel",
      created_at: "2026-09-01T10:00:00Z",
      last_seen: "2026-09-07T10:00:00Z",
      revoked_at: null,
    },
  ],
};

const STATUS_OFF = { enabled: false, hostname: "", protocol: 1, devices: [] };

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

const CF_STATUS_ON = { installed: true, path: "C:\\tools\\cloudflared.exe", version: "2026.5.0", running: true };
const CF_CONFIG = {
  hostname: "studio.example.com",
  config_yml: "tunnel: <tunnel-id>\ningress:\n  - hostname: studio.example.com\n",
  commands: ["cloudflared tunnel login", "cloudflared service install"],
};

function makeFetchMock({
  status = STATUS_ON,
  pairing,
  pairingOk = true,
  deleteOk = true,
  deleteBody = { revoked: true },
  cfStatus = CF_STATUS_ON,
  cfConfig = CF_CONFIG,
  cfConfigOk = true,
  probeResult = { hostname: "studio.example.com", classification: "guarded", status: 401 },
  probeOk = true,
} = {}) {
  return vi.fn((url, opts = {}) => {
    const method = opts.method || "GET";
    if (url === "/api/remote/status" && method === "GET") {
      return jsonResponse(status);
    }
    if (url === "/api/remote/pairings" && method === "POST") {
      return jsonResponse(
        pairing || {
          code: "ABCD-EFGH",
          expires_at: Date.now() / 1000 + 300,
          url: "https://studio.example.com",
          qr_payload: JSON.stringify({ v: 1, url: "https://studio.example.com", code: "ABCD-EFGH" }),
        },
        pairingOk
      );
    }
    if (url.startsWith("/api/remote/devices/") && method === "DELETE") {
      return jsonResponse(deleteOk ? deleteBody : { error: "revoke failed" }, deleteOk);
    }
    if (url === "/api/remote/cloudflared" && method === "GET") {
      return jsonResponse(cfStatus);
    }
    if (url.startsWith("/api/remote/cloudflared-config") && method === "GET") {
      return jsonResponse(cfConfigOk ? cfConfig : { error: "invalid hostname" }, cfConfigOk);
    }
    if (url === "/api/remote/probe" && method === "POST") {
      return jsonResponse(probeOk ? probeResult : { error: "invalid hostname" }, probeOk);
    }
    return jsonResponse({});
  });
}

function makeSettingsProps(overrides = {}) {
  const draft = { remote: { enabled: true, hostname: "https://studio.example.com" }, ...overrides };
  return {
    get: (path, fallback) => {
      const parts = path.split(".");
      let cur = draft;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object" || !(p in cur)) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    },
    setField: vi.fn(),
  };
}

// Steps 1 and 2 fold into a status line once both are saved; open them again.
async function openSetup() {
  await waitFor(() => expect(screen.queryByTestId("remote-loading")).toBeNull());
  const change = screen.queryByTestId("setup-change");
  if (change && !screen.queryByTestId("card-reach")) fireEvent.click(change);
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RemoteSettings — devices", () => {
  it("renders devices from GET /api/remote/status", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("devices-table")).toBeInTheDocument());
    expect(screen.getByText("Len's Pixel")).toBeInTheDocument();
  });
});

describe("RemoteSettings — pairing gate", () => {
  it("disables the pairing button with a reason when remote is off", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_OFF });
    render(<RemoteSettings {...makeSettingsProps({ remote: { enabled: false, hostname: "" } })} />);
    await waitFor(() => expect(screen.getByTestId("start-pairing")).toBeInTheDocument());
    expect(screen.getByTestId("start-pairing")).toBeDisabled();
    expect(screen.getByTestId("pairing-blocked-reason")).toHaveTextContent("Turn on remote access in step 1 and save.");
  });

  it("disables Pair a device with the address reason when no address is saved", async () => {
    globalThis.fetch = makeFetchMock({ status: { ...STATUS_ON, hostname: "" } });
    render(<RemoteSettings {...makeSettingsProps({ remote: { enabled: true, hostname: "" } })} />);
    await waitFor(() => expect(screen.getByTestId("pairing-blocked-reason")).toBeInTheDocument());
    expect(screen.getByTestId("start-pairing")).toBeDisabled();
    expect(screen.getByTestId("start-pairing")).toHaveTextContent("Pair a device");
    expect(screen.getByTestId("pairing-blocked-reason")).toHaveTextContent(
      "Set this machine's address in step 2 and save."
    );
  });
});

describe("RemoteSettings — pairing flow", () => {
  it("enabling then pairing shows the code and a QR image containing data", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("start-pairing")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("start-pairing"));

    await waitFor(() => expect(screen.getByTestId("pairing-code")).toHaveTextContent("ABCD-EFGH"));
    const qr = await screen.findByTestId("pairing-qr");
    expect(qr).toBeInTheDocument();
    expect(qr.getAttribute("src")).toMatch(/^data:image\//);
  });

  it("offers the qr_payload verbatim as a copyable pairing link", async () => {
    const payload = JSON.stringify({ v: 1, url: "https://studio.example.com", code: "ABCD-EFGH", access: true });
    globalThis.fetch = makeFetchMock({
      status: STATUS_ON,
      pairing: { code: "ABCD-EFGH", expires_at: Date.now() / 1000 + 300, url: "https://studio.example.com", qr_payload: payload },
    });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("start-pairing")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("start-pairing"));
    await screen.findByTestId("pairing-result");
    expect(screen.getByText("Phone: scan this in Plexar Mobile")).toBeInTheDocument();
    expect(screen.getByText("Another computer: copy this pairing link")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("copy-pairing-link"));
    await waitFor(() => expect(screen.getByTestId("copy-pairing-link-copied")).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(payload);
  });

  it("renders a 409 pairing error inline", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON, pairing: { error: "remote disabled" }, pairingOk: false });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("start-pairing")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("start-pairing"));
    await waitFor(() => expect(screen.getByTestId("pairing-error")).toHaveTextContent("remote disabled"));
  });
});

describe("RemoteSettings — revoke", () => {
  it("opens an in-app confirm, awaits DELETE, and removes the row on success", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON, deleteOk: true });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("device-row-dv_abc123")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("revoke-dv_abc123"));
    expect(screen.getByTestId("revoke-confirm")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("revoke-confirm-button"));

    await waitFor(() => expect(screen.queryByTestId("revoke-confirm")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId("device-row-dv_abc123")).not.toBeInTheDocument());
  });

  it("keeps the row and shows an inline error when DELETE fails", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON, deleteOk: false });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("device-row-dv_abc123")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("revoke-dv_abc123"));
    fireEvent.click(screen.getByTestId("revoke-confirm-button"));

    await waitFor(() => expect(screen.getByTestId("revoke-error")).toHaveTextContent("revoke failed"));
    expect(screen.getByTestId("device-row-dv_abc123")).toBeInTheDocument();
  });
});

describe("RemoteSettings — page structure", () => {
  it("orders the cards 1, 2, 3, devices and keeps Harness off the page", async () => {
    globalThis.fetch = makeFetchMock();
    render(<RemoteSettings {...makeSettingsProps()} />);
    await openSetup();
    const ids = ["card-setup-summary", "card-remote-toggle", "card-reach", "card-pairing", "card-devices"];
    const els = ids.map((id) => screen.getByTestId(id));
    for (let i = 1; i < els.length; i++) {
      expect(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByText("1 · Turn on remote access")).toBeInTheDocument();
    expect(screen.getByText("2 · How devices reach this machine")).toBeInTheDocument();
    expect(screen.getByText("3 · Pair a device")).toBeInTheDocument();
    expect(screen.queryByTestId("card-harness")).toBeNull();
    expect(screen.queryByTestId("card-cloudflare-deployment")).toBeNull();
    expect(screen.queryByTestId("card-tunnel-connector")).toBeNull();
  });
});

describe("RemoteSettings — how devices reach this machine", () => {
  it("shows 'No address set' until one is typed", async () => {
    globalThis.fetch = makeFetchMock();
    render(<RemoteSettings {...makeSettingsProps({ remote: { enabled: true, hostname: "" } })} />);
    await openSetup();
    expect(screen.getByTestId("reach-status")).toHaveTextContent("No address set");
  });

  it("choosing 'Only devices on this network' writes remote.lan.enabled, and leaving it writes it back", async () => {
    globalThis.fetch = makeFetchMock();
    const props = makeSettingsProps();
    render(<RemoteSettings {...props} />);
    await openSetup();
    expect(screen.getByRole("radiogroup", { name: "How devices reach this machine" })).toBeInTheDocument();
    const lan = screen.getByTestId("reach-lan");
    expect(lan).not.toBeDisabled();
    expect(lan).not.toBeChecked();
    fireEvent.click(lan);
    expect(props.setField).toHaveBeenCalledWith("remote.lan.enabled", true);
  });

  it("shows the local address, the port and the plain-words notes in local mode, and no tunnel fields", async () => {
    globalThis.fetch = makeFetchMock({
      status: { ...STATUS_ON, lan: { enabled: true, port: 8421, running: true, url: "http://192.168.1.20:8421", error: null } },
    });
    const props = makeSettingsProps({
      remote: { enabled: true, hostname: "https://studio.example.com", lan: { enabled: true, port: 8421 } },
    });
    render(<RemoteSettings {...props} />);
    await openSetup();
    expect(screen.getByTestId("reach-lan")).toBeChecked();
    await waitFor(() => expect(screen.getByTestId("lan-state")).toHaveTextContent("Listening at http://192.168.1.20:8421"));
    expect(screen.getByTestId("lan-notes")).toHaveTextContent("This connection is not encrypted");
    expect(screen.queryByTestId("tunnel-start")).toBeNull();
    expect(screen.queryByTestId("remote-hostname-input")).toBeNull();
    expect(screen.queryByTestId("access-required-toggle")).toBeNull();
    expect(screen.getByTestId("setup-summary-address")).toHaveTextContent("http://192.168.1.20:8421");

    fireEvent.change(screen.getByTestId("lan-port-input"), { target: { value: "9000" } });
    expect(props.setField).toHaveBeenCalledWith("remote.lan.port", 9000);
    fireEvent.click(screen.getByTestId("reach-own-address"));
    expect(props.setField).toHaveBeenCalledWith("remote.lan.enabled", false);
  });

  it("blocks pairing with the listener's own error when local mode cannot listen", async () => {
    globalThis.fetch = makeFetchMock({
      status: { ...STATUS_ON, lan: { enabled: true, port: 8421, running: false, url: "", error: "Port 8421 is not available on this computer." } },
    });
    render(<RemoteSettings {...makeSettingsProps({ remote: { enabled: true, hostname: "", lan: { enabled: true, port: 8421 } } })} />);
    await waitFor(() =>
      expect(screen.getByTestId("pairing-blocked-reason")).toHaveTextContent("Port 8421 is not available on this computer.")
    );
    expect(screen.getByTestId("start-pairing")).toBeDisabled();
    expect(screen.getByTestId("lan-error")).toBeInTheDocument();
    expect(screen.queryByTestId("card-setup-summary")).toBeNull();
  });

  it("starts on the tunnel answer when it is enabled; switching to own-address hides the connector and writes no setting", async () => {
    globalThis.fetch = makeFetchMock();
    const props = makeSettingsProps({
      remote: { enabled: true, hostname: "https://studio.example.com", tunnel: { enabled: true } },
    });
    render(<RemoteSettings {...props} />);
    await openSetup();
    expect(screen.getByTestId("reach-studio-tunnel")).toBeChecked();
    expect(screen.getByTestId("tunnel-start")).toBeInTheDocument();
    expect(screen.getByTestId("probe-public-url")).toBeInTheDocument();
    expect(screen.getByTestId("access-required-toggle")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reach-own-address"));
    expect(screen.queryByTestId("tunnel-start")).toBeNull();
    expect(screen.queryByTestId("tunnel-token-input")).toBeNull();
    expect(screen.queryByTestId("tunnel-autostart-toggle")).toBeNull();
    expect(screen.getByTestId("config-example-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("probe-public-url")).toBeInTheDocument();
    expect(props.setField).not.toHaveBeenCalled();
  });
});

describe("RemoteSettings — Cloudflare config example", () => {
  it("renders the cloudflared status line behind the disclosure", async () => {
    globalThis.fetch = makeFetchMock();
    render(<RemoteSettings {...makeSettingsProps()} />);
    await openSetup();
    expect(screen.queryByTestId("config-example")).toBeNull();
    fireEvent.click(screen.getByTestId("config-example-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("cloudflared-status-line")).toHaveTextContent("installed (2026.5.0)")
    );
    expect(screen.getByTestId("cloudflared-status-line")).toHaveTextContent("running");
  });

  it("Generate config shows the yml and the command list with copy buttons", async () => {
    globalThis.fetch = makeFetchMock();
    render(<RemoteSettings {...makeSettingsProps()} />);
    await openSetup();
    fireEvent.click(screen.getByTestId("config-example-toggle"));
    await waitFor(() => expect(screen.getByTestId("generate-config")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("generate-config"));

    await waitFor(() => expect(screen.getByTestId("cloudflared-config-result")).toBeInTheDocument());
    expect(screen.getByTestId("cloudflared-config-yml")).toHaveTextContent("tunnel: <tunnel-id>");
    expect(screen.getByTestId("cloudflared-commands").children.length).toBe(2);

    fireEvent.click(screen.getByTestId("copy-config-yml"));
    await waitFor(() => expect(screen.getByTestId("copy-config-yml-copied")).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CF_CONFIG.config_yml);
  });

  it("shows an inline copy error when the clipboard write fails", async () => {
    navigator.clipboard.writeText = vi.fn(() => Promise.reject(new Error("nope")));
    globalThis.fetch = makeFetchMock();
    render(<RemoteSettings {...makeSettingsProps()} />);
    await openSetup();
    fireEvent.click(screen.getByTestId("config-example-toggle"));
    await waitFor(() => expect(screen.getByTestId("generate-config")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("generate-config"));
    await waitFor(() => expect(screen.getByTestId("cloudflared-config-result")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("copy-config-yml"));
    await waitFor(() => expect(screen.getByTestId("copy-config-yml-error")).toBeInTheDocument());
  });

  it("Test public URL shows the classification and its repair hint", async () => {
    globalThis.fetch = makeFetchMock({
      probeResult: { hostname: "studio.example.com", classification: "unreachable", status: null },
    });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await openSetup();
    await waitFor(() => expect(screen.getByTestId("probe-public-url")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("probe-public-url"));

    await waitFor(() => expect(screen.getByTestId("probe-result")).toHaveTextContent("unreachable"));
    expect(screen.getByTestId("probe-result")).toHaveTextContent(/cloudflared service is running/);
  });

  it("renders an inline error when the probe request itself fails", async () => {
    globalThis.fetch = makeFetchMock({ probeOk: false });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await openSetup();
    await waitFor(() => expect(screen.getByTestId("probe-public-url")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("probe-public-url"));
    await waitFor(() => expect(screen.getByTestId("probe-error")).toHaveTextContent("invalid hostname"));
  });

  it("disables the Cloudflare tools with a reason when there is no public URL set", async () => {
    globalThis.fetch = makeFetchMock();
    render(
      <RemoteSettings {...makeSettingsProps({ remote: { enabled: true, hostname: "" } })} />
    );
    await openSetup();
    fireEvent.click(screen.getByTestId("config-example-toggle"));
    await waitFor(() => expect(screen.getByTestId("generate-config")).toBeDisabled());
    expect(screen.getByTestId("probe-public-url")).toBeDisabled();
    expect(screen.getByTestId("cloudflare-tools-disabled-reason")).toBeInTheDocument();
  });

  it("toggling Cloudflare Access required writes remote.access_required via setField", async () => {
    globalThis.fetch = makeFetchMock();
    const props = makeSettingsProps();
    render(<RemoteSettings {...props} />);
    await openSetup();
    await waitFor(() => expect(screen.getByTestId("access-required-toggle")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("access-required-toggle"));
    expect(props.setField).toHaveBeenCalledWith("remote.access_required", true);
  });
});

describe("RemoteSettings — tabs and the folded setup", () => {
  it("keeps the two directions on separate tabs", async () => {
    globalThis.fetch = makeFetchMock();
    render(<RemoteSettings {...makeSettingsProps()} />);
    await screen.findByTestId("card-pairing");
    expect(screen.getByTestId("remote-tab-host")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("heading-controls")).toBeNull();
    expect(screen.queryByTestId("card-peers")).toBeNull();

    fireEvent.click(screen.getByTestId("remote-tab-control"));
    expect(screen.getByTestId("heading-controls")).toBeInTheDocument();
    expect(screen.getByTestId("card-peers")).toBeInTheDocument();
    expect(screen.queryByTestId("card-pairing")).toBeNull();
    expect(screen.queryByTestId("card-devices")).toBeNull();
  });

  it("folds steps 1 and 2 into a status line once both are saved, and reopens them", async () => {
    globalThis.fetch = makeFetchMock();
    render(<RemoteSettings {...makeSettingsProps()} />);
    await screen.findByTestId("card-setup-summary");
    expect(screen.getByTestId("setup-summary-address")).toHaveTextContent("https://studio.example.com");
    expect(screen.queryByTestId("card-remote-toggle")).toBeNull();
    expect(screen.queryByTestId("card-reach")).toBeNull();
    expect(screen.getByTestId("card-pairing")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("setup-change"));
    expect(screen.getByTestId("card-remote-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("card-reach")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("setup-change"));
    expect(screen.queryByTestId("card-reach")).toBeNull();
  });

  it("shows the steps, and no status line, while setup is unfinished", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_OFF });
    render(<RemoteSettings {...makeSettingsProps({ remote: { enabled: false, hostname: "" } })} />);
    await screen.findByTestId("card-remote-toggle");
    expect(screen.getByTestId("card-reach")).toBeInTheDocument();
    expect(screen.queryByTestId("card-setup-summary")).toBeNull();
  });
});

describe("RemoteSettings — device list hygiene", () => {
  const day = 86400000;
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const DEVICES = [
    { id: "dv_old", name: "Old phone", created_at: iso(90 * day), last_seen: iso(60 * day), revoked_at: null },
    { id: "dv_gone", name: "Gone phone", created_at: iso(90 * day), last_seen: iso(80 * day), revoked_at: iso(70 * day) },
    { id: "dv_new", name: "New phone", created_at: iso(5 * day), last_seen: iso(1000), revoked_at: null },
  ];

  it("hides revoked devices until asked, and lists the most recently seen first", async () => {
    globalThis.fetch = makeFetchMock({ status: { ...STATUS_ON, devices: DEVICES } });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await screen.findByTestId("devices-table");
    expect(screen.queryByTestId("device-row-dv_gone")).toBeNull();
    const fresh = screen.getByTestId("device-row-dv_new");
    const old = screen.getByTestId("device-row-dv_old");
    expect(fresh.compareDocumentPosition(old) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const toggle = screen.getByTestId("devices-show-revoked");
    expect(toggle).toHaveTextContent("Show 1 revoked");
    fireEvent.click(toggle);
    expect(screen.getByTestId("device-row-dv_gone")).toBeInTheDocument();
    expect(screen.queryByTestId("revoke-dv_gone")).toBeNull();
  });

  it("flags an active device not seen for 30 days, and only that one", async () => {
    globalThis.fetch = makeFetchMock({ status: { ...STATUS_ON, devices: DEVICES } });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await screen.findByTestId("devices-table");
    expect(screen.getByTestId("device-stale-dv_old")).toHaveTextContent("not seen for 60 days");
    expect(screen.queryByTestId("device-stale-dv_new")).toBeNull();
    expect(screen.getByTestId("revoke-dv_old")).toBeInTheDocument();
  });
});
