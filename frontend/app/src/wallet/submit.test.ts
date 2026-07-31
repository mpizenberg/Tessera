import { describe, expect, test } from "vitest";

import {
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

/** An unsigned transaction declaring `required` as its signers. */
function built([first, ...rest]: readonly [string, ...string[]]): BuiltTx {
  const required = [first, ...rest];
  const tx = new Transaction.Transaction({
    body: new TransactionBody.TransactionBody({
      inputs: [
        new TransactionInput.TransactionInput({
          transactionId: TransactionHash.fromHex(TX_A),
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
    txHash: TX_A,
    txCbor: Transaction.toCBORHex(tx),
    required,
    missing: required,
  };
}

/** One call a wallet was asked to make, in the order it was asked. */
interface Call {
  readonly kind: "sign" | "submit";
  readonly txCbor: string;
}

/** A wallet answering each prompt in turn, the last answer standing for the rest. */
function wallet(...answers: (string | Error)[]): {
  api: Cip30Api;
  calls: Call[];
} {
  const calls: Call[] = [];
  const api = {
    signTx: async (txCbor: string) => {
      calls.push({ kind: "sign", txCbor });
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    submitTx: async (txCbor: string) => {
      calls.push({ kind: "submit", txCbor });
      return TX_A;
    },
  } as unknown as Cip30Api;
  return { api, calls };
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

    expect(w.calls[1]!.txCbor).toBe(sent[0]!.txCbor);
    expect(w.calls[1]!.txCbor).not.toBe(w.calls[0]!.txCbor);
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
