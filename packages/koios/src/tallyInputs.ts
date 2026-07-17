/**
 * Koios-backed {@link TallyInputSource}: role membership + weights at a
 * survey's `end_epoch` (ARCHITECTURE.md §6.1/§6.5).
 *
 * Stakeholders (role 3) resolve in two bulk reads per 50-credential chunk:
 *  - `/account_update_history?epoch_no=lte.E&action_type=in.(registration,
 *    deregistration)` — registration state. Only registration/deregistration
 *    change it (delegations/withdrawals merely imply registration), so we filter
 *    to those two server-side; a credential is registered at E iff the last
 *    event in chain order (up to E) is not a deregistration. Chain order is
 *    `(absolute_slot, tx_block_index, cert_index)`, and only the account's max
 *    slot can decide (earlier slots are overridden). When that slot holds both a
 *    registration and a deregistration — in different txs *or* the same tx — we
 *    read those txs' `/tx_info` certificates (`_certs`) and take the last cert by
 *    `(tx_block_index, cert_index)`, exactly the ledger's within-slot
 *    certificate application order, so the verdict matches the chain with no
 *    convention. The common case (no same-slot reg/dereg mix) needs no
 *    `/tx_info` read. Still offset-paginated (a churny account can
 *    register/deregister many times) so a long history is never silently
 *    truncated at Koios's ~1000 cap.
 *  - `/account_stake_history?epoch_no=eq.E` — active stake. One row per
 *    account *delegated to a pool* at E; a registered account with no row
 *    counts with weight 0 (§6.1 "registered but empty").
 *
 * DReps (role 0) resolve per credential (small-N by nature):
 *  - `/drep_voting_power_history?_drep_id=…&epoch_no=eq.E` — a row iff the
 *    DRep was registered at E, carrying its voting power. (The endpoint's own
 *    `_epoch_no` parameter misbehaves for current epochs — the PostgREST
 *    column filter is the reliable form, verified live.)
 *
 * Totals come from `/epoch_info` (known to fail with db-sync word128 errors on
 * some preview epochs — hence null-means-retry) and `/drep_epoch_summary`.
 */

import type { Credential } from "cip-179";

import { credentialKey } from "cip-179/domain";
import type { TallyInputSource, WeightInfo } from "cip-179/tally";
import type { AppConfig } from "@tessera/core";

import { evolutionCodec } from "cip-179/evolution";

import { koiosFetchJson } from "./http";

/** Max stake addresses per bulk POST (matches the other Koios batch sizes). */
const ACCOUNT_BATCH = 50;

/**
 * Rows per page when following an unbounded Koios result set. Koios caps a
 * single response at ~1000 rows, so any read that can exceed that (notably
 * `account_update_history` over `lte.E`, which returns *every* lifecycle event
 * for the batch) must offset-paginate or it silently truncates.
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
 * Runaway guard for `postAll`: only trips if Koios ignores our `offset` (which
 * would loop forever). A million rows for 50 accounts is already absurd, so
 * hitting this means something is wrong — fail loudly rather than truncate.
 */
const MAX_ACCOUNT_PAGES = 50;

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
  /** Lovelace as a decimal string. */
  active_stake: string;
}

interface DrepPowerRow {
  drep_id: string;
  epoch_no: number;
  /** Lovelace as a decimal string. */
  amount: string;
}

