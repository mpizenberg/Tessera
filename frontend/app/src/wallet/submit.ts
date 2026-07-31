/**
 * Transaction submission — the write side of the wallet seam.
 *
 * This is the only place evolution-sdk builds a transaction. The rest of the app
 * hands it a {@link PlannedTx} chain — library-agnostic CIP-179 domain payloads,
 * partitioned by the pure planner — and gets back the bytes; evolution-sdk never
 * leaks past this module.
 *
 * Building is separate from publishing because a transaction may need witnesses
 * from wallets that cannot be connected at the same time: {@link buildChain}
 * once, {@link signAndSubmitChain} once per wallet as the user connects them,
 * each round publishing every transaction it managed to complete.
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
  TransactionBody,
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
import { METADATA_LABEL, encodePayload, type Cip179Payload } from "cip-179";

import { hexToBytes } from "cip-179/domain";
import { fromJsonSafe } from "cip-179/tally";

import { expectedNetworkId, type AppConfig } from "~/config";
import { metadatumToCbor, toTxMetadatum } from "./cbor";
import { isRefusal } from "./cip30";
import type { PlannedTx } from "./plan";
import {
  descendantOutrefs,
  outrefKey,
  projectOutrefs,
  type TxFlow,
} from "./pending";
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

/** The two halves of a CIP-30 UTxO: `[transaction_input, transaction_output]`. */
function cip30UtxoParts(hex: string): {
  readonly input: Uint8Array;
  readonly output: Uint8Array;
} {
  const decoded = CBOR.fromCBORHex(hex);
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new Error("unexpected CIP-30 UTxO CBOR shape");
  }
  return {
    input: CBOR.toCBORBytes(decoded[0]),
    output: CBOR.toCBORBytes(decoded[1]),
  };
}

/** Which output a CIP-30 UTxO is, without decoding the output itself. */
function cip30Outref(hex: string): string {
  const { transactionId, index } = TransactionInput.fromCBORBytes(
    cip30UtxoParts(hex).input,
  );
  return outrefKey(TransactionHash.toHex(transactionId), index);
}

/**
 * Convert one CIP-30 UTxO into evolution-sdk's `UTxO`, so coin selection can run
 * on wallet-sourced UTxOs.
 *
 * Reference scripts are omitted: they are never required to *spend* a UTxO as an
 * input, and dropping them avoids a `ScriptRef → Script` conversion.
 */
