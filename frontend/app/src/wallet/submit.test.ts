import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CBOR,
  Ed25519Signature,
  KeyHash,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionInput,
  TransactionWitnessSet,
  VKey,
} from "@evolution-sdk/evolution";
import { hexToBytes } from "cip-179/domain";

import type { Action } from "./action";
import type { PlannedTx } from "./plan";
import { signAndSubmitChain, type BuiltTx } from "./submit";
import type { Cip30Api } from "./types";

const TX_A = "aa".repeat(32);
const TX_B = "bb".repeat(32);
const TX_C = "cc".repeat(32);

/** A public key and the hash a witness by it is recognized under. */
function signer(fill: number): { vkey: VKey.VKey; hashHex: string } {
  const vkey = VKey.fromBytes(new Uint8Array(32).fill(fill));
  return { vkey, hashHex: KeyHash.toHex(KeyHash.fromVKey(vkey)) };
}

/** The witness set a wallet returns from `signTx`, as CIP-30 hands it back. */
function witnessSetHex(...vkeys: VKey.VKey[]): string {
  return TransactionWitnessSet.toCBORHex(
    TransactionWitnessSet.fromVKeyWitnesses(
      vkeys.map(
        (vkey) =>
          new TransactionWitnessSet.VKeyWitness({
            vkey,
            signature: Ed25519Signature.fromBytes(new Uint8Array(64).fill(7)),
          }),
      ),
    ),
  );
}

const cancel: Action = {
  kind: "cancel",
  cancellation: { txId: hexToBytes(TX_A), index: 0 },
  proveCredentials: [],
};

const planned: PlannedTx = {
  body: {
    type: "metadata",
    payload: { type: "cancellations", cancellations: [cancel.cancellation] },
  },
  actions: [cancel],
  proveCredentials: [],
  dependsOn: [],
};

/**
 * An unsigned transaction declaring `required` as its signers, spending
 * `spends#0` and known by `hash`. Both default to the same made-up transaction,
 * so nothing is spent that the chain did not produce itself.
 */
function built(
  [first, ...rest]: readonly [string, ...string[]],
  spends: string = TX_A,
  hash: string = TX_A,
): BuiltTx {
  const required = [first, ...rest];
  const tx = new Transaction.Transaction({
    body: new TransactionBody.TransactionBody({
      inputs: [
        new TransactionInput.TransactionInput({
          transactionId: TransactionHash.fromHex(spends),
          index: 0n,
        }),
      ],
      outputs: [],
      fee: 200_000n,
      requiredSigners: [
        KeyHash.fromHex(first),
        ...rest.map((hex) => KeyHash.fromHex(hex)),
      ],
    }),
    witnessSet: new TransactionWitnessSet.TransactionWitnessSet({}),
    isValid: true,
    auxiliaryData: null,
  });
  return {
    planned,
    txHash: hash,
    txCbor: Transaction.toCBORHex(tx),
    required,
    missing: required,
  };
}

/** A wallet UTxO as CIP-30 hands it over; nothing reads the output half. */
function utxoHex(txHash: string, index: number): string {
  const input = new TransactionInput.TransactionInput({
    transactionId: TransactionHash.fromHex(txHash),
    index: BigInt(index),
  });
  return CBOR.toCBORHex([
    CBOR.fromCBORBytes(TransactionInput.toCBORBytes(input)),
    0,
  ]);
}

/** One call a wallet was asked to make, in the order it was asked. */
interface Call {
  readonly kind: "sign" | "bulk" | "submit" | "bulkSubmit";
  /** The transactions the call carried. */
  readonly txs: readonly string[];
}

/**
 * A wallet answering each prompt in turn, the last answer standing for the rest.
 * A string is a witness set; anything else is what the prompt throws — CIP-30
 * wallets throw loose `{code, info}` objects as readily as `Error`s.
 */
function wallet(...answers: unknown[]): {
  api: Cip30Api;
  calls: Call[];
} {
  const calls: Call[] = [];
  const api = {
    signTx: async (txCbor: string) => {
      calls.push({ kind: "sign", txs: [txCbor] });
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (typeof answer !== "string") throw answer;
      return answer;
    },
    submitTx: async (txCbor: string) => {
      calls.push({ kind: "submit", txs: [txCbor] });
      return TX_A;
    },
  } as unknown as Cip30Api;
  return { api, calls };
}

/**
 * The same wallet, with CIP-103: `sign` answers the one signing prompt, `submit`
 * the one broadcast (it succeeds unless given something to throw), and `perTx`
 * whatever it falls back to answering one at a time.
 */