export class KoiosTallyInputs implements TallyInputSource {
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
      if (page >= MAX_ACCOUNT_PAGES) {
        throw new Error(
          `Koios POST ${path} exceeded ${MAX_ACCOUNT_PAGES} pages — offset likely ignored`,
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

    const registered = new Set<string>(); // addresses registered at `epoch`
    const stakeByAddress = new Map<string, bigint>();
    for (let i = 0; i < addresses.length; i += ACCOUNT_BATCH) {
      const batch = addresses.slice(i, i + ACCOUNT_BATCH);
      // Both reads offset-paginate: `account_update_history` over `lte.E`
      // returns every lifecycle event for the batch and readily exceeds Koios's
      // ~1000-row cap on long-lived accounts; losing a row (e.g. a final
      // deregistration) would corrupt registration state in the hashed artifact.
      // Each carries a *total* `order=` so pagination is stable across pages —
      // without it PostgREST may shuffle rows between requests and drop or
      // duplicate one at a page boundary (finding 2). Direction is irrelevant to
      // the result (the walk re-derives chain order); only the total order matters.
      const [updates, stakes] = await Promise.all([
        this.postAll<AccountUpdateRow>(
          `/account_update_history?epoch_no=lte.${epoch}` +
            // Only registration/deregistration change the state we care about;
            // delegations and withdrawals imply-but-don't-change registration.
            // Filtering them server-side collapses a long-lived account's event
            // history from thousands of rows to a handful, so pagination rarely
            // trips at all (the walk below still tolerates any type defensively).
            `&action_type=in.(registration,deregistration)` +
            `&select=stake_address,action_type,absolute_slot,epoch_no,tx_hash` +
            // Total order for stable pagination (`absolute_slot` alone ties).
            `&order=absolute_slot.asc,stake_address.asc,tx_hash.asc,action_type.asc`,
          { _stake_addresses: batch },
        ),
        this.postAll<AccountStakeRow>(
          `/account_stake_history?epoch_no=eq.${epoch}` +
            `&select=stake_address,epoch_no,active_stake` +
            // Epoch is fixed, so one row per account — `stake_address` is a total
            // order (this never actually paginates, but the contract holds).
            `&order=stake_address.asc`,
          { _stake_addresses: batch },
        ),
      ]);

      const eventsByAddress = new Map<string, AccountUpdateRow[]>();
      for (const row of updates) {
        let list = eventsByAddress.get(row.stake_address);
        if (!list) eventsByAddress.set(row.stake_address, (list = []));
        list.push(row);
      }

      // A credential is registered at E iff the last state-changing cert in
      // chain order (≤ E) is not a deregistration. One slot holds at most one
      // block (Praos), so only the account's max slot can decide — earlier slots
      // are overridden. The only case that needs more than the max-slot event
      // types is a same-slot *mix* of a registration and a deregistration; that
      // is resolved below to true chain order via the certificate indices.
      const decidingByAddress = new Map<string, AccountUpdateRow[]>();
      const conflictTxs = new Set<string>();
      for (const [address, events] of eventsByAddress) {
        const maxSlot = events.reduce(
          (m, e) => Math.max(m, e.absolute_slot),
          0,
        );
        const deciding = events.filter((e) => e.absolute_slot === maxSlot);
        decidingByAddress.set(address, deciding);
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
        stakeByAddress.set(row.stake_address, BigInt(row.active_stake));
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

  async drepWeights(
    epoch: number,
    credentials: readonly Credential[],
  ): Promise<Map<string, WeightInfo>> {
    const out = new Map<string, WeightInfo>();
    for (const cred of credentials) {
      const id = evolutionCodec.drepId(cred);
      const rows = await this.get<DrepPowerRow[]>(
        `/drep_voting_power_history?_drep_id=${id}&epoch_no=eq.${epoch}`,
      );
      const row = rows[0];
      out.set(
        credentialKey(cred),
        row
          ? { registered: true, weight: BigInt(row.amount) }
          : { registered: false, weight: 0n },
      );
    }
    return out;
  }

  async stakeholderTotal(epoch: number): Promise<bigint | null> {
    try {
      const rows = await this.get<{ active_stake: string | null }[]>(
        `/epoch_info?_epoch_no=${epoch}&_include_next_epoch=false&select=active_stake`,
      );
      const total = rows[0]?.active_stake;
      return total ? BigInt(total) : null;
    } catch (err) {
      // Known flaky on some (preview) epochs: db-sync word128 errors. Null =
      // the caller retries on a later run.
      console.warn(`epoch_info total unavailable for ${epoch}: ${String(err)}`);
      return null;
    }
  }

  async drepTotal(epoch: number): Promise<bigint | null> {
    try {
      const rows = await this.get<{ amount: string | null }[]>(
        `/drep_epoch_summary?_epoch_no=${epoch}&select=amount`,
      );
      const total = rows[0]?.amount;
      return total ? BigInt(total) : null;
    } catch (err) {
      console.warn(
        `drep_epoch_summary total unavailable for ${epoch}: ${String(err)}`,
      );
      return null;
    }
  }
}