function cip30UtxoToCore(hex: string): UTxO.UTxO {
  const parts = cip30UtxoParts(hex);
  const input = TransactionInput.fromCBORBytes(parts.input);
  const output = TransactionOutput.fromCBORBytes(parts.output);

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
 * The wallet's UTxO set as it will look once every in-flight transaction lands:
 * the inputs they consume removed, the outputs they create at this wallet's
 * addresses added. Two submits in a row therefore cannot select the same input,
 * and a transaction can be funded from a predecessor's change before that
 * predecessor confirms — whether or not the wallet tracks its own mempool.
 *
 * The flows come back alongside, because tying a transaction to one it depends
 * on means finding an output that exists only if that one was included.
 */
function project(
  walletUtxos: readonly UTxO.UTxO[],
  inFlight: readonly TxBytes[],
  own: ReadonlySet<string>,
): { readonly utxos: UTxO.UTxO[]; readonly flows: readonly TxFlow[] } {
  const produced = new Map<string, UTxO.UTxO>();
  const flows = inFlight.map((p): TxFlow => {
    let body;
    try {
      ({ body } = Transaction.fromCBORHex(p.txCbor));
    } catch {
      // An entry we can't read projects nothing; the node still rejects a
      // double spend, so this degrades the guarantee rather than the ledger.
      console.warn(`pending tx ${p.txHash} is not decodable`);
      return { txHash: p.txHash, spent: [], produced: [] };
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
    return { txHash: p.txHash, spent, produced: mine };
  });

  const { drop, add } = projectOutrefs(walletUtxos.map(utxoOutref), flows);
  return {
    utxos: [
      ...walletUtxos.filter((u) => !drop.has(utxoOutref(u))),
      ...[...produced].filter(([key]) => add.has(key)).map(([, u]) => u),
    ],
    flows,
  };
}

const utxoOutref = (u: UTxO.UTxO): string =>
  outrefKey(TransactionHash.toHex(u.transactionId), u.index);

/**
 * One input per dependency: an output that exists only because the transaction
 * it depends on was included, so the ledger cannot accept this transaction
 * without that one. Refusing to build is the point — a response that quietly
 * went out unchained could outlive the survey it answers.
 */
function chainInputs(
  dependsOn: readonly string[],
  flows: readonly TxFlow[],
  utxos: readonly UTxO.UTxO[],
): UTxO.UTxO[] {
  const picked = new Map<string, UTxO.UTxO>();
  for (const parent of dependsOn) {
    const reachable = descendantOutrefs(parent, flows);
    const utxo = utxos.find((u) => reachable.has(utxoOutref(u)));
    if (!utxo) {
      throw new Error(
        `Transaction ${parent} is still unconfirmed and leaves nothing for this one to build on, so the two cannot be tied together. Wait for it to appear on chain.`,
      );
    }
    picked.set(utxoOutref(utxo), utxo);
  }
  return [...picked.values()];
}

/**
 * Shared build context: an evolution-sdk client wired to Koios and the connected
 * wallet (CIP-30), plus the wallet's UTxOs and change address so the build never
 * round-trips Koios for `/address_info`. When a serving tier is configured,
 * protocol parameters come from it and are passed to `build()` — the build then
 * makes no Koios call at all (the redeemer-free flows here never trigger script
 * evaluation). Sign + submit still go through the wallet at the call site.
 *
 * Read once per chain, not per transaction: the projection is what changes as a
 * chain is built, and it is derived from these.
 *
 * The network is re-read from the wallet here, not taken from the identity read
 * at connect: switching networks inside a wallet doesn't necessarily invalidate
 * the handle, and every screen's mismatch gate compares that connect-time
 * snapshot. This is the last point before a transaction is built, so it is the
 * one check every submit path shares.
 */
async function txContext(config: SubmitConfig, api: Cip30Api) {
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
  const walletUtxos = utxoHexes.map(cip30UtxoToCore);
  const changeAddress = Address.fromHex(await api.getChangeAddress());
  const own = await ownAddresses(api, changeAddress);
  // Serving-tier pparams (no Koios token needed); without a backend, leave it
  // undefined and the provider fetches them from Koios during build as before.
  const fullProtocolParameters = config.indexerUrl
    ? await fetchBackendPParams(config.indexerUrl)
    : undefined;
  return { client, walletUtxos, changeAddress, own, fullProtocolParameters };
}

type TxContext = Awaited<ReturnType<typeof txContext>>;

/**
 * `build()` options with protocol parameters injected only when we have them, so
 * the SDK skips its own Koios pparams fetch. Spread (rather than passing
 * `undefined`) to satisfy `exactOptionalPropertyTypes`.
 */
function buildOpts(ctx: TxContext, availableUtxos: UTxO.UTxO[]) {
  const { changeAddress, fullProtocolParameters } = ctx;
  return {
    availableUtxos,
    changeAddress,
    ...(fullProtocolParameters ? { fullProtocolParameters } : {}),
  };
}

/**
 * A transaction whose bytes we hold — in flight from an earlier run, or built in
 * this one. Only the body feeds the projection, and witnesses never enter it, so
 * an unsigned transaction projects exactly like a submitted one.
 */
interface TxBytes {
  readonly txHash: string;
  readonly txCbor: string;
}

/**
 * A built transaction and the witnesses it still waits for.
 *
 * `required` is what the ledger will check: the payment key of every input the
 * builder selected, plus the credentials the payload proves control of — the
 * same set the fee already budgets witnesses for. `missing` is re-derived from
 * the transaction itself, so nothing has to record which wallet signed what: a
 * witness is either in there or it is not.
 */
export interface BuiltTx extends TxBytes {
  readonly planned: PlannedTx;
  /** The transaction as it stands; witnesses accumulate into it. */
  readonly txCbor: string;
  readonly required: readonly string[];
  readonly missing: readonly string[];
}

/**
 * Serialized size of a label-17 payload — what the planner fills transactions
 * up to. The encoder lives behind this seam, so the planner takes it injected.
 */
export function payloadSize(payload: Cip179Payload): number {
  return metadatumToCbor(encodePayload(payload)).length;
}

/**
 * Build one planned transaction against `utxos`.
 *
 * `proveCredentials` are the credentials the payload must prove control of
 * (CIP-179 credential proof, mechanism A): each key-based credential is added to
 * the transaction's `required_signers`, which forces the ledger to require — and
 * the wallet to produce — a signature witness for that key (e.g. a Stakeholder's
 * stake key, not just the payment key that funds the tx). Definitions /
 * cancellations prove the survey `owner`; responses the responder credential.
 *
 * A governance **Info Action** proposal carries no CIP-179 payload — it exists
 * only to advertise the survey referenced inside its anchor's `body.cip179` —
 * and needs no witness beyond the wallet's payment key. Its refundable
 * `gov_action_deposit` comes from protocol parameters and returns to the
 * wallet's reward account when the action is ratified or expires.
 */
async function buildTx(
  ctx: TxContext,
  api: Cip30Api,
  planned: PlannedTx,
  utxos: UTxO.UTxO[],
  flows: readonly TxFlow[],
): Promise<string> {
  let tx = ctx.client.newTx();
  if (planned.body.type === "metadata") {
    tx = tx.attachMetadata({
      label: BigInt(METADATA_LABEL),
      metadata: toTxMetadatum(encodePayload(planned.body.payload)),
    });
  } else {
    const rewardHex = (await api.getRewardAddresses())?.[0];
    if (!rewardHex) {
      throw new Error(
        "Wallet exposes no reward (stake) address — a governance proposal needs one for the refundable deposit. Use a base-address (staking) wallet.",
      );
    }
    tx = tx.propose({
      governanceAction: new GovernanceAction.InfoAction({}),
      rewardAccount: RewardAccount.fromHex(rewardHex),
      anchor: new Anchor.Anchor({
        anchorUrl: new Url.Url({ href: planned.body.anchorUrl }),
        anchorDataHash: planned.body.anchorDataHash,
      }),
    });
  }

  for (const cred of planned.proveCredentials) {
    if (cred.type !== "key") {
      // Native/Plutus-script credential proof needs script resolution (or a
      // governance-vote binding) that this in-browser path can't assemble yet.
      throw new Error(
        "Script-credential proof is not supported here yet — use a key-based credential.",
      );
    }
    tx = tx.addSigner({ keyHash: KeyHash.fromBytes(cred.keyHash) });
  }

  const inputs = chainInputs(planned.dependsOn, flows, utxos);
  if (inputs.length > 0) tx = tx.collectFrom({ inputs });

  const built = await tx.build(buildOpts(ctx, utxos));
  return Transaction.toCBORHex(await built.toTransaction());
}

/**
 * A transaction's id, read from the body bytes as submitted rather than from a
 * re-encoding of them, so it is the id the ledger will compute. Witnesses don't
 * enter it, which is what lets the next transaction of a chain be built on this
 * one before it has been signed.
 */
function txId(unsignedHex: string): string {
  return TransactionHash.toHex(
    TransactionBody.toHashFromBytes(
      Transaction.extractBodyBytes(hexToBytes(unsignedHex)),
    ),
  );
}

/**
 * Key hashes that must witness `txCbor`, given the UTxOs it was built against:
 * the payment key of every input it spends, plus its declared required signers.
 */
function requiredWitnesses(
  txCbor: string,
  utxos: readonly UTxO.UTxO[],
): string[] {
  const { body } = Transaction.fromCBORHex(txCbor);
  const byOutref = new Map(utxos.map((u) => [utxoOutref(u), u]));
  const hashes = new Set<string>();
  for (const input of body.inputs) {
    const spent = byOutref.get(
      outrefKey(TransactionHash.toHex(input.transactionId), input.index),
    );
    const cred = spent?.address.paymentCredential;
    if (cred?._tag === "KeyHash") hashes.add(KeyHash.toHex(cred));
  }
  for (const signer of body.requiredSigners ?? []) {
    hashes.add(KeyHash.toHex(signer));
  }
  return [...hashes];
}

/** The same transaction, with `missing` re-read from the witnesses it carries. */
function withMissing(tx: Omit<BuiltTx, "missing">): BuiltTx {
  const { witnessSet } = Transaction.fromCBORHex(tx.txCbor);
  const witnessed = new Set(
    (witnessSet.vkeyWitnesses ?? []).map((w) =>
      KeyHash.toHex(KeyHash.fromVKey(w.vkey)),
    ),
  );
  return { ...tx, missing: tx.required.filter((h) => !witnessed.has(h)) };
}

/**
 * Build a planned chain with the connected wallet, without signing it.
 *
 * Each transaction is built against the projection including the ones built
 * before it in this run, so the chain funds itself without double-spending, and
 * a planned dependency becomes a real input. The building wallet pays every fee
 * and spends every input, which is why one wallet builds the whole chain; the
 * witnesses gathered afterwards prove credentials, they don't pay for anything.
 */
export async function buildChain(
  config: SubmitConfig,
  api: Cip30Api,
  txs: readonly PlannedTx[],
  pending: readonly TxBytes[],
): Promise<BuiltTx[]> {
  const ctx = await txContext(config, api);
  const inFlight: TxBytes[] = [...pending];
  const built: BuiltTx[] = [];

  for (const planned of txs) {
    const { utxos, flows } = project(ctx.walletUtxos, inFlight, ctx.own);
    const txCbor = await buildTx(ctx, api, planned, utxos, flows);
    const tx = withMissing({
      planned,
      txHash: txId(txCbor),
      txCbor,
      required: requiredWitnesses(txCbor, utxos),
    });
    built.push(tx);
    inFlight.push(tx);
  }
  return built;
}

/**
 * What a wallet threw, as something worth showing. CIP-30 errors are loose
 * `{code, info}` objects rather than `Error`s, and stringifying one of those
 * yields `[object Object]`.
 */
const message = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "info" in e) {
    return String((e as { info: unknown }).info);
  }
  return String(e);
};

