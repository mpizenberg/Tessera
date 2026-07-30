import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANCHOR_MAX_BYTES,
  blake2b256,
  fetchAnchorBytes,
  fetchAnchorJson,
  IPFS_GATEWAYS,
} from "./anchor.js";

const DOC = new TextEncoder().encode('{"body":{"title":"hi"}}');
const DOC_HASH = blake2b256(DOC);

const anchor = (uri: string, hash = DOC_HASH) => ({ uri, hash });

/** Serve `bodies` per URL; anything unlisted 404s. */
function serve(bodies: Record<string, BodyInit | (() => Response)>): string[] {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      const body = bodies[url];
      if (body === undefined) return new Response("nope", { status: 404 });
      return typeof body === "function" ? body() : new Response(body);
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchAnchorBytes", () => {
  it("returns https bytes whose hash matches the anchor", async () => {
    serve({ "https://host/doc.json": DOC });
    expect(await fetchAnchorBytes(anchor("https://host/doc.json"))).toEqual(
      DOC,
    );
  });

  it("rejects bytes that don't hash to the anchor", async () => {
    serve({ "https://host/doc.json": new TextEncoder().encode("tampered") });
    await expect(
      fetchAnchorBytes(anchor("https://host/doc.json")),
    ).rejects.toThrow(/hash mismatch/);
  });

  // The URI is attacker-controllable on-chain data: the hash proves what the
  // bytes are, never that the URL is safe to dereference.
  it.each([
    "http://host/doc.json",
    "data:application/json,{}",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])("refuses to fetch %s", async (uri) => {
    const seen = serve({});
    await expect(fetchAnchorBytes(anchor(uri))).rejects.toThrow(
      /unsupported anchor URI scheme/,
    );
    expect(seen).toEqual([]);
  });

  it("caps the response size before hashing", async () => {
    const huge = new Uint8Array(64);
    serve({ "https://host/doc.json": huge });
    await expect(
      fetchAnchorBytes(anchor("https://host/doc.json"), { maxBytes: 32 }),
    ).rejects.toThrow(/exceeds 32 bytes/);
  });

  it("rejects on a declared content-length over the cap without reading", async () => {
    serve({
      "https://host/doc.json": () =>
        new Response(DOC, {
          headers: { "content-length": String(ANCHOR_MAX_BYTES + 1) },
        }),
    });
    await expect(
      fetchAnchorBytes(anchor("https://host/doc.json")),
    ).rejects.toThrow(/exceeds/);
  });

  it("gives up when the caller's signal aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = fetchAnchorBytes(anchor("https://host/doc.json"), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("counts every HTTP attempt it makes", async () => {
    serve({ "https://host/doc.json": DOC });
    const onRequest = vi.fn();
    await fetchAnchorBytes(anchor("https://host/doc.json"), { onRequest });
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});

describe("fetchAnchorBytes — ipfs gateway race", () => {
  it("takes the first gateway that returns matching bytes", async () => {
    const seen = serve({ [IPFS_GATEWAYS[0] + "cid"]: DOC });
    expect(await fetchAnchorBytes(anchor("ipfs://cid"))).toEqual(DOC);
    // The leading gateway answered before the staggered ones fired.
    expect(seen).toEqual([IPFS_GATEWAYS[0] + "cid"]);
  });

  it("falls through to a later gateway when the leader fails", async () => {
    const gateways = ["https://a/", "https://b/"];
    const seen = serve({ "https://b/cid": DOC });
    expect(
      await fetchAnchorBytes(anchor("ipfs://cid"), {
        gateways,
        staggerMs: 0,
      }),
    ).toEqual(DOC);
    expect(seen).toContain("https://b/cid");
  });

  // A gateway serving *something* for the CID is not a gateway serving the
  // anchored document; only the hash decides.
  it("ignores a gateway whose bytes don't verify", async () => {
    const gateways = ["https://a/", "https://b/"];
    serve({
      "https://a/cid": new TextEncoder().encode("wrong"),
      "https://b/cid": DOC,
    });
    expect(
      await fetchAnchorBytes(anchor("ipfs://cid"), { gateways, staggerMs: 0 }),
    ).toEqual(DOC);
  });

  it("fails when no gateway serves the document", async () => {
    serve({});
    await expect(
      fetchAnchorBytes(anchor("ipfs://cid"), {
        gateways: ["https://a/", "https://b/"],
        staggerMs: 0,
      }),
    ).rejects.toThrow(
      /no IPFS gateway returned a matching document \(tried 2\)/,
    );
  });
});

describe("fetchAnchorJson", () => {
  it("parses the verified bytes", async () => {
    serve({ "https://host/doc.json": DOC });
    expect(await fetchAnchorJson(anchor("https://host/doc.json"))).toEqual({
      body: { title: "hi" },
    });
  });

  it("propagates a verification failure rather than returning a doc", async () => {
    serve({ "https://host/doc.json": new TextEncoder().encode("{}") });
    await expect(
      fetchAnchorJson(anchor("https://host/doc.json")),
    ).rejects.toThrow(/hash mismatch/);
  });
});
