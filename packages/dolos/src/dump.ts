/**
 * What `dolos data dump-entity` prints, read back: Rust's pretty `Debug`
 * form of a stored entity. No Dolos route serves an account's stake in the
 * snapshot taken at the end of an epoch (the ledger's mark), and this is the
 * shipped command that prints it. `Debug` is not a stable interface, so every
 * field read here is looked up by name and a shape it does not know throws;
 * the Dolos release an audit runs is pinned (`docs/AUDIT.md`).
 */

/** A `Debug` value; `None` reads as null, `Some(x)` as a tuple named `Some`. */
export type DebugValue =
  | bigint
  | string
  | boolean
  | null
  | readonly DebugValue[]
  | {
      readonly kind: "struct";
      readonly name: string;
      readonly fields: Readonly<Record<string, DebugValue>>;
    }
  | {
      readonly kind: "tuple";
      readonly name: string;
      readonly items: readonly DebugValue[];
    }
  | { readonly kind: "unit"; readonly name: string };

export function parseDebug(text: string): DebugValue {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`dump-entity output: ${what} at offset ${i}`);
  };
  const skip = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const expect = (c: string) => {
    skip();
    if (text[i] !== c) fail(`expected '${c}'`);
    i++;
  };
  /** Items up to `close`, each followed by an optional comma. */
  const items = <T>(close: string, item: () => T): T[] => {
    const out: T[] = [];
    for (;;) {
      skip();
      if (text[i] === close) {
        i++;
        return out;
      }
      out.push(item());
      skip();
      if (text[i] === ",") i++;
    }
  };
  const value = (): DebugValue => {
    skip();
    const c = text[i];
    if (c === undefined) return fail("unexpected end");
    if (c === '"') {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(text.slice(i));
      if (!m) return fail("unterminated string");
      i += m[0].length;
      return JSON.parse(m[0]) as string;
    }
    if (c === "[") {
      i++;
      return items("]", value);
    }
    if (c === "(") {
      i++;
      return { kind: "tuple", name: "", items: items(")", value) };
    }
    const number = /^-?\d+/.exec(text.slice(i));
    if (number) {
      i += number[0].length;
      if (text[i] === ".") fail("a fractional number");
      return BigInt(number[0]);
    }
    const ident = /^[A-Za-z_]\w*(?:<\d+>)?(?:::[A-Za-z_]\w*)*/.exec(
      text.slice(i),
    );
    if (!ident) return fail(`unexpected '${c}'`);
    const name = ident[0];
    i += name.length;
    const after = i;
    skip();
    if (text[i] === "{") {
      i++;
      const fields: Record<string, DebugValue> = {};
      items("}", () => {
        skip();
        const key = /^[A-Za-z_]\w*/.exec(text.slice(i));
        if (!key) return fail("expected a field name");
        i += key[0].length;
        expect(":");
        fields[key[0]] = value();
      });
      return { kind: "struct", name, fields };
    }
    if (text[i] === "(") {
      i++;
      return { kind: "tuple", name, items: items(")", value) };
    }
    i = after;
    if (name === "None") return null;
    if (name === "true" || name === "false") return name === "true";
    return { kind: "unit", name };
  };
  const out = value();
  skip();
  if (i !== text.length) fail("trailing text");
  return out;
}

function field(v: DebugValue, name: string): DebugValue {
  if (v === null || typeof v !== "object" || !("kind" in v))
    throw new Error(`dump-entity output: no struct holding ${name}`);
  if (v.kind !== "struct" || !(name in v.fields))
    throw new Error(`dump-entity output: ${v.name} has no field ${name}`);
  return v.fields[name]!;
}

/** The single item of a tuple named `name` (a newtype, or `Some`). */
function inner(v: DebugValue, name: string): DebugValue {
  if (
    v !== null &&
    typeof v === "object" &&
    "kind" in v &&
    v.kind === "tuple" &&
    v.name === name &&
    v.items.length === 1
  )
    return v.items[0]!;
  throw new Error(`dump-entity output: expected ${name}(…)`);
}

const some = (v: DebugValue): DebugValue =>
  v === null ? null : inner(v, "Some");

function int(v: DebugValue): bigint {
  if (typeof v !== "bigint")
    throw new Error("dump-entity output: expected an integer");
  return v;
}

/** A `(slot, tx order)` pair, as a DRep's registration events are kept. */
function slotOrder(v: DebugValue): readonly [bigint, bigint] | null {
  const pair = some(v);
  if (pair === null) return null;
  if (
    typeof pair === "object" &&
    "kind" in pair &&
    pair.kind === "tuple" &&
    pair.name === "" &&
    pair.items.length === 2
  )
    return [int(pair.items[0]!), int(pair.items[1]!)];
  throw new Error("dump-entity output: expected (slot, order)");
}

