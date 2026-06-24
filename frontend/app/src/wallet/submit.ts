/**
 * Transaction submission — the write side of the wallet seam.
 *
 * This is the only place evolution-sdk builds a transaction. The rest of the app
 * hands it a library-agnostic CIP-179 {@link Metadatum} payload (already encoded
 * by the pure `cip-179` codec) and gets back a transaction hash; evolution-sdk
 * never leaks past this module.
 *
 * Koios is used only for one read — protocol parameters (a GET) — during build.
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
  TransactionInput,
  TransactionOutput,
  Url,
  UTxO,
  Value,
  mainnet,
  preview,
} from "@evolution-sdk/evolution";
import { METADATA_LABEL, type Credential, type Metadatum } from "cip-179";

import type { AppConfig } from "~/config";
import { toTxMetadatum } from "./cbor";
import type { Cip30Api } from "./types";

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
 * Shared build context: an evolution-sdk client wired to Koios (reads only) and
 * the connected wallet (CIP-30), plus wallet-sourced UTxOs and change address so
 * the build never round-trips Koios for `/address_info`. Sign + submit still go
 * through the wallet at the call site.
 */
async function txContext(config: AppConfig, api: Cip30Api) {
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
  const availableUtxos = utxoHexes.map(cip30UtxoToCore);
  const changeAddress = Address.fromHex(await api.getChangeAddress());
  return { client, availableUtxos, changeAddress };
}

/** Sign an unsigned tx with the wallet and submit it; returns the tx hash. */
async function signAndSubmit(
  api: Cip30Api,
  unsignedHex: string,
): Promise<string> {
  const witnessHex = await api.signTx(unsignedHex, true);
  const signedHex = Transaction.addVKeyWitnessesHex(unsignedHex, witnessHex);
  return api.submitTx(signedHex);
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
  config: AppConfig,
  api: Cip30Api,
  payload: Metadatum,
  proveCredentials: readonly Credential[] = [],
): Promise<string> {
  const { client, availableUtxos, changeAddress } = await txContext(
    config,
    api,
  );

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

  const built = await tx.build({ availableUtxos, changeAddress });

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
  config: AppConfig,
  api: Cip30Api,
  anchorUrl: string,
  anchorDataHash: Uint8Array,
): Promise<string> {
  const { client, availableUtxos, changeAddress } = await txContext(
    config,
    api,
  );

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

  const built = await tx.build({ availableUtxos, changeAddress });
  const unsignedHex = Transaction.toCBORHex(await built.toTransaction());
  return signAndSubmit(api, unsignedHex);
}