function bulkWallet(
  { sign, submit }: { sign: unknown; submit?: unknown },
  ...perTx: unknown[]
): { api: Cip30Api; calls: Call[] } {
  const { api, calls } = wallet(...perTx);
  return {
    api: {
      ...api,
      cip103: {
        signTxs: async (txs: readonly { cbor: string }[]) => {
          calls.push({ kind: "bulk", txs: txs.map((t) => t.cbor) });
          if (Array.isArray(sign)) return sign as string[];
          throw sign;
        },
        submitTxs: async (txs: readonly string[]) => {
          calls.push({ kind: "bulkSubmit", txs });
          if (submit !== undefined) throw submit;
          return txs.map(() => TX_A);
        },
      },
    } as unknown as Cip30Api,
    calls,
  };
}

/** A round, with `sent` collecting what went out in the order it did. */
async function publish(
  api: Cip30Api,
  built: readonly BuiltTx[],
): Promise<{
  txs: readonly BuiltTx[];
  error: string | null;
  sent: BuiltTx[];
}> {
  const sent: BuiltTx[] = [];
  const { txs, error } = await signAndSubmitChain(api, built, (tx) =>
    sent.push(tx),
  );
  return { txs, error, sent };
}

describe("gathering signatures", () => {
  test("a witness clears the signature its transaction waited for", async () => {
    const alice = signer(3);
    const { txs, error, sent } = await publish(
      wallet(witnessSetHex(alice.vkey)).api,
      [built([alice.hashHex])],
    );

    expect(error).toBe(null);
    expect(sent[0]!.missing).toEqual([]);
    expect(txs).toEqual([]);
  });

  test("a wallet holding none of the keys leaves them all waiting", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const { txs, sent } = await publish(wallet(witnessSetHex(bob.vkey)).api, [
      built([alice.hashHex]),
    ]);

    expect(txs[0]!.missing).toEqual([alice.hashHex]);
    expect(sent).toEqual([]);
  });

  test("one wallet after another completes what neither could alone", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const first = await publish(wallet(witnessSetHex(alice.vkey)).api, [
      built([alice.hashHex, bob.hashHex]),
    ]);
    expect(first.txs[0]!.missing).toEqual([bob.hashHex]);

    // Bob signs the transaction as Alice left it — witnesses accumulate.
    const second = await publish(
      wallet(witnessSetHex(bob.vkey)).api,
      first.txs,
    );
    expect(second.txs).toEqual([]);
    expect(second.sent[0]!.missing).toEqual([]);
  });

  test("a transaction already witnessed is published without a prompt", async () => {
    const alice = signer(3);
    const w = wallet(witnessSetHex(alice.vkey));
    await publish(w.api, [{ ...built([alice.hashHex]), missing: [] }]);

    expect(w.calls.map((c) => c.kind)).toEqual(["submit"]);
  });

  test("a refusal reports itself and keeps what the round hadn't sent", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const { txs, error, sent } = await publish(
      wallet(witnessSetHex(alice.vkey), new Error("declined")).api,
      [built([alice.hashHex]), built([bob.hashHex])],
    );

    expect(error).toBe("declined");
    expect(sent).toHaveLength(1);
    expect(txs[0]!.missing).toEqual([bob.hashHex]);
  });
});

describe("publishing a chain", () => {
  test("each transaction goes out before the next is offered", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const w = wallet(witnessSetHex(alice.vkey), witnessSetHex(bob.vkey));
    const { txs, sent } = await publish(w.api, [
      built([alice.hashHex]),
      built([bob.hashHex]),
    ]);

    expect(w.calls.map((c) => c.kind)).toEqual([
      "sign",
      "submit",
      "sign",
      "submit",
    ]);
    expect(sent).toHaveLength(2);
    expect(txs).toEqual([]);
  });

  test("what the wallet signs is what it is asked to broadcast", async () => {
    const alice = signer(3);
    const w = wallet(witnessSetHex(alice.vkey));
    const { sent } = await publish(w.api, [built([alice.hashHex])]);

    expect(w.calls[1]!.txs).toEqual([sent[0]!.txCbor]);
    expect(w.calls[1]!.txs).not.toEqual(w.calls[0]!.txs);
  });

  test("a transaction another wallet owes holds back the chain behind it", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const w = wallet(witnessSetHex(alice.vkey));
    const { txs, error, sent } = await publish(w.api, [
      built([bob.hashHex]),
      built([alice.hashHex]),
    ]);

    expect(error).toBe(null);
    expect(sent).toEqual([]);
    expect(txs).toHaveLength(2);
    expect(w.calls.map((c) => c.kind)).toEqual(["sign"]);
  });

  test("a broadcast the node refuses keeps its transaction and the rest", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const w = wallet(witnessSetHex(alice.vkey), witnessSetHex(bob.vkey));
    const api = {
      ...w.api,
      submitTx: async () => {
        throw new Error("mempool full");
      },
    } as unknown as Cip30Api;
    const { txs, error, sent } = await publish(api, [
      built([alice.hashHex]),
      built([bob.hashHex]),
    ]);

    expect(error).toBe("mempool full");
    expect(sent).toEqual([]);
    expect(txs).toHaveLength(2);
    expect(txs[0]!.missing).toEqual([]); // signed, just not out
  });
});

