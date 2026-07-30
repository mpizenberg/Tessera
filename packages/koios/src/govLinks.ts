/**
 * Governance-link discovery: from an on-chain proposal to the survey it links.
 *
 * A Conway proposal commits to its metadata document by hash (`meta_url` +
 * `meta_hash`), and CIP-179 puts the survey link inside that document. So a
 * reader has two ways to learn whether an action links a survey: trust an
 * indexer's own off-chain resolution of the anchor, or **fetch the document and
 * check it against the on-chain hash**. This module does the second. It is
 * strictly stronger evidence — a parsed JSON blob handed over by an indexer can
 * never be re-verified against the hash it came from — and it also reaches
 * anchors an indexer's fetcher gave up on long ago.
 *
 * Classification is keyed by **anchor hash**, not by action: hash-fixed content
 * classifies the same way forever, whoever points at it, so one verified fetch
 * answers for every proposal sharing that document, permanently. What the
 * document cannot say is which action carries it or when that action expires —
 * that is the proposal's own on-chain identity, joined back in {@link govLinkOf}.
 *
 * A fetch *failure* is not a negative verdict: the URL may come alive, IPFS
 * content may propagate. It stays out of the answer as *unresolved* (finding 6),
 * and the caller decides how long to keep asking.
 */

import type { ContentAnchor } from "cip-179";
import { fetchAnchorJson, type AnchorFetchOptions } from "cip-179/content";
import { hexToBytes, parseGovLinkDoc } from "cip-179/domain";
import type {
  GovLink,
  GovLinkDoc,
  GovLinkScan,
  UnresolvedGovAction,
} from "cip-179/domain";

import { mapSettled } from "./http";

/**
 * Anchors fetched at once. Unlike the Koios batches this is fan-out across
 * unrelated third-party hosts, so the cap is about our own egress and the
 * subrequest budget rather than one endpoint's rate limiter — and a single
 * `ipfs://` attempt can itself fan out to several gateways.
 */
const ANCHOR_CONCURRENCY = 6;

/** One row of the proposal scan (`/proposal_list`), all of it on-chain. */
export interface ProposalRow {
  proposal_id: string;
  /**
   * Koios's `expiration` epoch: the epoch in which the action *drops out* of the
   * proposal set. This is one PAST the action's last active epoch — the ledger's
   * `gasExpiresAfter = proposed_epoch + gov_action_lifetime` is the last epoch the
   * action is still votable, and Koios reports `gasExpiresAfter + 1` here. So the
   * action's expiry epoch (what CIP-179 aligns against a survey's `end_epoch`)
   * is `expiration - 1`, applied in {@link govProposal}.
   *
   * Never null: an `expiration=in.(…)` list matches no NULL.
   */
  expiration: number;
  /** Anchor URI as recorded on-chain. */
  meta_url: string | null;
  /** blake2b-256 of the anchor document (hex), as recorded on-chain. */
  meta_hash: string | null;
}

/** A governance action that could carry a survey link, with the anchor to check. */
export interface GovProposal {
  /** Bech32 governance action id (CIP-129 `gov_action1…`). */
  readonly actionId: string;
  /** The action's expiry epoch — a survey it links must end here. */
  readonly endEpoch: number;
  readonly anchor: ContentAnchor;
  /** Lowercase hex of the anchor hash: the key a classification is banked under. */
  readonly anchorHash: string;
}

/** Anchor classifications by hash. A `null` value is a *verified* non-link. */
export type GovAnchorDocs = ReadonlyMap<string, GovLinkDoc | null>;

export interface ResolveAnchorsOptions extends AnchorFetchOptions {
  /**
   * Distinct anchors to attempt in this pass; defaults to all of them. A caller
   * on a subrequest budget spends part of it here and converges over later
   * passes, exactly as the tx-metadata cache does.
   */
  readonly limit?: number | undefined;
  /**
   * Where in the attempt order this pass starts; defaults to a random offset.
   * With a `limit` this matters for liveness, not fairness: failures are not
   * banked, so a fixed order would re-attempt the same dead anchors every pass
   * and never reach a live one queued behind them.
   */
  readonly rotate?: number | undefined;
  /** Fetch + verify + parse one anchor; injectable for tests. */
  readonly fetchDoc?: ((anchor: ContentAnchor) => Promise<unknown>) | undefined;
}

