import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evolutionCodec } from "cip-179/evolution";
import { decodeResolvedNativeScript } from "cip-179/txproof";
import { describe, expect, it } from "vitest";

import { AmaruChain } from "./chain";
import { AmaruStores } from "./stores";

// The preview DRep vote tx f3dbbed5…: KEYHASH in required_signers, no script
// witnessed; a sig script over KEYHASH is therefore satisfied by it.
const TX = "f3dbbed5146f3481bf3a14bd1ded73c3a757f94e9f2c35be313791b7796e7f67";
const TX_CBOR =
  "84a600d9010281825820128d8098467043c6ba9d84d5360782ec3841084625afde5e0d7fdf7e" +
  "e951526300018182583900ad63500e30fae29cb2961f48b83360743abcd331aed01b9d3ec8f4" +
  "db4f467a090e6903ed92b585afd0a6932526a0eb1df314a4a3ce6be4001b00000001fa4a21f0" +
  "021a0002ab71031a06e621970ed9010281581cd16978b7f8052ad3383bee5930d37ec05fe483" +
  "ff4477d50df3585c5713a18202581cd16978b7f8052ad3383bee5930d37ec05fe483ff4477d5" +
  "0df3585c57a1825820178a410703c9a88d38acc8e7e00217722f98e697c826ebd105e0c5beaf" +
  "32e00f008200f6a100d90102828258201a0ca31c60a58eb30a18c463acf6bc670105655fa686" +
  "bbacce6f17f252f3646b58407b577b96203cc9bda779a10c61911fa609bf3196262ed4a5687c" +
  "54ab14076623b48648152f53d211a63c2b6db17c8fb13eb9d3e7de3af86713c0ef03a1320c0c" +
  "8258201f6479010c6a232da09c690550adf5740887de895ca4ffd446720915a165b1df58403e" +
  "ff09e7737a63c59eda414eff7105679f0da90574776ae16bd99abf1b0195e4633c6314f24dd2" +
  "802b7bfff954158719eee04cd609c638c1affda54bafbcbf08f5f6";
const KEYHASH = "d16978b7f8052ad3383bee5930d37ec05fe483ff4477d50df3585c57";
const SIG_SCRIPT = decodeResolvedNativeScript(
  evolutionCodec,
  `8200581c${KEYHASH}`,
)!;

function stores(): AmaruStores {
  const dir = mkdtempSync(join(tmpdir(), "amaru-"));
  writeFileSync(
    join(dir, "blocks.json"),
    JSON.stringify({
      from: 0,
      to: 1,
      tip: { slot: 1, epoch: 0, epoch_slot: 1, time: 0 },
      transactions: [
        { hash: TX, slot: 1, epoch: 0, index: 0, cbor: TX_CBOR, metadata: "" },
      ],
    }),
  );
  return new AmaruStores(dir);
}

const needed = new Map([[TX, [SIG_SCRIPT.scriptHash]]]);

describe("AmaruChain.txProofs", () => {
  it("proves with a script the lookup finds and the transaction does not witness", async () => {
    const chain = new AmaruChain(stores(), "preview", async (missing) => {
      expect([...missing]).toEqual([[TX, [SIG_SCRIPT.scriptHash]]]);
      return new Map([
        [TX, new Map([[SIG_SCRIPT.scriptHash, SIG_SCRIPT.script]])],
      ]);
    });
    const proof = (await chain.txProofs([TX], needed)).get(TX);
    expect(proof?.nativeScripts).toEqual([
      { scriptHash: SIG_SCRIPT.scriptHash, script: SIG_SCRIPT.script },
    ]);
  });

  it("keeps the proof without the script when there is no lookup", async () => {
    const chain = new AmaruChain(stores(), "preview");
    const proof = (await chain.txProofs([TX], needed)).get(TX);
    expect(proof?.requiredSigners).toEqual([KEYHASH]);
    expect(proof?.nativeScripts).toEqual([]);
  });

  it("leaves the proof unknown when the lookup could not ask", async () => {
    const chain = new AmaruChain(
      stores(),
      "preview",
      async (missing) => new Map([...missing.keys()].map((tx) => [tx, null])),
    );
    expect((await chain.txProofs([TX], needed)).get(TX)).toBeNull();
  });
});
