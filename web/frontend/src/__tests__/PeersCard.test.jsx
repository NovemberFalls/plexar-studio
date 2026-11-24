import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import PeersCard from "../components/settings/PeersCard";
import { __resetPeersStore } from "../hooks/usePeers";

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let routes;
beforeEach(() => {
  __resetPeersStore();
  routes = {};
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    const h = routes[key];
    if (!h) return res(404, { error: "unknown" });
    return typeof h === "function" ? h(opts) : h;
  });
});

const link = (url, code, access) => JSON.stringify({ v: 1, url, code, ...(access ? { access: true } : {}) });

const PEER = { id: "p1", label: "Desk PC", url: "https://desk.example.com", access_token_set: false };

describe("PeersCard", () => {
  it("renders each status reason with its own remedy", async () => {
    const reasons = ["unreachable", "unauthorized", "access_required", "access_refused", "remote_disabled"];
    const peers = reasons.map((r, i) => ({ ...PEER, id: `p${i}`, label: `M${i}` }));
    routes["GET /api/peers"] = res(200, { peers });
    peers.forEach((p, i) => { routes[`GET /api/peers/${p.id}/status`] = res(200, { reachable: true, authorized: false, reason: reasons[i] }); });
    render(<PeersCard />);
    await waitFor(() => expect(screen.getAllByTestId("peer-status").map((e) => e.dataset.reason)).toEqual(reasons));
    const texts = screen.getAllByTestId("peer-status").map((e) => e.textContent);
    expect(new Set(texts).size).toBe(reasons.length);
  });

  it("refuses half an Access token without sending, and shows a pairing failure inline", async () => {
    routes["GET /api/peers"] = res(200, { peers: [] });
    routes["POST /api/peers"] = res(400, { error: "invalid or expired code" });
    render(<PeersCard />);
    await screen.findByText("No machines paired yet.");
    fireEvent.click(screen.getByTestId("peer-manual-toggle"));
    // A link that says Access is in front of the machine reveals the Access fields.
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: link("https://x.example.com", "ABCD1234", true) } });
    fireEvent.change(screen.getByLabelText("Access client id (optional)"), { target: { value: "id" } });
    await act(async () => { fireEvent.click(screen.getByTestId("peer-add")); });
    expect(screen.getByTestId("peer-add-error")).toHaveTextContent(/both/);
    expect(globalThis.fetch).not.toHaveBeenCalledWith("/api/peers", expect.objectContaining({ method: "POST" }));

    fireEvent.change(screen.getByLabelText("Access client secret (optional)"), { target: { value: "s3cret" } });
    await act(async () => { fireEvent.click(screen.getByTestId("peer-add")); });
    expect(await screen.findByTestId("peer-add-error")).toHaveTextContent("invalid or expired code");
    const body = JSON.parse(globalThis.fetch.mock.calls.find(([u, o]) => u === "/api/peers" && o?.method === "POST")[1].body);
    expect(body).toEqual({ url: "https://x.example.com", code: "ABCD1234", cf_client_id: "id", cf_client_secret: "s3cret" });
    // The secret and the code are never left in the form.
    expect(screen.getByLabelText("Access client secret (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Pairing code")).toHaveValue("");
  });

  it("pasting a pairing link fills the address and code and submits them", async () => {
    routes["GET /api/peers"] = res(200, { peers: [] });
    routes["POST /api/peers"] = res(200, { peer: { ...PEER, id: "p9" } });
    render(<PeersCard />);
    await screen.findByText("No machines paired yet.");
    // The fields only appear once there is something to show in them.
    expect(screen.queryByLabelText("Machine address")).toBeNull();
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: `  ${link("https://desk.example.com", "ZXCV5678")}\n` } });
    expect(screen.getByLabelText("Machine address")).toHaveValue("https://desk.example.com");
    expect(screen.getByLabelText("Pairing code")).toHaveValue("ZXCV5678");
    await act(async () => { fireEvent.click(screen.getByTestId("peer-add")); });
    const body = JSON.parse(globalThis.fetch.mock.calls.find(([u, o]) => u === "/api/peers" && o?.method === "POST")[1].body);
    expect(body).toEqual({ url: "https://desk.example.com", code: "ZXCV5678" });
  });

  it("shows the Access fields only for a link that says access, or after an Access failure", async () => {
    routes["GET /api/peers"] = res(200, { peers: [] });
    routes["POST /api/peers"] = res(400, { error: "Access refused", reason: "access_required" });
    render(<PeersCard />);
    await screen.findByText("No machines paired yet.");
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: link("https://a.example.com", "AAAA1111") } });
    expect(screen.queryByLabelText("Access client id (optional)")).toBeNull();
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: link("https://a.example.com", "AAAA1111", true) } });
    expect(screen.getByLabelText("Access client id (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Access client secret (optional)")).toBeInTheDocument();

    // And after a failure the link did not predict.
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: link("https://a.example.com", "AAAA1111") } });
    expect(screen.queryByLabelText("Access client id (optional)")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("peer-add")); });
    expect(await screen.findByLabelText("Access client id (optional)")).toBeInTheDocument();
  });

  it("the manual toggle reveals the address, code and label fields", async () => {
    routes["GET /api/peers"] = res(200, { peers: [] });
    render(<PeersCard />);
    await screen.findByText("No machines paired yet.");
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    fireEvent.click(screen.getByTestId("peer-manual-toggle"));
    expect(screen.getByLabelText("Machine address")).toBeInTheDocument();
    expect(screen.getByLabelText("Pairing code")).toBeInTheDocument();
    expect(screen.getByLabelText("Name for that machine")).toBeInTheDocument();
  });

  it("an unparseable paste shows the parse error inline", async () => {
    routes["GET /api/peers"] = res(200, { peers: [] });
    render(<PeersCard />);
    await screen.findByText("No machines paired yet.");
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: "not a link" } });
    expect(screen.getByTestId("peer-link-error")).toBeInTheDocument();
    expect(screen.queryByLabelText("Machine address")).toBeNull();
  });

  it("removes only after an in-app confirm, and awaits it", async () => {
    let peers = [PEER];
    routes["GET /api/peers"] = () => res(200, { peers });
    routes["GET /api/peers/p1/status"] = res(200, { reachable: true, authorized: true, reason: null });
    routes["DELETE /api/peers/p1"] = () => { peers = []; return res(200, { removed: true }); };
    render(<PeersCard />);
    fireEvent.click(await screen.findByTestId("peer-remove-p1"));
    expect(screen.getByTestId("peer-remove-confirm")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId("peer-remove-yes")); });
    await waitFor(() => expect(screen.queryByTestId("peer-row-p1")).toBeNull());
  });

  it("clears an Access token with nulls", async () => {
    routes["GET /api/peers"] = res(200, { peers: [{ ...PEER, access_token_set: true }] });
    routes["GET /api/peers/p1/status"] = res(200, { reachable: true, authorized: true, reason: null });
    routes["PUT /api/peers/p1/access"] = res(200, { peer: PEER });
    render(<PeersCard />);
    fireEvent.click(await screen.findByTestId("peer-access-p1"));
    await act(async () => { fireEvent.click(screen.getByTestId("peer-access-clear")); });
    const call = globalThis.fetch.mock.calls.find(([u, o]) => u === "/api/peers/p1/access" && o?.method === "PUT");
    expect(JSON.parse(call[1].body)).toEqual({ cf_client_id: null, cf_client_secret: null });
  });
});

