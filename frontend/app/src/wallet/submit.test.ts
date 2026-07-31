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
import { signChain, type BuiltTx } from "./submit";
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

/** A wallet answering each prompt in turn, the last answer standing for the rest. */
function wallet(...answers: (string | Error)[]): {
  api: Cip30Api;
  prompted: string[];
} {
  const prompted: string[] = [];
  const api = {
    signTx: async (txCbor: string) => {
      prompted.push(txCbor);
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as Cip30Api;
  return { api, prompted };
}

describe("gathering signatures", () => {
  test("a witness clears the signature its transaction waited for", async () => {
    const alice = signer(3);
    const { txs, error } = await signChain(
      wallet(witnessSetHex(alice.vkey)).api,
      [built([alice.hashHex])],
    );

    expect(error).toBe(null);
    expect(txs[0]!.missing).toEqual([]);
  });

  test("a wallet holding none of the keys leaves them all waiting", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const { txs } = await signChain(wallet(witnessSetHex(bob.vkey)).api, [
      built([alice.hashHex]),
    ]);

    expect(txs[0]!.missing).toEqual([alice.hashHex]);
  });

  test("one wallet after another completes what neither could alone", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const first = await signChain(wallet(witnessSetHex(alice.vkey)).api, [
      built([alice.hashHex, bob.hashHex]),
    ]);
    expect(first.txs[0]!.missing).toEqual([bob.hashHex]);

    // Bob signs the transaction as Alice left it — witnesses accumulate.
    const second = await signChain(
      wallet(witnessSetHex(bob.vkey)).api,
      first.txs,
    );
    expect(second.txs[0]!.missing).toEqual([]);
  });

  test("a transaction already witnessed is not offered again", async () => {
    const alice = signer(3);
    const w = wallet(witnessSetHex(alice.vkey));
    await signChain(w.api, [{ ...built([alice.hashHex]), missing: [] }]);

    expect(w.prompted).toEqual([]);
  });

  test("a refusal reports itself and keeps what the round already gathered", async () => {
    const alice = signer(3);
    const bob = signer(4);
    const { txs, error } = await signChain(
      wallet(witnessSetHex(alice.vkey), new Error("declined")).api,
      [built([alice.hashHex]), built([bob.hashHex])],
    );

    expect(error).toBe("declined");
    expect(txs[0]!.missing).toEqual([]);
    expect(txs[1]!.missing).toEqual([bob.hashHex]);
  });
});
