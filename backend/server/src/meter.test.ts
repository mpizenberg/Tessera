import { describe, expect, it } from "vitest";

import { upstreamMeter } from "./meter";
import { testStore } from "./testing/store";
import { tallyBucket } from "./store";

describe("upstreamMeter", () => {
  it("keeps the three budgets apart and drains them into one bucket", async () => {
    const store = testStore();
    const meter = upstreamMeter(store);
    const koios = meter.hook("koios");
    const anchor = meter.hook("anchor");
    koios();
    koios();
    anchor();
    meter.hook("koios-passthrough")();

    expect(meter.counted()).toEqual({
      koios: 2,
      "koios-passthrough": 1,
      anchor: 1,
    });
    await meter.drain(1_000_000);
    expect(await store.upstreamTotalsSince(0)).toEqual({
      koios: 2,
      "koios-passthrough": 1,
      anchor: 1,
    });
  });

  // The serving tier drains per request from a meter shared across requests, so
  // a drain that didn't reset would re-charge every earlier request's calls.
  it("resets on drain, so a second drain writes nothing", async () => {
    const store = testStore();
    const meter = upstreamMeter(store);
    meter.hook("koios")();
    await meter.drain(1_000_000);
    expect(meter.counted()).toEqual({
      koios: 0,
      "koios-passthrough": 0,
      anchor: 0,
    });

    await meter.drain(1_000_000 + 100_000);
    expect(await store.upstreamTotalsSince(0)).toMatchObject({ koios: 1 });
  });

  it("writes nothing at all when nothing was counted", async () => {
    let writes = 0;
    const meter = upstreamMeter({
      addUpstreamCalls: async () => {
        writes += 1;
      },
    });
    await meter.drain(tallyBucket(1_000_000));
    expect(writes).toBe(0);
  });
});