/**
 * How long a wallet is given to catch up with an input before it is asked to
 * sign anyway, and how long to leave between one answer and the next question.
 * The gap is not a rate: a wallet slow to answer `getUtxos` is asked less often
 * rather than piled on, and is given the same ten seconds as a quick one.
 */
const CATCH_UP_MS = 10_000;
const CATCH_UP_POLL_MS = 500;

/** The wallet's own UTxOs, or undefined if it will not enumerate them. */
async function walletOutrefs(
  api: Cip30Api,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const hexes = await api.getUtxos();
    return hexes && new Set(hexes.map(cip30Outref));
  } catch {
    return undefined;
  }
}

/**
 * What `group` spends without producing it among themselves, each mapped to the
 * transaction that made it.
 */
function externalInputs(group: readonly BuiltTx[]): Map<string, string> {
  const within = new Set(group.map((tx) => tx.txHash));
  const inputs = new Map<string, string>();
  for (const tx of group) {
    const { body } = Transaction.fromCBORHex(tx.txCbor);
    for (const input of body.inputs) {
      const hash = TransactionHash.toHex(input.transactionId);
      if (!within.has(hash)) inputs.set(outrefKey(hash, input.index), hash);
    }
  }
  return inputs;
}

/**
 * Wait until the wallet lists every input `group` spends without producing it,
 * and answer with the transactions behind whatever it still doesn't.
 *
 * A wallet resolves each input against its own view of the chain before it will
 * sign, so a transaction funded by one submitted seconds ago — every chained
 * transaction, and every first answer to a freshly published survey — is
 * unsignable until the wallet has caught up. Bounded: past the deadline it is
 * asked anyway, so a wallet that never lists what it hasn't seen confirmed is no
 * worse off than without the wait.
 */
