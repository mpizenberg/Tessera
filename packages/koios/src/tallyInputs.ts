/**
 * Koios-backed {@link TallyInputSource} and {@link ElectorateTotals}: role
 * membership + weights at the end of a survey's `end_epoch = E`
 * (TALLY-SPEC.md §1, §2, ARCHITECTURE.md §6.2), and the electorate totals.
 * db-sync labels the snapshots taken at that instant by the epoch they serve:
 * the DRep distribution `E + 1`, the stake snapshot (the mark) `E + 2`.
 *
 * Nothing is read before Koios can serve that instant whole
 * ({@link KoiosTallyInputs.readable}). db-sync writes the mark in slices over
 * the first blocks of `E + 1`, and a partial read would weigh every missing
 * account 0, so the read waits for Koios's stake cache to hold the mark,
 * which it fills only once db-sync has written all of it. Koios answers from
 * several instances behind one URL, and the cache proves only the one that
 * answered, so the read also waits a margin past `E + 1`'s start, well beyond
 * the slices' writing and any plausible lag between instances.
 *
 * Stakeholders (role 3) resolve in two bulk reads per 50-credential chunk:
 *  - `/account_update_history?epoch_no=lte.E&action_type=in.(registration,
 *    deregistration)` — registration state. Only registration/deregistration
 *    change it (delegations/withdrawals merely imply registration), so we filter
 *    to those two server-side; a credential is registered at E's end iff the
 *    last event in chain order (up to E) is not a deregistration. Chain order is
 *    `(absolute_slot, tx_block_index, cert_index)`, and only the account's max
 *    slot can decide (earlier slots are overridden). When that slot holds both a
 *    registration and a deregistration — in different txs *or* the same tx — we
 *    read those txs' `/tx_info` certificates (`_certs`) and take the last cert by
 *    `(tx_block_index, cert_index)`, exactly the ledger's within-slot
 *    certificate application order, so the verdict matches the chain with no
 *    convention. The common case (no same-slot reg/dereg mix) needs no
 *    `/tx_info` read. Read newest-first and stopped once every address in the
 *    batch has been passed, so the cost tracks the batch's deciding slots
 *    rather than its accounts' lifetimes.
 *  - `/account_stake_history?epoch_no=eq.E+2` — the mark. One row per account
 *    *delegated to a pool* then; a registered account with no row counts with
 *    weight 0 ("registered but empty").
 *
 * DReps (role 0) resolve in bulk too:
 *  - `/drep_voting_power_history?_epoch_no=E+1&epoch_no=eq.E+1&drep_id=in.(…)`
 *    — voting power, one row per DRep *some account has delegated to* then.
 *    Both epoch filters, deliberately: `_epoch_no` keeps the server-side query
 *    to one epoch, and the PostgREST column filter guards against its known
 *    misbehaviour for current epochs. A 50-id `in.(…)` list is ~3 KB of URL,
 *    verified live to return amounts byte-identical to the single-id form.
 *  - `/drep_updates?drep_id=in.(…)&block_time=lte.<E's end>` — registration,
 *    read only for the ids the power read returned nothing for. A power row
 *    proves registration at E's end, since the ledger takes the distribution
 *    over the DReps registered then, but its absence disproves nothing: Koios
 *    omits a registered DRep nobody has delegated to, and TALLY-SPEC.md §1
 *    counts that DRep at weight 0 rather than excluding it as a non-member.
 *    Registered iff the newest registration event at or before E's end is not
 *    a deregistration; `updated` events are filtered out server-side, leaving
 *    registration unchanged exactly as the delegations the stakeholder read
 *    drops do. The endpoint carries no epoch column, so the boundary comes from
 *    `/epoch_info`'s `end_time`.
 *
 * Totals: the mark's total from `/epoch_info` for `E + 2` once that epoch has
 * begun (known to fail with db-sync word128 errors on some preview epochs —
 * hence null-means-retry), from `/pool_stake_snapshot` before, and the DRep
 * distribution's from `/drep_epoch_summary` for `E + 1`.
 */

