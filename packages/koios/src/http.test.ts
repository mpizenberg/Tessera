import { afterEach, describe, expect, it, vi } from "vitest";

import {
  koiosFetchJson,
  mapSettled,
  RETRY_BACKOFF_MS,
  type KoiosFetchOptions,
} from "./http";

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

/** An `Error` shaped like an `AbortSignal.timeout` rejection. */
const timeoutError = (): Error => {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
};

/** Sequence of fetch outcomes; each entry is a Response or a thrown error. */
function stubSequence(outcomes: (Response | Error)[]) {
  let i = 0;
  const mock = vi.fn(async () => {
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

// Finding 39 — one bounded retry with backoff absorbs a transient blip on the
// rate-limited Koios endpoints, so a single 429/gateway hiccup or timeout
// doesn't reject a whole scan; a persistent or deterministic failure still
// surfaces after exactly one extra attempt.
describe("koiosFetchJson — retry policy (finding 39)", () => {
  const sleep = vi.fn(async () => {});
  const onRequest = vi.fn();
  const opts = (): KoiosFetchOptions => ({ label: "/x", onRequest, sleep });

  afterEach(() => {
    sleep.mockClear();
    onRequest.mockClear();
  });

  it("retries once on 429 then returns the recovered body", async () => {
    const mock = stubSequence([json(429, {}), json(200, { ok: 1 })]);
    const out = await koiosFetchJson<{ ok: number }>("http://k/x", {}, opts());
    expect(out).toEqual({ ok: 1 });
    expect(mock).toHaveBeenCalledTimes(2);
    // A retry is a real subrequest, so it counts against the budget too.
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(RETRY_BACKOFF_MS);
  });

  it("retries once on a 503/504 gateway error then recovers", async () => {
    stubSequence([json(503, {}), json(200, { ok: 1 })]);
    expect(await koiosFetchJson("http://k/x", {}, opts())).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries a request timeout then recovers", async () => {
    const mock = stubSequence([timeoutError(), json(200, { ok: 1 })]);
    expect(await koiosFetchJson("http://k/x", {}, opts())).toEqual({ ok: 1 });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 500 (Koios surfaces deterministic db-sync errors as 500)", async () => {
    const mock = stubSequence([json(500, {}), json(200, { ok: 1 })]);
    await expect(koiosFetchJson("http://k/x", {}, opts())).rejects.toThrow(
      "Koios GET /x → 500",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry a 4xx client error", async () => {
    const mock = stubSequence([json(400, {})]);
    await expect(koiosFetchJson("http://k/x", {}, opts())).rejects.toThrow(
      "Koios GET /x → 400",
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-timeout throw (a network refusal, a bug)", async () => {
    const mock = stubSequence([new Error("boom")]);
    await expect(koiosFetchJson("http://k/x", {}, opts())).rejects.toThrow(
      "boom",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after exactly one retry when the failure persists", async () => {
    const mock = stubSequence([json(429, {}), json(429, {})]);
    await expect(koiosFetchJson("http://k/x", {}, opts())).rejects.toThrow(
      "Koios GET /x → 429",
    );
    expect(mock).toHaveBeenCalledTimes(2); // original + one retry, then stop
  });

  it("labels the error with the method and path, not the full URL", async () => {
    stubSequence([json(400, {})]);
    await expect(
      koiosFetchJson(
        "http://koios.test/api/v1/tip",
        { method: "POST" },
        { label: "/tip" },
      ),
    ).rejects.toThrow("Koios POST /tip → 400");
  });
});

// The batch fan-out throttles to a fixed number of in-flight requests without
// losing the per-item settle semantics `fetchAll` relies on (finding 39).
describe("mapSettled", () => {
  it("caps concurrency yet processes every item, in order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapSettled(items, 6, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBeGreaterThan(1); // genuinely parallel, just capped
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(
      items.map((n) => n * 2),
    );
  });

  it("isolates a thrown item as `rejected`, keeping the rest fulfilled", async () => {
    const out = await mapSettled([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("no");
      return n;
    });
    expect(out.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  });
});
