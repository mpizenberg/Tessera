import { readFile } from "node:fs/promises";

import { type LedgerState, readLedgerState } from "./ledger";

/**
 * The ledger facts a tally needs, printed as JSON with every lovelace amount
 * a decimal string. Credentials are named in `credentialKey` form
 * (`key:<hex>` or `script:<hex>`).
 */
export function facts(
  state: LedgerState,
  stakeholders: string[],
  dreps: string[],
) {
  const snapshot = (s: LedgerState["mark"]) => ({
    total: s.total,
    accounts: s.stake.size,
  });
  const d = state.drepDistribution;
  return {
    epoch: state.epoch,
    slot: state.slot,
    stake: {
      mark: snapshot(state.mark),
      set: snapshot(state.set),
      go: snapshot(state.go),
    },
    drepDistribution: {
      total: d.total,
      withoutAbstainAndNoConfidence: d.total - d.abstain - d.noConfidence,
      abstain: d.abstain,
      noConfidence: d.noConfidence,
      dreps: d.power.size,
      registeredWhenTaken: d.dreps.size,
      registeredNow: state.dreps.size,
    },
    stakeholders: Object.fromEntries(
      stakeholders.map((key) => {
        const account = state.accounts.get(key);
        return [
          key,
          {
            registered: account !== undefined,
            ...account,
            mark: state.mark.stake.get(key),
            set: state.set.stake.get(key),
            go: state.go.stake.get(key),
          },
        ];
      }),
    ),
    dreps: Object.fromEntries(
      dreps.map((key) => {
        const now = state.dreps.get(key);
        return [
          key,
          {
            registered: now !== undefined,
            ...now,
            registeredWhenTaken: d.dreps.has(key),
            power: d.power.get(key) ?? 0n,
          },
        ];
      }),
    ),
  };
}

async function main(args: string[]): Promise<void> {
  const [file, ...rest] = args;
  if (file === undefined) {
    throw new Error(
      "usage: facts <state-file> [--stake <cred>...] [--drep <cred>...]",
    );
  }
  const lists = { "--stake": [] as string[], "--drep": [] as string[] };
  let current: keyof typeof lists | undefined;
  for (const arg of rest) {
    if (arg in lists) current = arg as keyof typeof lists;
    else if (current === undefined)
      throw new Error(`unexpected argument ${arg}`);
    else lists[current].push(arg);
  }
  const state = readLedgerState(await readFile(file));
  const document = facts(state, lists["--stake"], lists["--drep"]);
  console.log(
    JSON.stringify(
      document,
      (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