import type { Credential } from "cip-179";

import { credentialKey } from "cip-179/domain";
import type {
  ElectorateTotals,
  TallyInputSource,
  WeightInfo,
} from "cip-179/tally";
import type { AppConfig } from "cardano-tessera-core";

import { evolutionCodec } from "cip-179/evolution";

import { koiosFetchJson } from "./http";
import { natural } from "./json";

/**
 * Max credentials per bulk read — stake addresses per POST, DRep ids per
 * `in.(…)` GET (matches the other Koios batch sizes).
 */
const CREDENTIAL_BATCH = 50;

/**
 * Rows per page when following a Koios result set. Koios caps a single response
 * at ~1000 rows, so any read that can exceed that must offset-paginate or it
 * silently truncates.
 */
const PAGE_LIMIT = 100;

/**
 * Max tx hashes per `/tx_info` batch — used only to order the (rare) same-slot
 * registration conflicts by `(tx_block_index, cert_index)`. The projection is
 * three columns incl. the trimmed `certificates` array, so batches stay small.
 */
const TX_INFO_BATCH = 50;

/**
 * Koios `tx_info` certificate `type` strings that register / deregister a stake
 * credential (verified live; the schema's `stake_deregistraion` spelling is a
 * docs typo — the wire value is `stake_deregistration`). Used only to order a
 * same-slot registration conflict by cert index; delegation/gov cert types
 * don't change registration state and are ignored.
 */
const REGISTRATION_CERT_TYPES = new Set(["stake_registration"]);
const DEREGISTRATION_CERT_TYPES = new Set(["stake_deregistration"]);

/**
 * How long past `E + 1`'s start the end of `E` is read: a margin for the
 * Koios instances behind one URL to agree, where the stake cache proves only
 * the one that answered. db-sync writes the mark within about 700 blocks of
 * the boundary on mainnet (~4 h), 40 on preview.
 */
const SETTLING_MARGIN_SECONDS = 12 * 3600;

/**
 * Page cap for the two offset-paginated reads. {@link KoiosTallyInputs.postAll}
 * reads a single short page in practice, so reaching this there means Koios
 * ignored our `offset` and the loop would otherwise never end;
 * {@link KoiosTallyInputs.drepRegistrations} may legitimately want a second
 * page, and reaching the cap would mean a 50-DRep batch with a four-figure
 * registration history above its deciding blocks.
 */
const MAX_PAGES = 10;

/**
 * How deep {@link KoiosTallyInputs.decidingSlotPass} reads a batch whose page
 * settled nothing — which can only mean every row on it shares one slot. Any
 * other page narrows the batch instead, so this bounds how long a single
 * block's certificate list may be, not how much history an account may have.
 */
const MAX_DECIDING_PAGES = 20;

interface AccountUpdateRow {
  stake_address: string;
  action_type: string;
  absolute_slot: number;
  epoch_no: number;
  /** Carrying transaction — the key for resolving same-slot chain order. */
  tx_hash: string;
}

/** A certificate as returned by `/tx_info` with `_certs:true`. */
interface TxCert {
  /** e.g. `stake_registration`, `stake_deregistration`, `pool_delegation`. */
  type: string;
  /** Position of this cert within the tx — the within-slot tiebreak. */
  index: number;
  info: { stake_address?: string | null } | null;
}

interface TxInfoRow {
  tx_hash: string;
  /** Position of the tx within its block; null if Koios can't serve it. */
  tx_block_index: number | null;
  /** Present only with `_certs:true`; null/absent if Koios can't serve it. */
  certificates: TxCert[] | null;
}

/** A conflicting tx's chain-order key: its block position + its certs. */
interface TxCertOrder {
  blockIndex: number;
  certs: TxCert[];
}