/**
 * An `EpochValue`'s version for the snapshot taken at the end of `epoch`,
 * as Dolos's `EpochValue::snapshot_at` picks it: `live` while the value
 * still stands in `epoch`, then `mark`, `set` and `go`, one epoch back each;
 * null when the value keeps no version that old, or it was `None`.
 */
function snapshotAt(ev: DebugValue, epoch: number): DebugValue {
  const at = Number(int(inner(field(ev, "epoch"), "Epoch")));
  const slot = ["live", "mark", "set", "go"][at - epoch];
  return slot === undefined ? null : some(field(ev, slot));
}

export interface AccountAtEnd {
  readonly registered: boolean;
  /** Its stake in the snapshot taken at the end of the epoch. */
  readonly stake: bigint;
  /** The pool it delegated that stake to (hash, hex), or null for none. */
  readonly pool: string | null;
}

/**
 * An account at the end of `epoch`, read from a node standing in the next
 * epoch, whose first slot is `nextStart`.
 *
 * Dolos clears `registered_at` on deregistration, so registration at the end
 * is a `registered_at` before `nextStart`. A deregistration at or after
 * `nextStart` cleared it, and whether the account had registered once more
 * after `nextStart` first is not kept, so it is refused.
 */
export function accountAtEnd(
  text: string,
  epoch: number,
  nextStart: number,
): AccountAtEnd {
  const a = parseDebug(text);
  const registeredAt = some(field(a, "registered_at"));
  const deregisteredAt = some(field(a, "deregistered_at"));
  if (deregisteredAt !== null && int(deregisteredAt) >= nextStart)
    throw new Error(
      `deregistered at slot ${deregisteredAt}, after epoch ${epoch}: its registration at the epoch's end is not read`,
    );
  const registered = registeredAt !== null && int(registeredAt) < nextStart;
  const stake = snapshotAt(field(a, "stake"), epoch);
  const pool = snapshotAt(field(a, "pool"), epoch);
  return {
    registered,
    // Since Conway, stake at pointer addresses counts for no one.
    stake:
      stake === null
        ? 0n
        : int(field(stake, "utxo_sum")) +
          int(field(stake, "rewards_sum")) -
          int(field(stake, "withdrawals_sum")),
    pool:
      pool !== null &&
      typeof pool === "object" &&
      "kind" in pool &&
      pool.name === "Pool"
        ? String(inner(inner(pool, "Pool"), "Hash<28>"))
        : null,
  };
}

export interface DRepAtEnd {
  readonly registered: boolean;
  /** Its power in the distribution taken at the end of the epoch. */
  readonly power: bigint;
}

/**
 * A DRep at the end of `epoch`, on a node standing in the next epoch, which
 * writes that distribution into `voting_power` as it runs the boundary.
 *
 * A registration after `nextStart` means the DRep was not registered at the
 * end (it could not register while registered). An unregistration after it
 * zeroes `voting_power`, the power the end counted, so it is refused. Dolos
 * keeps the last of each event, so a DRep registered before `nextStart` is a
 * member unless its last unregistration came later.
 */
export function drepAtEnd(
  text: string,
  epoch: number,
  nextStart: number,
): DRepAtEnd {
  const d = parseDebug(text);
  const registeredAt = slotOrder(field(d, "registered_at"));
  const unregisteredAt = slotOrder(field(d, "unregistered_at"));
  if (unregisteredAt !== null && unregisteredAt[0] >= nextStart)
    throw new Error(
      `unregistered at slot ${unregisteredAt[0]}, after epoch ${epoch}: its power at the epoch's end is gone from the node`,
    );
  const registered =
    registeredAt !== null &&
    registeredAt[0] < nextStart &&
    (unregisteredAt === null ||
      registeredAt[0] > unregisteredAt[0] ||
      (registeredAt[0] === unregisteredAt[0] &&
        registeredAt[1] > unregisteredAt[1]));
  return { registered, power: int(field(d, "voting_power")) };
}

/**
 * Whether a pool stood in the snapshot taken at the end of `epoch`: Dolos
 * counts an account's stake for that snapshot only behind such a pool.
 */
export function poolStandsAt(text: string, epoch: number): boolean {
  const snapshot = snapshotAt(field(parseDebug(text), "snapshot"), epoch);
  return snapshot !== null && field(snapshot, "is_retired") === false;
}
