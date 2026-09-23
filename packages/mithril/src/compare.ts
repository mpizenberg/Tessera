import { readFile } from "node:fs/promises";

import { parseNetwork, SECONDS_PER_EPOCH } from "cardano-tessera-client";
import { KOIOS_URL } from "cardano-tessera-core";
import { KoiosTallyInputs } from "cardano-tessera-koios";
import type { WeightInfo } from "cip-179/tally";

import { parseCredentialKey } from "cip-179/domain";

import { type LedgerState, readLedgerState } from "./ledger";

/** Credentials drawn per kind, in the file's order. */
const PER_KIND = 10;

type Kinds = Record<string, (key: string) => boolean>;

/**
 * The stakeholder kinds a tally can meet, each named by what the state shows.
 * Registration during an epoch is not visible in one file, so the three
 * stake snapshots, taken one epoch apart, stand in as the timeline.
 */
function stakeholderKinds(state: LedgerState): Kinds {
  const { accounts, mark, set, go, pools } = state;
  const snapshots = [mark, set, go];
  const inAny = (key: string) => snapshots.some((s) => s.stake.has(key));
  return {
    "delegated, with rewards": (key) => {
      const account = accounts.get(key);
      return (
        account?.pool !== undefined && account.reward > 0n && set.stake.has(key)
      );
    },
    "registered, no pool": (key) =>
      accounts.has(key) && accounts.get(key)!.pool === undefined,
    "stake in a pool since retired": (key) =>
      snapshots.some((s) => {
        const row = s.stake.get(key);
        return row !== undefined && !pools.has(row.pool);
      }),
    "registered, in no snapshot": (key) => accounts.has(key) && !inAny(key),
    "in mark, not in set": (key) =>
      accounts.has(key) && mark.stake.has(key) && !set.stake.has(key),
    "in a snapshot, not registered": (key) => !accounts.has(key) && inAny(key),
    "script credential": (key) =>
      key.startsWith("script:") && accounts.has(key),
  };
}

function drepKinds(state: LedgerState, epoch: number): Kinds {
  const now = state.dreps;
  const taken = state.drepDistribution.dreps;
  const power = state.drepDistribution.power;
  return {
    "active, with delegators": (key) => (now.get(key)?.delegators ?? 0) > 0,
    expired: (key) => now.has(key) && now.get(key)!.expiry < epoch,
    "retired since the distribution": (key) => !now.has(key) && taken.has(key),
    "registered since the distribution": (key) =>
      now.has(key) && !taken.has(key),
    "script credential": (key) => key.startsWith("script:") && now.has(key),
    "zero power": (key) => now.has(key) && (power.get(key) ?? 0n) === 0n,
  };
}

/** The first {@link PER_KIND} keys of each kind; a kind with none stays listed. */
function sample(keys: Iterable<string>, kinds: Kinds): Map<string, string[]> {
  const out = new Map(Object.keys(kinds).map((name) => [name, [] as string[]]));
  for (const key of keys) {
    for (const [name, has] of Object.entries(kinds)) {
      const picked = out.get(name)!;
      if (picked.length < PER_KIND && has(key)) picked.push(key);
    }
  }
  return out;
}

/**
 * Every credential that entered or left a registration map between two
 * states, not a sample: these are the only rows on which the two states
 * disagree about registration, so the only ones that show which boundary
 * Koios reads, and there are few.
 */
function changed(
  now: ReadonlyMap<string, unknown>,
  before: ReadonlyMap<string, unknown>,
): [string, string[]][] {
  return [
    [
      "registered since the previous state",
      [...now.keys()].filter((key) => !before.has(key)),
    ],
    [
      "deregistered since the previous state",
      [...before.keys()].filter((key) => !now.has(key)),
    ],
  ];
}

/** Per credential, whether Koios agrees with each candidate reading. */
type Agreement = Record<string, boolean>;

function stakeholderAgreement(
  state: LedgerState,
  key: string,
  koios: WeightInfo,
): Agreement {
  const registered = state.accounts.has(key);
  const weight = (s: LedgerState["mark"]) =>
    registered ? (s.stake.get(key)?.stake ?? 0n) : 0n;
  return {
    registered: koios.registered === registered,
    "weight = go": koios.weight === weight(state.go),
    "weight = set": koios.weight === weight(state.set),
    "weight = mark": koios.weight === weight(state.mark),
  };
}

function drepAgreement(
  state: LedgerState,
  key: string,
  koios: WeightInfo,
): Agreement {
  const d = state.drepDistribution;
  return {
    "registered = now": koios.registered === state.dreps.has(key),
    "registered = when taken": koios.registered === d.dreps.has(key),
    "weight = power": koios.weight === (d.power.get(key) ?? 0n),
  };
}

function describeStakeholder(state: LedgerState, key: string): string {
  const account = state.accounts.get(key);
  const at = (s: LedgerState["mark"]) => s.stake.get(key)?.stake ?? "-";
  return (
    `registered ${account !== undefined}, pool ${account?.pool ?? "-"}, ` +
    `go ${at(state.go)}, set ${at(state.set)}, mark ${at(state.mark)}`
  );
}

function describeDRep(state: LedgerState, key: string): string {
  const d = state.drepDistribution;
  return (
    `registered now ${state.dreps.has(key)}, when taken ${d.dreps.has(key)}, ` +
    `power ${d.power.get(key) ?? "-"}`
  );
}