interface AccountStakeRow {
  stake_address: string;
  epoch_no: number;
  active_stake: string | number | bigint;
}

interface DrepPowerRow {
  drep_id: string;
  epoch_no: number;
  amount: string | number | bigint;
}

interface PoolSnapshotRow {
  /** The epoch the snapshot serves: `Mark` is Koios's current epoch + 1. */
  epoch_no: number;
  /** The snapshot's total active stake, over every pool. */
  active_stake: string | number | bigint;
}

interface DrepUpdateRow {
  drep_id: string;
  /** Wall clock of the carrying block — the endpoint has no epoch column. */
  block_time: number;
  /** `registered` | `deregistered` (`updated` is filtered out server-side). */
  action: string;
}

export class KoiosTallyInputs implements TallyInputSource, ElectorateTotals {
  /** End epochs {@link readable} has passed: once whole, a snapshot stays so. */
  private readonly readableEpochs = new Set<number>();

  /**
   * `onRequest` fires once per Koios HTTP request (each `postAll` page counts
   * individually) — the serving tier counts calls per refresh.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly getToken: () => string | undefined = () =>
      config.koiosToken,
    private readonly onRequest?: () => void,
  ) {}

  private headers(extra?: Record<string, string>): HeadersInit {
    const h: Record<string, string> = { ...extra };
    const token = this.getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    return koiosFetchJson<T>(
      this.config.koiosUrl + path,
      { headers: this.headers() },
      { label: path, onRequest: this.onRequest },
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return koiosFetchJson<T>(
      this.config.koiosUrl + path,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
      { label: path, onRequest: this.onRequest },
    );
  }

  /**
   * POST an RPC endpoint, following `offset` pages until a short one — so a
   * result set larger than Koios's single-response cap is fully read instead of
   * silently truncated. `path` already carries its filter query string.
   *
   * The caller MUST include a **total** `order=` (a unique key) in `path`:
   * PostgREST gives no stable ordering without one, so `limit/offset` pages over
   * an unordered set can shuffle rows across page boundaries between the
   * successive requests, silently dropping or duplicating rows (finding 2). A
   * partial order (ties) has the same failure whenever a tie-group straddles a
   * page boundary — so order down to a uniquely-identifying column.
   */
  private async postAll<T>(path: string, body: unknown): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const all: T[] = [];
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(
          `Koios POST ${path} exceeded ${MAX_PAGES} pages — offset likely ignored`,
        );
      }
      const rows = await this.post<T[]>(
        `${path}${sep}limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`,
        body,
      );
      all.push(...rows);
      if (rows.length < PAGE_LIMIT) break; // short page → exhausted
    }
    return all;
  }

  /**
   * Rows at each address's deciding slot — the newest slot it has an event in,
   * the only one that can settle registration at `epoch`, since every earlier
   * event is overridden. An address absent from the result has no events at all
   * and so was never registered.
   *
   * Cost tracks the batch's deciding slots, not its accounts' histories: the
   * read is newest-first and stops at the first page that settles anything, so
   * an account with a lifetime of registration churn is no dearer than one with
   * a single registration. Whatever that page left unsettled is re-asked as a
   * narrower batch — the churny account settles first (its own newest slot
   * heads its own history), so it drops out of the query and stops crowding out
   * the rest.
   */
  private async decidingEvents(
    epoch: number,
    addresses: readonly string[],
  ): Promise<Map<string, AccountUpdateRow[]>> {
    const out = new Map<string, AccountUpdateRow[]>();
    const queue: string[][] = [[...addresses]];
    while (queue.length > 0) {
      const batch = queue.pop()!;
      const { deciding, unsettled } = await this.decidingSlotPass(epoch, batch);
      const pending = new Set(unsettled);
      for (const [address, rows] of deciding) {
        if (!pending.has(address)) out.set(address, rows);
      }
      if (unsettled.length === 0) continue;
      if (unsettled.length < batch.length) {
        queue.push([...unsettled]);
      } else if (batch.length > 1) {
        // Nothing settled, and the pass already paged as deep as it may: every
        // row it read shares one slot, so only a narrower batch shortens it.
        const mid = Math.ceil(batch.length / 2);
        queue.push(batch.slice(0, mid), batch.slice(mid));
      } else {
        throw new Error(
          `account_update_history: ${batch[0]} has more than ` +
            `${MAX_DECIDING_PAGES * PAGE_LIMIT} events in its deciding slot`,
        );
      }
    }
    return out;
  }

  /**
   * One newest-first pass over `addresses`: collects each address's rows at its
   * highest slot and reports the ones it couldn't settle. An address is settled
   * once the descending cursor drops below its highest slot — no later row can
   * join that slot — or once the result set runs out, which settles the whole
   * batch at once.
   *
   * Returns as soon as a page settles anything, so the caller re-asks about the
   * remainder from `offset=0` rather than paying for the settled accounts'
   * older history. A page that settles *nothing* is the one case narrowing
   * can't improve on: the top row's account would otherwise be settled, so
   * every row shares one slot and only a deeper page can reach its end.
   *
   * The early stop trusts `order=absolute_slot.desc`, so each row is checked
   * against the cursor: a Koios that ignored the ordering fails loudly instead
   * of having a truncated history frozen into a hashed artifact.
   */
  private async decidingSlotPass(
    epoch: number,
    addresses: readonly string[],
  ): Promise<{
    deciding: Map<string, AccountUpdateRow[]>;
    unsettled: readonly string[];
  }> {
    const deciding = new Map<string, AccountUpdateRow[]>();
    const highest = new Map<string, number>();
    let cursor = Number.POSITIVE_INFINITY;
    for (let page = 0; page < MAX_DECIDING_PAGES; page++) {
      const rows = await this.post<AccountUpdateRow[]>(
        `/account_update_history?epoch_no=lte.${epoch}` +
          // Only registration/deregistration change the state we care about;
          // delegations and withdrawals imply-but-don't-change registration.
          // Filtering them server-side keeps a long-lived account's deciding
          // slot from sharing the page with its own irrelevant history.
          `&action_type=in.(registration,deregistration)` +
          `&select=stake_address,action_type,absolute_slot,epoch_no,tx_hash` +
          // Newest first, then a tiebreak deep enough that PostgREST can only
          // shuffle rows this reader can't tell apart. Rows still tie when one
          // tx carries two certs of the same type for the same account, but
          // those agree on every field below — and, being same-slot, can move
          // across a page boundary without perturbing the cursor.
          `&order=absolute_slot.desc,stake_address.asc,tx_hash.asc,action_type.asc` +
          `&limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`,
        { _stake_addresses: addresses },
      );
      for (const row of rows) {
        if (row.absolute_slot > cursor) {
          throw new Error(
            "account_update_history rows are not in descending slot order",
          );
        }
        cursor = row.absolute_slot;
        const known = highest.get(row.stake_address);
        if (known === undefined) {
          highest.set(row.stake_address, row.absolute_slot);
          deciding.set(row.stake_address, [row]);
        } else if (row.absolute_slot === known) {
          deciding.get(row.stake_address)!.push(row);
        }
      }
      if (rows.length < PAGE_LIMIT) return { deciding, unsettled: [] };
      // An address with no row yet sits below everything read so far, so it is
      // unsettled too — its deciding slot may still be further down.
      const unsettled = addresses.filter(
        (a) => (highest.get(a) ?? Number.NEGATIVE_INFINITY) <= cursor,
      );
      if (unsettled.length < addresses.length) return { deciding, unsettled };
    }
    return { deciding, unsettled: addresses };
  }

  /**
   * Chain-order key per tx (block position + certificate list) via `/tx_info`
   * with `_certs:true` — how a same-slot registration conflict is resolved to
   * the ledger's true verdict. A tx whose block index or certs Koios can't serve
   * is simply absent from the map; {@link resolveConflict} then throws (retry)
   * rather than resolve without it. A failed request propagates for the same
   * reason.
   */
  private async certOrder(
    txHashes: readonly string[],
  ): Promise<Map<string, TxCertOrder>> {
    const byHash = new Map<string, TxCertOrder>();
    for (let i = 0; i < txHashes.length; i += TX_INFO_BATCH) {
      const rows = await this.post<TxInfoRow[]>(
        "/tx_info?select=tx_hash,tx_block_index,certificates",
        { _tx_hashes: txHashes.slice(i, i + TX_INFO_BATCH), _certs: true },
      );
      for (const r of rows) {
        if (r.tx_block_index !== null && Array.isArray(r.certificates)) {
          byHash.set(r.tx_hash, {
            blockIndex: r.tx_block_index,
            certs: r.certificates,
          });
        }
      }
    }
    return byHash;
  }

  /**
   * Resolve a same-slot registration conflict — a deregistration and a
   * registration both landing in the account's deciding slot — to the ledger's
   * verdict. Collects every stake reg/dereg cert for `address` across the
   * conflicting txs, orders them by `(tx_block_index, cert_index)` (exactly the
   * ledger's within-slot certificate application order), and returns whether the
   * *last* one leaves the credential registered.
   *
   * Fail-closed: throws (→ retry, never a guess frozen into the hashed artifact)
   * if a conflicting tx's block index / certs are unavailable, or if the certs
   * don't corroborate both the registration and the deregistration that
   * `account_update_history` reported (a classification or data gap).
   */
  private resolveConflict(
    address: string,
    deciding: readonly AccountUpdateRow[],
    txOrder: Map<string, TxCertOrder>,
  ): boolean {
    const relevant: {
      blockIndex: number;
      certIndex: number;
      registered: boolean;
    }[] = [];
    for (const tx of new Set(deciding.map((e) => e.tx_hash))) {
      const info = txOrder.get(tx);
      if (!info) {
        throw new Error(`tx_info unavailable for ${tx} — retry next refresh`);
      }
      for (const c of info.certs) {
        if (c.info?.stake_address !== address) continue;
        const isReg = REGISTRATION_CERT_TYPES.has(c.type);
        const isDereg = DEREGISTRATION_CERT_TYPES.has(c.type);
        if (!isReg && !isDereg) continue; // delegation/gov cert — irrelevant
        relevant.push({
          blockIndex: info.blockIndex,
          certIndex: c.index,
          registered: isReg,
        });
      }
    }
    if (
      !relevant.some((c) => c.registered) ||
      !relevant.some((c) => !c.registered)
    ) {
      throw new Error(
        `same-slot certs for ${address} don't corroborate account_update_history — retry`,
      );
    }
    relevant.sort(
      (a, b) => a.blockIndex - b.blockIndex || a.certIndex - b.certIndex,
    );
    return relevant[relevant.length - 1]!.registered;
  }

  async stakeholderWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    await this.readable(epoch);
    // Pair each credential with its bech32 reward address (the form every
    // account endpoint keys on).
    const byAddress = new Map<string, string>(); // address → credentialKey
    for (const cred of credentials) {
      byAddress.set(
        evolutionCodec.stakeAddress(cred, this.config.network),
        credentialKey(cred),
      );
    }
    const addresses = [...byAddress.keys()];

    const registered = new Set<string>(); // registered at `epoch`'s end
    const stakeByAddress = new Map<string, bigint>();
    for (let i = 0; i < addresses.length; i += CREDENTIAL_BATCH) {
      const batch = addresses.slice(i, i + CREDENTIAL_BATCH);
      // A credential is registered at E's end iff the last state-changing cert
      // in chain order (≤ E) is not a deregistration. One slot holds at most one
      // block (Praos), so only the account's deciding (newest) slot matters —
      // earlier slots are overridden, and the read below never fetches them.
      // The only case that needs more than the deciding slot's event types is a
      // same-slot *mix* of a registration and a deregistration, resolved further
      // down to true chain order via the certificate indices.
      const [decidingByAddress, stakes] = await Promise.all([
        this.decidingEvents(epoch, batch),
        this.postAll<AccountStakeRow>(
          `/account_stake_history?epoch_no=eq.${epoch + 2}` +
            `&select=stake_address,epoch_no,active_stake` +
            // Epoch is fixed, so one row per account — `stake_address` is a total
            // order (this never actually paginates, but the contract holds).
            `&order=stake_address.asc`,
          { _stake_addresses: batch },
        ),
      ]);

      const conflictTxs = new Set<string>();
      for (const deciding of decidingByAddress.values()) {
        const hasDereg = deciding.some(
          (e) => e.action_type === "deregistration",
        );
        const hasReg = deciding.some((e) => e.action_type !== "deregistration");
        if (hasDereg && hasReg) {
          for (const e of deciding) conflictTxs.add(e.tx_hash);
        }
      }
      // Only same-slot conflicts need the certificate order; the common case
      // (a clean max slot) reads no `/tx_info` at all.
      const txOrder = conflictTxs.size
        ? await this.certOrder([...conflictTxs])
        : new Map<string, TxCertOrder>();

      for (const [address, deciding] of decidingByAddress) {
        const hasDereg = deciding.some(
          (e) => e.action_type === "deregistration",
        );
        const hasReg = deciding.some((e) => e.action_type !== "deregistration");
        // No deregistration in the deciding slot → registered (a registration or
        // delegation is the last cert). All deregistration → not registered.
        // Both → order the actual certs to see which one applied last.
        const isRegistered =
          !hasDereg ||
          (hasReg && this.resolveConflict(address, deciding, txOrder));
        if (isRegistered) registered.add(address);
      }

      for (const row of stakes) {
        stakeByAddress.set(
          row.stake_address,
          natural(row.active_stake, "account_stake_history.active_stake"),
        );
      }
    }

    const out = new Map<string, WeightInfo>();
    for (const [address, credKey] of byAddress) {
      const isRegistered = registered.has(address);
      out.set(credKey, {
        registered: isRegistered,
        // No stake row for a registered account = registered-but-empty → 0.
        weight: isRegistered ? (stakeByAddress.get(address) ?? 0n) : 0n,
      });
    }
    return out;
  }

  /**
   * Unix time `epoch` ends at. `/drep_updates` timestamps its events in wall
   * clock and offers no epoch filter, so the registration read below needs the
   * boundary as a time. Throws when Koios can't serve it: the epoch's surveys
   * postpone to the next pass rather than have membership decided against a
   * guessed boundary and frozen into a hashed artifact.
   */
  private async epochEndTime(epoch: number): Promise<number> {
    const rows = await this.get<{ end_time: number | null }[]>(
      `/epoch_info?_epoch_no=${epoch}&_include_next_epoch=false&select=end_time`,
    );
    const endTime = rows[0]?.end_time;
    if (typeof endTime !== "number") {
      throw new Error(
        `epoch_info serves no end_time for epoch ${epoch} — retry`,
      );
    }
    return endTime;
  }

  /**
   * Which of `ids` were registered DReps at the end of `epoch` — asked only
   * about ids the voting-power read said nothing about, so a survey whose
   * responders all have delegators pays nothing for this.
   *
   * The newest event decides and the read is newest-first, so an id's first row
   * is its deciding one; the pass stops once every id has one and the cursor has
   * dropped below all of them (a later page can still add to the newest block a
   * row shares). An id with no row at all never registered by the boundary.
   */
  private async drepRegistrations(
    epoch: number,
    ids: readonly string[],
  ): Promise<Set<string>> {
    const endTime = await this.epochEndTime(epoch);
    const registered = new Set<string>();
    for (let i = 0; i < ids.length; i += CREDENTIAL_BATCH) {
      const batch = ids.slice(i, i + CREDENTIAL_BATCH);
      const decidingTime = new Map<string, number>();
      const decidingActions = new Map<string, Set<string>>();
      let cursor = Number.POSITIVE_INFINITY;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) {
          throw new Error(
            `drep_updates: ${batch.length} id(s) unsettled after ` +
              `${MAX_PAGES} pages at epoch ${epoch}`,
          );
        }
        const rows = await this.get<DrepUpdateRow[]>(
          `/drep_updates?drep_id=in.(${batch.join(",")})` +
            `&block_time=lte.${endTime}` +
            `&action=in.(registered,deregistered)` +
            `&select=drep_id,block_time,action` +
            // Newest first, then a tiebreak deep enough that PostgREST can only
            // shuffle rows this reader can't tell apart — two rows agreeing on
            // all three columns decide the same way.
            `&order=block_time.desc,drep_id.asc,action.asc` +
            `&limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`,
        );
        for (const row of rows) {
          if (row.block_time > cursor) {
            throw new Error(
              "drep_updates rows are not in descending block_time order",
            );
          }
          cursor = row.block_time;
          const known = decidingTime.get(row.drep_id);
          if (known === undefined) {
            decidingTime.set(row.drep_id, row.block_time);
            decidingActions.set(row.drep_id, new Set([row.action]));
          } else if (known === row.block_time) {
            decidingActions.get(row.drep_id)!.add(row.action);
          }
        }
        if (rows.length < PAGE_LIMIT) break; // short page → exhausted
        if (
          decidingTime.size === batch.length &&
          cursor < Math.min(...decidingTime.values())
        ) {
          break;
        }
      }
      for (const id of batch) {
        const actions = decidingActions.get(id);
        if (!actions) continue; // no event by the boundary → never registered
        if (actions.size > 1) {
          // Registration and deregistration in one block: `/drep_updates`
          // exposes no within-block order to read the ledger's verdict from,
          // and a guess here would be immutable. Postpone instead.
          throw new Error(
            `drep_updates: ${id} registers and deregisters at ` +
              `${decidingTime.get(id)} — no within-block order to resolve it`,
          );
        }
        if (actions.has("registered")) registered.add(id);
      }
    }
    return registered;
  }

  async drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    await this.readable(epoch);
    // Pair each credential with its CIP-129 id (the form the endpoint keys on).
    const byId = new Map<string, string>(); // drep id → credentialKey
    for (const cred of credentials) {
      byId.set(evolutionCodec.drepId(cred), credentialKey(cred));
    }
    const ids = [...byId.keys()];

    const powerById = new Map<string, bigint>();
    for (let i = 0; i < ids.length; i += CREDENTIAL_BATCH) {
      const batch = ids.slice(i, i + CREDENTIAL_BATCH);
      const rows = await this.get<DrepPowerRow[]>(
        `/drep_voting_power_history?_epoch_no=${epoch + 1}&epoch_no=eq.${epoch + 1}` +
          `&drep_id=in.(${batch.join(",")})`,
      );
      for (const row of rows) {
        powerById.set(
          row.drep_id,
          natural(row.amount, "drep_voting_power_history.amount"),
        );
      }
    }

    // A power row proves registration and carries the weight. The ids it left
    // out are either unregistered or registered with nothing delegated to them
    // — worth 0 either way, but only the second counts (TALLY-SPEC.md §1) — so
    // they take a second, registration-only read.
    const absent = ids.filter((id) => !powerById.has(id));
    const registered =
      absent.length > 0
        ? await this.drepRegistrations(epoch, absent)
        : new Set<string>();

    const out = new Map<string, WeightInfo>();
    for (const [id, credKey] of byId) {
      const power = powerById.get(id);
      out.set(
        credKey,
        power !== undefined
          ? { registered: true, weight: power }
          : { registered: registered.has(id), weight: 0n },
      );
    }
    return out;
  }

  async stakeholderTotal(epoch: number): Promise<bigint | null> {
    try {
      await this.readable(epoch);
      const mark = epoch + 2;
      const rows = await this.get<
        { active_stake: string | number | bigint | null }[]
      >(
        `/epoch_info?_epoch_no=${mark}&_include_next_epoch=false&select=active_stake`,
      );
      const total =
        rows[0]?.active_stake ??
        // `/epoch_info` has no row for an epoch not begun yet; the pool
        // snapshot reads the same stake cache.
        (await this.poolSnapshots()).find((r) => r.epoch_no === mark)
          ?.active_stake ??
        null;
      return total === null ? null : natural(total, "epoch_info.active_stake");
    } catch (err) {
      // Not readable yet, or known flaky on some (preview) epochs: db-sync
      // word128 errors. Null = the caller retries on a later run.
      console.warn(`stake total unavailable for ${epoch}: ${String(err)}`);
      return null;
    }
  }

  async drepTotal(epoch: number): Promise<bigint | null> {
    try {
      await this.readable(epoch);
      const rows = await this.get<
        { amount: string | number | bigint | null }[]
      >(`/drep_epoch_summary?_epoch_no=${epoch + 1}&select=amount`);
      const total = rows[0]?.amount ?? null;
      return total === null
        ? null
        : natural(total, "drep_epoch_summary.amount");
    } catch (err) {
      console.warn(
        `drep_epoch_summary total unavailable for ${epoch}: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * Throws until the ledger at the end of `epoch` can be read whole: the
   * margin past `epoch + 1`'s start has run, and Koios's stake cache holds
   * the mark (`epoch + 2`). `/pool_stake_snapshot` serves that cache for its
   * current epoch ± 1, from any pool: the pool is only a join key, and the
   * row exists once db-sync has written the whole snapshot, not the pool's
   * share of it. From `epoch + 3` on, the mark was complete long ago, and
   * from `epoch + 4` no pool serves it.
   */
  private async readable(epoch: number): Promise<void> {
    if (this.readableEpochs.has(epoch)) return;
    const from = (await this.epochEndTime(epoch)) + SETTLING_MARGIN_SECONDS;
    if (Date.now() / 1000 < from) {
      throw new Error(
        `the end of epoch ${epoch} is read from ${new Date(from * 1000).toISOString()}, ` +
          "once every Koios instance has written it",
      );
    }
    const [tip] = await this.get<{ epoch_no: number }[]>(
      "/tip?select=epoch_no",
    );
    if (tip === undefined) throw new Error("Koios serves no tip");
    if (
      tip.epoch_no < epoch + 3 &&
      !(await this.poolSnapshots()).some((r) => r.epoch_no === epoch + 2)
    ) {
      throw new Error(
        `Koios has not finished writing the stake snapshot taken at the end of epoch ${epoch}`,
      );
    }
    this.readableEpochs.add(epoch);
  }

  /** The snapshots Koios's stake cache serves now, through any active pool. */
  private async poolSnapshots(): Promise<PoolSnapshotRow[]> {
    // `active_stake` orders as text, so "the largest pool" is not askable:
    // any pool standing with stake does.
    const [pool] = await this.get<{ pool_id_bech32: string }[]>(
      "/pool_list?pool_status=eq.registered&active_stake=not.is.null" +
        "&retiring_epoch=is.null&select=pool_id_bech32&limit=1",
    );
    if (pool === undefined) throw new Error("pool_list serves no active pool");
    return this.get<PoolSnapshotRow[]>(
      `/pool_stake_snapshot?_pool_bech32=${pool.pool_id_bech32}&select=epoch_no,active_stake`,
    );
  }
}