describe("signing a chain in bulk", () => {
  const alice = signer(3);
  const bob = signer(4);
  const chain = () => [built([alice.hashHex]), built([bob.hashHex])];

  // Falling back to one prompt per transaction warns; that is not the subject.
  beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  test("the whole chain is one prompt, and each witness finds its own", async () => {
    const w = bulkWallet({
      sign: [witnessSetHex(alice.vkey), witnessSetHex(bob.vkey)],
    });
    const { txs, error, sent } = await publish(w.api, chain());

    expect(error).toBe(null);
    expect(txs).toEqual([]);
    expect(sent.map((tx) => tx.missing)).toEqual([[], []]);
    expect(w.calls.map((c) => c.kind)).toEqual(["bulk", "bulkSubmit"]);
  });

  test("what the wallet already witnessed is left out of the prompt", async () => {
    const carol = signer(5);
    const w = bulkWallet({
      sign: [witnessSetHex(alice.vkey), witnessSetHex(bob.vkey)],
    });
    const [first, second] = chain();
    await publish(w.api, [
      { ...built([carol.hashHex]), missing: [] },
      first!,
      second!,
    ]);

    expect(w.calls[0]!.txs).toEqual([first!.txCbor, second!.txCbor]);
  });

  test("one outstanding transaction is not worth a bulk prompt", async () => {
    const w = bulkWallet(
      { sign: new Error("unused") },
      witnessSetHex(alice.vkey),
    );
    await publish(w.api, [built([alice.hashHex])]);

    expect(w.calls.map((c) => c.kind)).toEqual(["sign", "submit"]);
  });

  test("a wallet that cannot deliver is asked one transaction at a time", async () => {
    const w = bulkWallet(
      { sign: new Error("not implemented") },
      witnessSetHex(alice.vkey),
      witnessSetHex(bob.vkey),
    );
    const { txs, error } = await publish(w.api, chain());

    expect(error).toBe(null);
    expect(txs).toEqual([]);
    expect(w.calls.map((c) => c.kind)).toEqual([
      "bulk",
      "sign",
      "submit",
      "sign",
      "submit",
    ]);
  });

  test("a short answer is not trusted to line up with the chain", async () => {
    const w = bulkWallet(
      { sign: [witnessSetHex(alice.vkey)] },
      witnessSetHex(alice.vkey),
      witnessSetHex(bob.vkey),
    );
    const { error, sent } = await publish(w.api, chain());

    expect(error).toBe(null);
    expect(sent).toHaveLength(2);
    expect(w.calls.map((c) => c.kind)).toEqual([
      "bulk",
      "sign",
      "submit",
      "sign",
      "submit",
    ]);
  });

  test("a declined prompt ends the round without asking again", async () => {
    const w = bulkWallet({ sign: { code: 2, info: "user declined" } });
    const { txs, error, sent } = await publish(w.api, chain());

    expect(error).toContain("declined");
    expect(sent).toEqual([]);
    expect(txs).toHaveLength(2);
    expect(w.calls.map((c) => c.kind)).toEqual(["bulk"]);
  });
});

describe("broadcasting a chain in bulk", () => {
  const alice = signer(3);
  const bob = signer(4);
  const witnessed = { sign: [] as string[] };
  const chain = () => [
    { ...built([alice.hashHex]), missing: [] },
    { ...built([bob.hashHex]), missing: [] },
  ];

  test("a chain witnessed in one prompt goes out in one call", async () => {
    const w = bulkWallet(witnessed);
    const { txs, error, sent } = await publish(w.api, chain());

    expect(error).toBe(null);
    expect(txs).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(w.calls.map((c) => c.kind)).toEqual(["bulkSubmit"]);
  });

  test("a transaction another wallet owes keeps the chain off the call", async () => {
    const carol = signer(5);
    const w = bulkWallet(
      { sign: [], submit: undefined },
      witnessSetHex(alice.vkey),
    );
    const [first] = chain();
    const { txs, sent } = await publish(w.api, [
      first!,
      built([carol.hashHex]),
    ]);

    expect(sent).toHaveLength(1);
    expect(txs).toHaveLength(1);
    expect(w.calls.map((c) => c.kind)).toEqual(["submit", "sign"]);
  });

  test("what a partial failure did broadcast is not offered again", async () => {
    const w = bulkWallet({
      sign: [],
      submit: [TX_A, { code: 2, info: "node said no" }],
    });
    const [first, second] = chain();
    const { txs, error, sent } = await publish(w.api, [first!, second!]);

    expect(error).toBe("node said no");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.txCbor).toBe(first!.txCbor);
    expect(txs.map((tx) => tx.txCbor)).toEqual([second!.txCbor]);
  });

  test("a failure that names nothing leaves the whole chain resubmittable", async () => {
    const w = bulkWallet({ sign: [], submit: new Error("wallet offline") });
    const { txs, error, sent } = await publish(w.api, chain());

    expect(error).toBe("wallet offline");
    expect(sent).toEqual([]);
    expect(txs).toHaveLength(2);
  });

  test("a wallet with no bulk broadcast sends them one after another", async () => {
    const w = bulkWallet(witnessed);
    const api = {
      ...w.api,
      cip103: { signTxs: () => {} },
    } as unknown as Cip30Api;
    const { sent } = await publish(api, chain());

    expect(sent).toHaveLength(2);
    expect(w.calls.map((c) => c.kind)).toEqual(["submit", "submit"]);
  });
});

