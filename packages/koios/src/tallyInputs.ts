/**
 * Koios-backed {@link TallyInputSource}: role membership + weights at a
 * survey's `end_epoch` (ARCHITECTURE.md §6.1/§6.5).
 *
 * Stakeholders (role 3) resolve in two bulk reads per 50-credential chunk:
 *  - `/account_update_history?epoch_no=lte.E&action_type=in.(registration,
 *    deregistration)` — registration state. Only registration/deregistration
 *    change it (delegations/withdrawals merely imply registration), so we filter
 *    to those two server-side; a credential is registered at E iff, walking its
 *    events in `absolute_slot` order up to E, the last one is a registration.
 *    Still offset-paginated (a churny account can register/deregister many
 *    times) so a long history is never silently truncated at Koios's ~1000 cap.
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
 * Runaway guard for `postAll`: only trips if Koios ignores our `offset` (which
 * would loop forever). A million rows for 50 accounts is already absurd, so
 * hitting this means something is wrong — fail loudly rather than truncate.
 */
const MAX_ACCOUNT_PAGES = 50;

const REQUEST_TIMEOUT_MS = 15_000;

interface AccountUpdateRow {
  stake_address: string;
  action_type: string;
  absolute_slot: number;
  epoch_no: number;
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
    this.onRequest?.();
    const res = await fetch(this.config.koiosUrl + path, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Koios GET ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    this.onRequest?.();
    const res = await fetch(this.config.koiosUrl + path, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Koios POST ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  /**
   * POST an RPC endpoint, following `offset` pages until a short one — so a
   * result set larger than Koios's single-response cap is fully read instead of
   * silently truncated. `path` already carries its filter query string.
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
      const [updates, stakes] = await Promise.all([
        this.postAll<AccountUpdateRow>(
          `/account_update_history?epoch_no=lte.${epoch}` +
            // Only registration/deregistration change the state we care about;
            // delegations and withdrawals imply-but-don't-change registration.
            // Filtering them server-side collapses a long-lived account's event
            // history from thousands of rows to a handful, so pagination rarely
            // trips at all (the walk below still tolerates any type defensively).
            `&action_type=in.(registration,deregistration)` +
            `&select=stake_address,action_type,absolute_slot,epoch_no`,
          { _stake_addresses: batch },
        ),
        this.postAll<AccountStakeRow>(
          `/account_stake_history?epoch_no=eq.${epoch}` +
            `&select=stake_address,epoch_no,active_stake`,
          { _stake_addresses: batch },
        ),
      ]);

      // Walk each account's events in chain order; the last one wins.
      const eventsByAddress = new Map<string, AccountUpdateRow[]>();
      for (const row of updates) {
        let list = eventsByAddress.get(row.stake_address);
        if (!list) eventsByAddress.set(row.stake_address, (list = []));
        list.push(row);
      }
      for (const [address, events] of eventsByAddress) {
        events.sort((a, b) => a.absolute_slot - b.absolute_slot);
        let isRegistered = false;
        for (const e of events) {
          // A deregistration closes the account; a registration (re)opens it.
          // We only fetch those two types, but any other lifecycle event that
          // slipped through implies an active registration, so treat anything
          // that isn't a deregistration as registered.
          isRegistered = e.action_type !== "deregistration";
        }
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