/**
 * A proposal row as a fetchable proposal, or `null` when its on-chain anchor is
 * unusable (absent, or a hash that isn't 32 bytes of hex). That is a *final*
 * "not a link", not an unknown: a survey link only counts when it comes out of a
 * document that verifies against the committed hash, and there is no hash here
 * any document could ever verify against.
 */
export function govProposal(row: ProposalRow): GovProposal | null {
  const uri = row.meta_url;
  const anchorHash = row.meta_hash?.toLowerCase();
  if (!uri || !anchorHash || !/^[0-9a-f]{64}$/.test(anchorHash)) return null;
  return {
    actionId: row.proposal_id,
    // Koios's `expiration` is the epoch the action drops out (one past its last
    // active epoch); the action's expiry epoch — what a linked survey's
    // `end_epoch` must equal — is `expiration - 1`. See ProposalRow.expiration.
    endEpoch: row.expiration - 1,
    anchor: { uri, hash: hexToBytes(anchorHash) },
    anchorHash,
  };
}

/**
 * Fetch, hash-verify and classify the distinct anchors behind `proposals`,
 * returning only the ones that resolved. An absent hash means "not resolved
 * this pass" — a failure is banked nowhere and decides nothing.
 */
export async function resolveGovAnchors(
  proposals: readonly GovProposal[],
  opts: ResolveAnchorsOptions = {},
): Promise<Map<string, GovLinkDoc | null>> {
  const fetchDoc = opts.fetchDoc ?? ((anchor) => fetchAnchorJson(anchor, opts));
  const anchors = new Map<string, ContentAnchor>();
  for (const p of proposals) {
    if (!anchors.has(p.anchorHash)) anchors.set(p.anchorHash, p.anchor);
  }
  const docs = new Map<string, GovLinkDoc | null>();
  if (anchors.size === 0) return docs;

  const hashes = [...anchors.keys()].sort();
  const rotate = opts.rotate ?? Math.floor(Math.random() * hashes.length);
  const start = ((rotate % hashes.length) + hashes.length) % hashes.length;
  const window = Array.from(
    { length: Math.min(opts.limit ?? hashes.length, hashes.length) },
    (_, i) => hashes[(start + i) % hashes.length]!,
  );

  const outcomes = await mapSettled(window, ANCHOR_CONCURRENCY, async (hash) =>
    parseGovLinkDoc(await fetchDoc(anchors.get(hash)!)),
  );
  outcomes.forEach((outcome, i) => {
    const hash = window[i]!;
    if (outcome.status === "fulfilled") docs.set(hash, outcome.value);
    else console.warn(`anchor ${hash} unresolved: ${String(outcome.reason)}`);
  });
  return docs;
}

/** The link an action carries, joining a document's classification to its identity. */
export function govLinkOf(proposal: GovProposal, doc: GovLinkDoc): GovLink {
  return {
    surveyKey: doc.surveyKey,
    actionId: proposal.actionId,
    endEpoch: proposal.endEpoch,
    title: doc.title,
  };
}

/**
 * What a set of proposals amounts to, given what is known about their anchors:
 * the links, and the actions still awaiting a readable document. An anchor
 * classified as a non-link belongs to neither — it is settled, not unknown.
 */
export function govLinkScan(
  proposals: readonly GovProposal[],
  docs: GovAnchorDocs,
): GovLinkScan {
  const links: GovLink[] = [];
  const unresolved: UnresolvedGovAction[] = [];
  for (const p of proposals) {
    if (!docs.has(p.anchorHash)) {
      unresolved.push({ actionId: p.actionId, endEpoch: p.endEpoch });
      continue;
    }
    const doc = docs.get(p.anchorHash);
    if (doc) links.push(govLinkOf(p, doc));
  }
  return { links, unresolved };
}
