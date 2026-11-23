import { describe, it, expect } from "vitest";
import { parsePairingLink } from "../utils/peers";

const payload = (o) => JSON.stringify(o);

describe("parsePairingLink", () => {
  it("accepts a link without access", () => {
    expect(parsePairingLink(payload({ v: 1, url: "https://s.example.com", code: "ABCD1234" }))).toEqual({
      ok: true,
      url: "https://s.example.com",
      code: "ABCD1234",
      access: false,
    });
  });

  it("accepts a link with access: true", () => {
    const r = parsePairingLink(payload({ v: 1, url: "https://s.example.com", code: "ABCD1234", access: true }));
    expect(r).toEqual({ ok: true, url: "https://s.example.com", code: "ABCD1234", access: true });
  });

  it("tolerates surrounding whitespace", () => {
    const r = parsePairingLink(`\n  ${payload({ v: 1, url: "https://s.example.com", code: "X1" })}  \t`);
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://s.example.com");
  });

  it.each([
    ["not JSON", "hello"],
    ["empty", ""],
    ["null", "null"],
    ["an array", "[1,2]"],
    ["a string", '"x"'],
    ["a wrong version", payload({ v: 2, url: "https://s", code: "C" })],
    ["a missing version", payload({ url: "https://s", code: "C" })],
    ["a missing url", payload({ v: 1, code: "C" })],
    ["a blank url", payload({ v: 1, url: "  ", code: "C" })],
    ["a non-string url", payload({ v: 1, url: 5, code: "C" })],
    ["a missing code", payload({ v: 1, url: "https://s" })],
    ["a blank code", payload({ v: 1, url: "https://s", code: "" })],
    ["a non-string code", payload({ v: 1, url: "https://s", code: {} })],
  ])("refuses %s with a plain-words error and never throws", (_name, text) => {
    const r = parsePairingLink(text);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  it("does not throw on non-string input", () => {
    expect(parsePairingLink(undefined).ok).toBe(false);
    expect(parsePairingLink(42).ok).toBe(false);
  });

  it("only treats access === true as access", () => {
    expect(parsePairingLink(payload({ v: 1, url: "https://s", code: "C", access: "yes" })).access).toBe(false);
  });
});
