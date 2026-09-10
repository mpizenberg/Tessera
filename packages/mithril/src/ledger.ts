import { decode as decodeCbor } from "cborg";

import type { Credential } from "cip-179";

import { credentialKey } from "cip-179/domain";

/** A stake credential's row in the ledger's unified map. */
export interface Account {
  readonly reward: bigint;
  readonly deposit: bigint;
  /** Pool id hex, when delegated. */
  readonly pool: string | undefined;
  /** A DRep in `credentialKey` form, `abstain`, `noConfidence`, or none. */
  readonly drep: string | undefined;
}

/** One row of a stake snapshot: what a credential had staked, and where. */
export interface Delegation {
  readonly stake: bigint;
  /** Pool id hex, possibly of a pool that has retired since. */
  readonly pool: string;
}

export interface StakeSnapshot {
  /** Per credential (`credentialKey` form), delegated accounts only. */
  readonly stake: ReadonlyMap<string, Delegation>;
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
  /** Ids of the pools registered now. */
  readonly pools: ReadonlySet<string>;
  readonly mark: StakeSnapshot;
  readonly set: StakeSnapshot;
  readonly go: StakeSnapshot;
  /** DRep registrations now. */
  readonly dreps: ReadonlyMap<string, DRepRegistration>;
  readonly drepDistribution: DRepDistribution;
}

/**
 * A node in the decoded file. The layout below is positional and has no
 * schema, so the walk indexes freely and every value it keeps goes through a
 * conversion that throws on the wrong shape.
 */
type Cbor = any;

/**
 * cborg refuses a tag it has no decoder for, so this table is also the record
 * of what a state file carries: big integers, the rationals of the protocol
 * parameters, and sets. A rational and a set are read as their contents.
 */
const tags: Record<number, (read: () => Cbor) => Cbor> = {
  2: (read) => BigInt(`0x${hex(read()) || "0"}`),
  3: (read) => -1n - BigInt(`0x${hex(read()) || "0"}`),
  30: (read) => read(),
  258: (read) => read(),
};

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
 *   PState                [{vrfKeyHash: count}, {pool: params}, {pool: futureParams}, {pool: retiringEpoch}]
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
  const state: Cbor = decodeCbor(bytes, { useMaps: true, tags });
  const [[tip], nes] = state[1][0].at(-1)[1][1];
  const epochState = nes[3];
  const [[vstate, pstate, dstate], utxoState] = epochState[1];
  const snapshots = epochState[2];
  const pulsing = utxoState[3][6][0];
  return {
    epoch: num(nes[0]),
    slot: num(tip[0]),
    accounts: readMap(dstate[0], credKey, readAccount),
    pools: new Set(readMap(pstate[1], hex, () => 0).keys()),
    mark: readSnapshot(snapshots[0]),
    set: readSnapshot(snapshots[1]),
    go: readSnapshot(snapshots[2]),
    dreps: readMap(vstate[0], credKey, readDRepRegistration),
    drepDistribution: readDRepDistribution(pulsing[1], pulsing[2]),
  };
}

function readAccount([reward, deposit, pool, drep]: Cbor): Account {
  return {
    reward: int(reward),
    deposit: int(deposit),
    pool: pool == null ? undefined : hex(pool),
    drep: drep == null ? undefined : drepKey(drep),
  };
}

function readSnapshot(snapshot: Cbor): StakeSnapshot {
  const stake = readMap(snapshot[0], credKey, readDelegation);
  return { stake, total: sum(Array.from(stake.values(), (d) => d.stake)) };
}

function readDelegation([stake, pool]: Cbor): Delegation {
  return { stake: int(stake), pool: hex(pool) };
}

function readDRepRegistration([
  expiry,
  ,
  deposit,
  delegators,
]: Cbor): DRepRegistration {
  return {
    expiry: num(expiry),
    deposit: int(deposit),
    delegators: num(delegators.length),
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

function credKey([tag, hash]: Cbor): string {
  return credentialKey(credential(num(tag), bytes(hash)));
}

function credential(tag: number, hash: Uint8Array): Credential {
  if (tag === 0) return { type: "key", keyHash: hash };
  if (tag === 1) return { type: "script", scriptHash: hash };
  throw new Error(`ledger state: credential tag ${tag}`);
}

function drepKey(drep: Cbor): string {
  if (drep[0] === 2) return "abstain";
  if (drep[0] === 3) return "noConfidence";
  return credKey(drep);
}

function readMap<V>(
  map: Cbor,
  key: (k: Cbor) => string,
  value: (v: Cbor) => V,
): Map<string, V> {
  if (!(map instanceof Map)) throw new Error("ledger state: expected a map");
  const out = new Map<string, V>();
  for (const [k, v] of map) out.set(key(k), value(v));
  return out;
}

/** Throws rather than return NaN, so a wrong path cannot pass for a number. */
function num(value: Cbor): number {
  return Number(int(value));
}

function int(value: Cbor): bigint {
  if (typeof value === "number" || typeof value === "bigint")
    return BigInt(value);
  throw new Error("ledger state: expected an integer");
}

function bytes(value: Cbor): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new Error("ledger state: expected bytes");
  return value;
}

function hex(value: Cbor): string {
  return Buffer.from(bytes(value)).toString("hex");
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