describe("waiting for the wallet to catch up", () => {
  const alice = signer(3);

  /** A wallet listing `utxos[n]` on its nth poll, the last answer standing. */
  function slowWallet(
    utxos: string[][],
    ...answers: unknown[]
  ): { api: Cip30Api; calls: Call[]; polls: () => number } {
    const w = wallet(...answers);
    let polls = 0;
    return {
      api: {
        ...w.api,
        getUtxos: async () => utxos[Math.min(polls++, utxos.length - 1)],
      } as unknown as Cip30Api,
      calls: w.calls,
      polls: () => polls,
    };
  }

  afterEach(() => vi.useRealTimers());

  test("an input the wallet already holds is not waited for", async () => {
    const w = slowWallet([[utxoHex(TX_B, 0)]], witnessSetHex(alice.vkey));
    const { sent } = await publish(w.api, [built([alice.hashHex], TX_B)]);

    expect(sent).toHaveLength(1);
    expect(w.polls()).toBe(1);
  });

  test("the wallet is asked again until it holds it", async () => {
    vi.useFakeTimers();
    const w = slowWallet(
      [[], [], [utxoHex(TX_B, 0)]],
      witnessSetHex(alice.vkey),
    );
    const round = publish(w.api, [built([alice.hashHex], TX_B)]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await round).sent).toHaveLength(1);
    expect(w.polls()).toBe(3);
    expect(w.calls.map((c) => c.kind)).toEqual(["sign", "submit"]);
  });

  test("one that never does is asked to sign anyway, and says which it lacks", async () => {
    vi.useFakeTimers();
    const w = slowWallet(
      [[]],
      new Error("txCborInvalid;Could not resolve transaction input UTxOs"),
    );
    const round = publish(w.api, [built([alice.hashHex], TX_B)]);
    await vi.advanceTimersByTimeAsync(10_000);
    const { error, txs } = await round;

    expect(error).toContain(TX_B);
    expect(error).not.toContain("txCborInvalid");
    expect(txs).toHaveLength(1);
    expect(w.calls.map((c) => c.kind)).toEqual(["sign"]);
  });

  test("a wallet slow to answer gets the same deadline, not the same count", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const w = wallet(new Error("could not resolve"));
    const api = {
      ...w.api,
      getUtxos: async () => {
        polls++;
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return [];
      },
    } as unknown as Cip30Api;
    const round = publish(api, [built([alice.hashHex], TX_B)]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect((await round).error).toContain(TX_B);
    expect(polls).toBe(3); // ~10 s of four-second answers, not 21 of them
  });

  test("a decline is still a decline, however far behind the wallet is", async () => {
    vi.useFakeTimers();
    const w = slowWallet([[]], { code: 2, info: "user declined" });
    const round = publish(w.api, [built([alice.hashHex], TX_B)]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await round).error).toBe("user declined");
  });

  test("a wallet that will not enumerate its UTxOs is asked straight away", async () => {
    const w = slowWallet([], witnessSetHex(alice.vkey));
    const { sent } = await publish(w.api, [built([alice.hashHex], TX_B)]);

    expect(sent).toHaveLength(1);
    expect(w.polls()).toBe(1);
  });

  test("what the chain produces for itself is nobody else's to hold", async () => {
    const bob = signer(4);
    let polls = 0;
    const bulk = bulkWallet({
      sign: [witnessSetHex(alice.vkey), witnessSetHex(bob.vkey)],
    });
    const api = {
      ...bulk.api,
      getUtxos: async () => {
        polls++;
        return [utxoHex(TX_B, 0)];
      },
    } as unknown as Cip30Api;
    const { sent } = await publish(api, [
      built([alice.hashHex], TX_B, TX_C),
      built([bob.hashHex], TX_C, TX_A),
    ]);

    expect(sent).toHaveLength(2);
    expect(polls).toBe(1); // TX_C#0 is the chain's own, and not waited for
  });
});