async function awaitCatchUp(
  api: Cip30Api,
  group: readonly BuiltTx[],
): Promise<ReadonlySet<string>> {
  const inputs = externalInputs(group);
  if (inputs.size === 0) return new Set();

  const deadline = Date.now() + CATCH_UP_MS;
  for (;;) {
    const held = await walletOutrefs(api);
    if (!held) return new Set();
    const behind = [...inputs].filter(([key]) => !held.has(key));
    if (behind.length === 0) return new Set();
    if (Date.now() >= deadline) return new Set(behind.map(([, hash]) => hash));
    await new Promise((resolve) => setTimeout(resolve, CATCH_UP_POLL_MS));
  }
}

/**
 * What to report when a wallet won't sign. One that never caught up with an
 * input cannot resolve it, and says so in terms of the CBOR it was handed —
 * which names neither the transaction it is waiting for nor the wait as the
 * remedy. The user declining is still the user declining, whatever else is true.
 */
function signError(e: unknown, behind: ReadonlySet<string>): string {
  if (behind.size === 0 || isRefusal(e)) return message(e);
  return `Your wallet has not caught up with transaction ${[...behind].join(", ")} yet, so it cannot sign one that spends what that transaction produced. Wait a few seconds and sign again.`;
}

/**
 * Offer one transaction to the connected wallet and merge back what it produces.
 * CIP-30 partial signing has a wallet sign what it holds and ignore the rest, so
 * this is also how a second wallet completes a chain the first could only
 * half-witness.
 *
 * The wallet's network is not re-checked here: a key hash is the same on every
 * network, so a wallet pointed elsewhere still produces the witness this
 * transaction needs.
 */
