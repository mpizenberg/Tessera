import type { Credential } from "cip-179";

import { credentialKey } from "cip-179/domain";

import { type Cbor, decodeCbor } from "./cbor";

/** A stake credential's row in the ledger's unified map. */
export interface Account {
  readonly reward: bigint;
  readonly deposit: bigint;
  /** Pool id hex, when delegated. */
  readonly pool: string | undefined;
  /** A DRep in `credentialKey` form, `abstain`, `noConfidence`, or none. */
  readonly drep: string | undefined;
}

export interface StakeSnapshot {
  /** Stake per credential (`credentialKey` form), delegated accounts only. */
  readonly stake: ReadonlyMap<string, bigint>;
  readonly total: bigint;
}

export interface DRepRegistration {
  readonly expiry: number;
  readonly deposit: bigint;
  readonly delegators: number;
}

export interface DRepDistribution {
  /** Voting power per DRep credential (`credentialKey` form). */
  readonly power: ReadonlyMap<string, bigint>;
  readonly abstain: bigint;
  readonly noConfidence: bigint;
  /** Every entry, the two special DReps included. */
  readonly total: bigint;
  /** DRep registrations as they were when the distribution was taken. */
  readonly dreps: ReadonlyMap<string, DRepRegistration>;
}

/** What a Mithril ancillary `state` file says at its slot. */
export interface LedgerState {
  readonly epoch: number;
  readonly slot: number;
  readonly accounts: ReadonlyMap<string, Account>;
  readonly mark: StakeSnapshot;
  readonly set: StakeSnapshot;
  readonly go: StakeSnapshot;
  /** DRep registrations now. */
  readonly dreps: ReadonlyMap<string, DRepRegistration>;
  readonly drepDistribution: DRepDistribution;
}

/**
 * The file is the node's `ExtLedgerState`, read here by position through
 * these `EncCBOR` layouts (cardano-ledger 1.x, Conway):
 *
 *   ExtLedgerState        [version, [HardForkState, headerState]]
 *   HardForkState         telescope of eras; the last entry is the current one
 *   era entry             [bounds, [version, ShelleyLedgerState]]
 *   ShelleyLedgerState    [[tip], NewEpochState, transition, tables]
 *   tip                   [slot, blockNo, hash]
 *   NewEpochState         [epoch, blocksPrev, blocksCur, EpochState, rewardUpdate, poolDistr, stashedAVVM]
 *   EpochState            [ChainAccountState, LedgerState, SnapShots, NonMyopic]
 *   SnapShots             [mark, set, go, fee]; a SnapShot is [{cred: [stake, pool]}, {pool: params}]
 *   LedgerState           [CertState, UTxOState]
 *   ConwayCertState       [VState, PState, DState]
 *   VState                [{cred: DRepState}, committeeState, dormantEpochs]
 *   DRepState             [expiry, anchor, deposit, delegators]
 *   DState                [UMap, futureGenDelegs, genDelegs, instantaneousRewards]
 *   UMap                  {cred: [reward, deposit, pool | null, DRep | null]}
 *   UTxOState             [utxo, deposited, fees, ConwayGovState, incrementalStake, donation]
 *   ConwayGovState        [proposals, committee, constitution, pparams, prevPParams, futurePParams, DRepPulsingState]
 *   DRepPulsingState      [PulsingSnapshot, RatifyState], always encoded complete
 *   PulsingSnapshot       [proposals, {DRep: power}, {cred: DRepState}, poolDistr]
 *
 * Credential is [0, keyHash] | [1, scriptHash]; DRep adds [2] abstain and
 * [3] no confidence.
 */
