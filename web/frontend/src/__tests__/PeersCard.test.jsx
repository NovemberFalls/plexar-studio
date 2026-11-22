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
    fireEvent.change(screen.getByLabelText("Machine address"), { target: { value: "https://x.example.com" } });
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "ABCD1234" } });
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