describe("PeersCard: names", () => {
  it("the label field says the other machine's own name is used when blank", async () => {
    routes["GET /api/peers"] = res(200, { peers: [] });
    render(<PeersCard />);
    await screen.findByText("No machines paired yet.");
    fireEvent.click(screen.getByTestId("peer-manual-toggle"));
    expect(screen.getByPlaceholderText("Name for that machine (optional)")).toBeInTheDocument();
    expect(screen.getByTestId("peer-label-hint")).toHaveTextContent(/own name is used/);
  });

  it("renames inline, refreshes the list, and keeps the field open with the server error", async () => {
    let peers = [{ ...PEER }];
    routes["GET /api/peers"] = () => res(200, { peers });
    routes["GET /api/peers/p1/status"] = res(200, { reachable: true, authorized: true, reason: null });
    let answer = res(400, { error: "label too long" });
    let sent = null;
    routes["PUT /api/peers/p1"] = (opts) => { sent = JSON.parse(opts.body); return answer; };
    render(<PeersCard />);
    await screen.findByTestId("peer-row-p1");
    expect(screen.queryByTestId("peer-rename-input-p1")).toBeNull();
    fireEvent.click(screen.getByTestId("peer-rename-p1"));
    fireEvent.change(screen.getByTestId("peer-rename-input-p1"), { target: { value: "  Office  " } });
    fireEvent.click(screen.getByTestId("peer-rename-save-p1"));
    expect(await screen.findByText("label too long")).toBeInTheDocument();
    expect(screen.getByTestId("peer-rename-input-p1")).toBeInTheDocument();
    expect(sent).toEqual({ label: "Office" });
    peers = [{ ...PEER, label: "Office" }];
    answer = res(200, { peer: peers[0] });
    fireEvent.click(screen.getByTestId("peer-rename-save-p1"));
    await waitFor(() => expect(screen.queryByTestId("peer-rename-input-p1")).toBeNull());
    expect(await screen.findByText("Office")).toBeInTheDocument();
  });
});
