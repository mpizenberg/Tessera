/**
 * Transaction submission — the write side of the wallet seam.
 *
 * This is the only place evolution-sdk builds a transaction. The rest of the app
 * hands it a library-agnostic CIP-179 {@link Metadatum} payload (already encoded
 * by the pure `cip-179` codec) and gets back a transaction hash; evolution-sdk
 * never leaks past this module.
 *
 * Protocol parameters are the only ledger read a build needs: from the serving
 * tier (`GET /api/pparams`) when one is configured — so the browser needs no
 * Koios token at all — otherwise fetched from Koios directly during build.
 * Everything wallet-scoped goes through CIP-30, never Koios:
 * - **UTxOs + change address** come from the wallet (`getUtxos` / `getChangeAddress`)
 *   and are passed into the build, so no Koios `/address_info` round-trip.
 * - **Sign + submit** use the wallet (`signTx` → merge witnesses → `submitTx`),
 *   so the CORS-blocked Koios `/submittx` POST is never called.
 */

import {
  Address,
  AddressEras,
  Anchor,
  Assets,
  CBOR,
  Client,
  GovernanceAction,
  KeyHash,
  RewardAccount,
  Transaction,
  TransactionHash,
  TransactionInput,
  TransactionOutput,
  Url,
  UTxO,
  Value,
  mainnet,
  preview,
} from "@evolution-sdk/evolution";
import type { ProtocolParameters } from "@evolution-sdk/evolution/sdk/provider/Provider";
import { METADATA_LABEL, type Credential, type Metadatum } from "cip-179";

import { fromJsonSafe } from "cip-179/tally";

import { expectedNetworkId, type AppConfig } from "~/config";
import { toTxMetadatum } from "./cbor";
import { outrefKey, projectOutrefs, type PendingTx } from "./pending";
import type { Cip30Api } from "./types";

/**
 * Build config plus, optionally, the Tier-1 backend URL. When set, protocol
 * parameters are fetched from it (`/api/pparams`) and handed to the builder, so
 * building a transaction needs no Koios token; the tx is signed and submitted
 * through the CIP-30 wallet regardless.
 */
export interface SubmitConfig extends AppConfig {
  readonly indexerUrl?: string | undefined;
}