function table(
  role: string,
  picked: Map<string, string[]>,
  agreements: Map<string, Agreement>,
): string[] {
  const columns = Object.keys([...agreements.values()][0] ?? {});
  const lines = [
    `| ${role} kind | n | ${columns.join(" | ")} |`,
    `| --- | ---: | ${columns.map(() => "---:").join(" | ")} |`,
  ];
  for (const [kind, keys] of picked) {
    const counts = columns.map(
      (c) => keys.filter((k) => agreements.get(k)![c]).length,
    );
    lines.push(`| ${kind} | ${keys.length} | ${counts.join(" | ")} |`);
  }
  return lines;
}

function disagreements(
  picked: Map<string, string[]>,
  agreements: Map<string, Agreement>,
  koios: Map<string, WeightInfo>,
  describe: (key: string) => string,
): string[] {
  const lines: string[] = [];
  for (const [key, agreement] of agreements) {
    const off = Object.entries(agreement)
      .filter(([, ok]) => !ok)
      .map(([c]) => c);
    if (off.length === 0) continue;
    const kinds = [...picked]
      .filter(([, keys]) => keys.includes(key))
      .map(([kind]) => kind);
    const k = koios.get(key)!;
    lines.push(
      `- ${key} (${kinds.join("; ")}): differs on ${off.join(", ")}. ` +
        `Koios registered ${k.registered}, weight ${k.weight}; ` +
        `state ${describe(key)}`,
    );
  }
  return lines.length > 0 ? lines : ["- none"];
}

const equals = (a: bigint | null, b: bigint) => (a === b ? "=" : "≠");

async function main(args: string[]): Promise<void> {
  const [networkArg, file, epochArg, previousFile] = args;
  if (networkArg === undefined || file === undefined || epochArg === undefined)
    throw new Error(
      "usage: compare <network> <state-file> <epoch> [<previous-state-file>]",
    );
  const network = parseNetwork(networkArg);
  const epoch = Number(epochArg);
  const state = readLedgerState(await readFile(file));
  const previous =
    previousFile === undefined
      ? undefined
      : readLedgerState(await readFile(previousFile));
  const koios = new KoiosTallyInputs({
    network,
    koiosUrl: KOIOS_URL[network],
    koiosToken: process.env["KOIOS_TOKEN"],
    sinceUnix: 0,
    secondsPerEpoch: SECONDS_PER_EPOCH[network],
  });

  const stakeholders = new Map([
    ...sample(
      new Set([
        ...state.accounts.keys(),
        ...state.mark.stake.keys(),
        ...state.set.stake.keys(),
        ...state.go.stake.keys(),
      ]),
      stakeholderKinds(state),
    ),
    ...(previous ? changed(state.accounts, previous.accounts) : []),
  ]);
  const dreps = new Map([
    ...sample(
      new Set([...state.dreps.keys(), ...state.drepDistribution.dreps.keys()]),
      drepKinds(state, epoch),
    ),
    ...(previous ? changed(state.dreps, previous.dreps) : []),
  ]);
  const keysOf = (picked: Map<string, string[]>) => [
    ...new Set([...picked.values()].flat()),
  ];
  const [stakeholderWeights, drepWeights, stakeholderTotal, drepTotal] =
    await Promise.all([
      koios.stakeholderWeights(
        epoch,
        keysOf(stakeholders).map(parseCredentialKey),
      ),
      koios.drepWeights(epoch, keysOf(dreps).map(parseCredentialKey)),
      koios.stakeholderTotal(epoch),
      koios.drepTotal(epoch),
    ]);
  const stakeholderAgreements = new Map(
    [...stakeholderWeights].map(([key, w]) => [
      key,
      stakeholderAgreement(state, key, w),
    ]),
  );
  const drepAgreements = new Map(
    [...drepWeights].map(([key, w]) => [key, drepAgreement(state, key, w)]),
  );

  const d = state.drepDistribution;
  console.log(
    [
      `Koios at the end of epoch ${epoch} against the state at epoch ${state.epoch}, slot ${state.slot}` +
        (previous
          ? `, changes since the state at epoch ${previous.epoch}, slot ${previous.slot}`
          : ""),
      "",
      `Stakeholder total: Koios ${stakeholderTotal}; ` +
        `go ${state.go.total} ${equals(stakeholderTotal, state.go.total)}, ` +
        `set ${state.set.total} ${equals(stakeholderTotal, state.set.total)}, ` +
        `mark ${state.mark.total} ${equals(stakeholderTotal, state.mark.total)}`,
      `DRep total: Koios ${drepTotal}; distribution ${d.total} ${equals(drepTotal, d.total)}`,
      "",
      ...table("stakeholder", stakeholders, stakeholderAgreements),
      "",
      ...table("DRep", dreps, drepAgreements),
      "",
      "Stakeholder disagreements:",
      ...disagreements(
        stakeholders,
        stakeholderAgreements,
        stakeholderWeights,
        (key) => describeStakeholder(state, key),
      ),
      "",
      "DRep disagreements:",
      ...disagreements(dreps, drepAgreements, drepWeights, (key) =>
        describeDRep(state, key),
      ),
    ].join("\n"),
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