export function readLedgerState(bytes: Uint8Array): LedgerState {
  const era = last(arr(at(decodeCbor(bytes), 1, 0)));
  const ledger = arr(at(era, 1, 1));
  const nes = arr(ledger[1]);
  const epochState = arr(nes[3]);
  const [certState, utxoState] = arr(epochState[1]).map(arr);
  const [vstate, , dstate] = arr(certState).map(arr);
  const snapshots = arr(epochState[2]);
  const pulsing = arr(at(utxoState!, 3, 6, 0));
  return {
    epoch: num(nes[0]),
    slot: num(at(ledger[0], 0, 0)),
    accounts: readMap(dstate![0], credKey, readAccount),
    mark: readSnapshot(snapshots[0]),
    set: readSnapshot(snapshots[1]),
    go: readSnapshot(snapshots[2]),
    dreps: readMap(vstate![0], credKey, readDRepRegistration),
    drepDistribution: readDRepDistribution(pulsing[1], pulsing[2]),
  };
}

function readAccount(row: Cbor): Account {
  const [reward, deposit, pool, drep] = arr(row);
  return {
    reward: int(reward),
    deposit: int(deposit),
    pool: pool == null ? undefined : hex(pool),
    drep: drep == null ? undefined : drepKey(drep),
  };
}

function readSnapshot(snapshot: Cbor): StakeSnapshot {
  const stake = readMap(arr(snapshot)[0], credKey, (row) => int(arr(row)[0]));
  return { stake, total: sum(stake.values()) };
}

function readDRepRegistration(row: Cbor): DRepRegistration {
  const [expiry, , deposit, delegators] = arr(row);
  return {
    expiry: num(expiry),
    deposit: int(deposit),
    delegators: arr(delegators).length,
  };
}

function readDRepDistribution(distr: Cbor, states: Cbor): DRepDistribution {
  const all = readMap(distr, drepKey, int);
  const power = new Map([...all].filter(([key]) => key.includes(":")));
  return {
    power,
    abstain: all.get("abstain") ?? 0n,
    noConfidence: all.get("noConfidence") ?? 0n,
    total: sum(all.values()),
    dreps: readMap(states, credKey, readDRepRegistration),
  };
}

function credKey(cbor: Cbor): string {
  const [tag, hash] = arr(cbor);
  return credentialKey(credential(num(tag), bytes(hash)));
}

function credential(tag: number, hash: Uint8Array): Credential {
  if (tag === 0) return { type: "key", keyHash: hash };
  if (tag === 1) return { type: "script", scriptHash: hash };
  throw new Error(`ledger state: credential tag ${tag}`);
}

function drepKey(cbor: Cbor): string {
  const [tag, hash] = arr(cbor);
  if (tag === 2) return "abstain";
  if (tag === 3) return "noConfidence";
  return credentialKey(credential(num(tag), bytes(hash)));
}

function readMap<V>(
  cbor: Cbor,
  key: (k: Cbor) => string,
  value: (v: Cbor) => V,
): Map<string, V> {
  if (!(cbor instanceof Map)) throw new Error("ledger state: expected a map");
  const out = new Map<string, V>();
  for (const [k, v] of cbor) out.set(key(k), value(v));
  return out;
}

function at(cbor: Cbor, ...path: number[]): Cbor {
  return path.reduce((node, index) => arr(node)[index], cbor);
}

function last(items: Cbor[]): Cbor {
  return items[items.length - 1];
}

function arr(cbor: Cbor): Cbor[] {
  if (!Array.isArray(cbor)) throw new Error("ledger state: expected an array");
  return cbor;
}

function num(cbor: Cbor): number {
  if (typeof cbor !== "number")
    throw new Error("ledger state: expected an integer");
  return cbor;
}

function int(cbor: Cbor): bigint {
  if (typeof cbor === "number" || typeof cbor === "bigint") return BigInt(cbor);
  throw new Error("ledger state: expected an integer");
}

function bytes(cbor: Cbor): Uint8Array {
  if (!(cbor instanceof Uint8Array))
    throw new Error("ledger state: expected bytes");
  return cbor;
}

function hex(cbor: Cbor): string {
  return Buffer.from(bytes(cbor)).toString("hex");
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