/** Full protocol parameters from the serving tier, decoded from the wire form. */
async function fetchBackendPParams(
  indexerUrl: string,
): Promise<ProtocolParameters> {
  const res = await fetch(`${indexerUrl}/api/pparams`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Indexer /api/pparams → ${res.status}`);
  return fromJsonSafe(await res.json()) as ProtocolParameters;
}

/**
 * Convert one CIP-30 UTxO (CBOR hex of `[transaction_input, transaction_output]`)
 * into evolution-sdk's `UTxO`, so coin selection can run on wallet-sourced UTxOs.
 *
 * Reference scripts are omitted: they are never required to *spend* a UTxO as an
 * input, and dropping them avoids a `ScriptRef → Script` conversion.
 */
function cip30UtxoToCore(hex: string): UTxO.UTxO {
  const decoded = CBOR.fromCBORHex(hex);
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new Error("unexpected CIP-30 UTxO CBOR shape");
  }
  const input = TransactionInput.fromCBORBytes(CBOR.toCBORBytes(decoded[0]));
  const output = TransactionOutput.fromCBORBytes(CBOR.toCBORBytes(decoded[1]));

  const amount = output.amount;
  const assets = Value.hasAssets(amount)
    ? Assets.withMultiAsset(amount.coin, amount.assets)
    : Assets.fromLovelace(amount.coin);

  // Babbage outputs carry `datumOption`, legacy Shelley outputs a `datumHash`;
  // both are valid DatumOption values for the UTxO model.
  const datumOption =
    "datumOption" in output
      ? output.datumOption
      : "datumHash" in output
        ? output.datumHash
        : undefined;

  return new UTxO.UTxO({
    transactionId: input.transactionId,
    index: input.index,
    // The output carries an era-tagged address (AddressEras); UTxO wants the
    // AddressStructure form. Round-trip through bytes to convert.
    address: Address.fromHex(AddressEras.toHex(output.address)),
    assets,
    datumOption,
    scriptRef: undefined,
  });
}

/**
 * Addresses whose outputs count as this wallet's when a pending transaction is
 * projected. Change always lands on `getChangeAddress`; the used-address list
 * covers a wallet that rotated it between two builds. A wallet that refuses to
 * enumerate them still gets its change projected.
 */
async function ownAddresses(
  api: Cip30Api,
  changeAddress: Address.Address,
): Promise<Set<string>> {
  const hexes = [Address.toHex(changeAddress)];
  try {
    for (const hex of (await api.getUsedAddresses()) ?? []) {
      hexes.push(Address.toHex(Address.fromHex(hex)));
    }
  } catch {
    // enumeration unsupported or refused — change address alone it is
  }
  return new Set(hexes);
}

/**
 * The wallet's UTxO set as it will look once every pending transaction lands:
 * the inputs they consume removed, the outputs they create at this wallet's
 * addresses added. Two submits in a row therefore cannot select the same input,
 * and a transaction can be funded from a predecessor's change before that
 * predecessor confirms — whether or not the wallet tracks its own mempool.
 */
function projectUtxos(
  walletUtxos: readonly UTxO.UTxO[],
  pending: readonly PendingTx[],
  own: ReadonlySet<string>,
): UTxO.UTxO[] {
  const produced = new Map<string, UTxO.UTxO>();
  const flows = pending.map((p) => {
    let body;
    try {
      ({ body } = Transaction.fromCBORHex(p.txCbor));
    } catch {
      // An entry we can't read projects nothing; the node still rejects a
      // double spend, so this degrades the guarantee rather than the ledger.
      console.warn(`pending tx ${p.txHash} is not decodable`);
      return { spent: [], produced: [] };
    }
    const spent = body.inputs.map((i) =>
      outrefKey(TransactionHash.toHex(i.transactionId), i.index),
    );
    const mine: string[] = [];
    body.outputs.forEach((out, index) => {
      if (!own.has(Address.toHex(out.address))) return;
      const key = outrefKey(p.txHash, index);
      mine.push(key);
      produced.set(
        key,
        new UTxO.UTxO({
          transactionId: TransactionHash.fromHex(p.txHash),
          index: BigInt(index),
          address: out.address,
          assets: out.assets,
          datumOption: out.datumOption,
          scriptRef: undefined,
        }),
      );
    });
    return { spent, produced: mine };
  });

  const { drop, add } = projectOutrefs(walletUtxos.map(utxoOutref), flows);
  return [
    ...walletUtxos.filter((u) => !drop.has(utxoOutref(u))),
    ...[...produced].filter(([key]) => add.has(key)).map(([, u]) => u),
  ];
}

const utxoOutref = (u: UTxO.UTxO): string =>
  outrefKey(TransactionHash.toHex(u.transactionId), u.index);

/**
 * Shared build context: an evolution-sdk client wired to Koios and the connected
 * wallet (CIP-30), plus the projected UTxO set and change address so the build
 * never round-trips Koios for `/address_info`. When a serving tier is configured,
 * protocol parameters come from it and are passed to `build()` — the build then
 * makes no Koios call at all (the redeemer-free flows here never trigger script
 * evaluation). Sign + submit still go through the wallet at the call site.
 *
 * The network is re-read from the wallet here, not taken from the identity read
 * at connect: switching networks inside a wallet doesn't necessarily invalidate
 * the handle, and every screen's mismatch gate compares that connect-time
 * snapshot. This is the last point before a transaction is built, so it is the
 * one check every submit path shares.
 */
async function txContext(
  config: SubmitConfig,
  api: Cip30Api,
  pending: readonly PendingTx[],
) {
  if ((await api.getNetworkId()) !== expectedNetworkId(config.network)) {
    throw new Error(
      `Wallet is on a different network than the app (${config.network}). Switch networks in your wallet.`,
    );
  }

  const chain = config.network === "mainnet" ? mainnet : preview;
  const reader = Client.make(chain).withKoios(
    config.koiosToken
      ? { baseUrl: config.koiosUrl, token: config.koiosToken }
      : { baseUrl: config.koiosUrl },
  );
  // Our retained CIP-30 handle is the full wallet API at runtime; the seam
  // narrows it to what we read, so widen it back to the SDK's WalletApi here.
  const client = reader.withCip30(
    api as unknown as Parameters<typeof reader.withCip30>[0],
  );
  const utxoHexes = (await api.getUtxos()) ?? [];
  const changeAddress = Address.fromHex(await api.getChangeAddress());
  const availableUtxos = projectUtxos(
    utxoHexes.map(cip30UtxoToCore),
    pending,
    await ownAddresses(api, changeAddress),
  );
  // Serving-tier pparams (no Koios token needed); without a backend, leave it
  // undefined and the provider fetches them from Koios during build as before.
  const fullProtocolParameters = config.indexerUrl
    ? await fetchBackendPParams(config.indexerUrl)
    : undefined;
  return { client, availableUtxos, changeAddress, fullProtocolParameters };
}

/**
 * `build()` options with protocol parameters injected only when we have them, so
 * the SDK skips its own Koios pparams fetch. Spread (rather than passing
 * `undefined`) to satisfy `exactOptionalPropertyTypes`.
 */
function buildOpts(ctx: Awaited<ReturnType<typeof txContext>>) {
  const { availableUtxos, changeAddress, fullProtocolParameters } = ctx;
  return {
    availableUtxos,
    changeAddress,
    ...(fullProtocolParameters ? { fullProtocolParameters } : {}),
  };
}

/**
 * A transaction the wallet accepted. The signed bytes are returned alongside the
 * hash because they are what the app projects the ledger from and what it
 * rebroadcasts if the transaction stalls — see `./pending.ts`.
 */
export interface SubmittedTx {
  readonly txHash: string;
  readonly txCbor: string;
}

/** Sign an unsigned tx with the wallet and submit it. */
async function signAndSubmit(
  api: Cip30Api,
  unsignedHex: string,
): Promise<SubmittedTx> {
  const witnessHex = await api.signTx(unsignedHex, true);
  const txCbor = Transaction.addVKeyWitnessesHex(unsignedHex, witnessHex);
  return { txHash: await api.submitTx(txCbor), txCbor };
}

/**
 * Submit a label-17 CIP-179 payload as a wallet-signed transaction.
 *
 * `proveCredentials` are the credentials this payload must prove control of
 * (CIP-179 credential proof, mechanism A): each key-based credential is added to
 * the transaction's `required_signers`, which forces the ledger to require — and
 * the wallet to produce — a signature witness for that key (e.g. a Stakeholder's
 * stake key, not just the payment key that funds the tx). Definitions /
 * cancellations pass the survey `owner`; responses pass the responder credential.
 */
export async function submitMetadataTx(
  config: SubmitConfig,
  api: Cip30Api,
  payload: Metadatum,
  proveCredentials: readonly Credential[],
  pending: readonly PendingTx[],
): Promise<SubmittedTx> {
  const ctx = await txContext(config, api, pending);
  const { client } = ctx;

  let tx = client.newTx().attachMetadata({
    label: BigInt(METADATA_LABEL),
    metadata: toTxMetadatum(payload),
  });
  for (const cred of proveCredentials) {
    if (cred.type !== "key") {
      // Native/Plutus-script credential proof needs script resolution (or a
      // governance-vote binding) that this in-browser path can't assemble yet.
      throw new Error(
        "Script-credential proof is not supported here yet — use a key-based credential.",
      );
    }
    tx = tx.addSigner({ keyHash: KeyHash.fromBytes(cred.keyHash) });
  }

  const built = await tx.build(buildOpts(ctx));

  // Sign + submit via the wallet (CIP-30), bypassing the provider's submit.
  const unsignedHex = Transaction.toCBORHex(await built.toTransaction());
  return signAndSubmit(api, unsignedHex);
}

/**
 * Submit a Conway governance **Info Action** proposal whose anchor points at the
 * given off-chain document (its URL + blake2b-256 hash). The refundable
 * `gov_action_deposit` is auto-fetched from protocol parameters and balanced
 * from the wallet's UTxOs; it is returned to the wallet's reward (stake) account
 * when the action is ratified or expires.
 *
 * An Info Action carries no on-chain effect — for CIP-179 it exists only to
 * advertise the survey referenced inside the anchor's `body.cip179`. The proposal
 * needs no extra witness beyond the wallet's payment key (which funds it), so no
 * `required_signers` are added.
 */
export async function submitInfoActionProposal(
  config: SubmitConfig,
  api: Cip30Api,
  anchorUrl: string,
  anchorDataHash: Uint8Array,
  pending: readonly PendingTx[],
): Promise<SubmittedTx> {
  const ctx = await txContext(config, api, pending);
  const { client } = ctx;

  const rewardHex = (await api.getRewardAddresses())?.[0];
  if (!rewardHex) {
    throw new Error(
      "Wallet exposes no reward (stake) address — a governance proposal needs one for the refundable deposit. Use a base-address (staking) wallet.",
    );
  }

  const tx = client.newTx().propose({
    governanceAction: new GovernanceAction.InfoAction({}),
    rewardAccount: RewardAccount.fromHex(rewardHex),
    anchor: new Anchor.Anchor({
      anchorUrl: new Url.Url({ href: anchorUrl }),
      anchorDataHash,
    }),
  });

  const built = await tx.build(buildOpts(ctx));
  const unsignedHex = Transaction.toCBORHex(await built.toTransaction());
  return signAndSubmit(api, unsignedHex);
}