async function signOne(
  api: Cip30Api,
  tx: BuiltTx,
): Promise<{ readonly tx: BuiltTx; readonly error: string | null }> {
  const behind = await awaitCatchUp(api, [tx]);
  try {
    const witnessHex = await api.signTx(tx.txCbor, true);
    return {
      tx: withMissing({
        ...tx,
        txCbor: Transaction.addVKeyWitnessesHex(tx.txCbor, witnessHex),
      }),
      error: null,
    };
  } catch (e) {
    return { tx, error: signError(e, behind) };
  }
}

/**
 * Offer the whole chain in one prompt, to a wallet that granted CIP-103. It
 * walks the list in order, so a transaction spending what an earlier one in the
 * list produces resolves — which is what lets a chain be witnessed before any of
 * it has been submitted. A single outstanding transaction is left alone: it is
 * one prompt either way, and `signTx` is what every wallet implements.
 *
 * A decline ends the round; anything else falls back to one prompt per
 * transaction, so a wallet advertising bulk signing it cannot actually perform
 * is slower rather than unusable.
 */
async function bulkSign(
  api: Cip30Api,
  built: readonly BuiltTx[],
): Promise<{
  readonly txs: readonly BuiltTx[];
  readonly error: string | null;
}> {
  const bulk = api.cip103;
  const open = built.filter((tx) => tx.missing.length > 0);
  if (!bulk || open.length < 2) return { txs: built, error: null };

  const behind = await awaitCatchUp(api, open);
  try {
    const witnesses = await bulk.signTxs(
      open.map((tx) => ({ cbor: tx.txCbor, partialSign: true })),
    );
    if (witnesses.length !== open.length) {
      throw new Error(
        `wallet answered ${open.length} transactions with ${witnesses.length} witness sets`,
      );
    }
    const signed = new Map(
      open.map((tx, i) => [
        tx,
        withMissing({
          ...tx,
          txCbor: Transaction.addVKeyWitnessesHex(tx.txCbor, witnesses[i]!),
        }),
      ]),
    );
    return { txs: built.map((tx) => signed.get(tx) ?? tx), error: null };
  } catch (e) {
    if (isRefusal(e) || behind.size > 0) {
      return { txs: built, error: signError(e, behind) };
    }
    console.warn(`bulk signing failed, falling back: ${message(e)}`);
    return { txs: built, error: null };
  }
}

/**
 * Sign and publish a chain as far as the connected wallet takes it.
 *
 * One pass, in order: a transaction is offered to the wallet if it still misses
 * a witness, and broadcast the moment it holds them all — before the next one is
 * offered. That order is the wallet's requirement, not ours: it resolves every
 * input against its own view of the chain before it will sign, so a transaction
 * funded by its predecessor's change is unsignable until that predecessor has
 * gone out. {@link bulkSign} lifts that constraint where the wallet supports it,
 * and then this pass finds nothing left to ask for.
 *
 * The pass stops at the first transaction left incomplete — another wallet owes
 * it a witness, and nothing behind it can be included without it — or at the
 * first the node refuses. What did not go out comes back, witnesses and all, so
 * the next round picks up exactly there; `onSubmitted` fires per transaction as
 * it lands, so an interrupted run still records what did go.
 *
 * Never throws: a chain that stopped short is recovered from the drawer.
 */
export async function signAndSubmitChain(
  api: Cip30Api,
  built: readonly BuiltTx[],
  onSubmitted: (tx: BuiltTx) => void,
): Promise<{
  readonly txs: readonly BuiltTx[];
  readonly error: string | null;
}> {
  const bulk = await bulkSign(api, built);
  if (bulk.error !== null) return bulk;

  const txs = [...bulk.txs];
  let error: string | null = null;
  let sent = 0;

  for (; sent < txs.length; sent++) {
    if (txs[sent]!.missing.length > 0) {
      const signed = await signOne(api, txs[sent]!);
      txs[sent] = signed.tx;
      error = signed.error;
    }
    if (error !== null || txs[sent]!.missing.length > 0) break;
    try {
      await api.submitTx(txs[sent]!.txCbor);
    } catch (e) {
      error = message(e);
      break;
    }
    onSubmitted(txs[sent]!);
  }
  return { txs: txs.slice(sent), error };
}
