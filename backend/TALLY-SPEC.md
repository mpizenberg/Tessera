# Tessera tally specification — counting rules and artifact format

> **Audience:** anyone re-deriving a survey result independently — a second
> implementation, an auditor, or `packages/verifier`. This document is
> **provenance-agnostic**: it says what a correct result _is_, never who read the
> ledger to produce it. Which endpoints this deployment calls, and how it
> schedules the work, are in `ARCHITECTURE.md` §6.
>
> Everything here is load-bearing for the artifact hash. A change to any rule
> changes `rulesetHash` and makes new artifacts incomparable with old ones, so
> this document changes far more slowly than the system around it.

---

## 1. Roles, weights, membership

Tallies and weighting are **always per-role; never combined** (the same ada would
otherwise be double-counted across a holder's stakeholder stake, their DRep's
voting power, and their pool's stake).

| Role            | Weight measure                   | Membership gate                                        | Browser-producible?          |
| --------------- | -------------------------------- | ------------------------------------------------------ | ---------------------------- |
| **Stakeholder** | active ada stake at `end_epoch`  | stake address **registered** at `end_epoch`            | yes                          |
| **DRep**        | DRep voting power at `end_epoch` | DRep **registered** at `end_epoch`                     | yes                          |
| **SPO**         | pool active stake at `end_epoch` | pool registered at `end_epoch`                         | **no** (specified, deferred) |
| **Keyholder**   | **count-only** (weight = 1)      | credential proof (already on-chain, client-verifiable) | yes                          |
| **CC**          | **TODO**                         | **TODO**                                               | no                           |

- **Membership = registration.** A Stakeholder/DRep response whose credential is
  **not registered** at `end_epoch` is **excluded as invalid** (it is not a
  member). A registered credential is counted with `weight = snapshot value`,
  which **may legitimately be 0** (registered but empty). There is no separate
  "weight-0 vs excluded" ambiguity: registration is the gate, the snapshot value
  is the weight.
- **Keyholder is count-only.** It is rendered as its own per-role result with each
  response contributing weight 1 — i.e. the unweighted path. (Uniform with the
  weighted path by passing weight = 1; see §4.)
- **SPO** is fully specified but not exercised: `roles.ts` establishes that
  browser wallets cannot hold SPO/CC keys, so the app cannot generate SPO
  responses. Wiring stays ready for non-browser responders / Tier 2.

---

## 2. Epoch semantics (the load-bearing definition)

> **Weight = the `active_stake` / voting power for the survey's `end_epoch`.**

- This is the **deadline snapshot**, not response-time stake. A responder who
  held stake mid-survey but moved it before `end_epoch` is weighted at their
  `end_epoch` value (possibly 0). Deliberate, matching governance snapshot
  semantics. This rule string is part of `ruleset_hash` (§5).
- **Row-freeze timing.** Koios per-epoch history freezes epoch `E`'s row once
  epoch `E` _begins_ (the latest row, for the next epoch, is the live-evolving
  value until the boundary). Finalization runs **after `end_epoch` closes**, so
  `E`'s row is always frozen and available — no estimation needed.
- **Sealed surveys** use **deadline weights**: freeze the `end_epoch` weights at
  close; compute the tally later, after the drand reveal, re-validating decrypted
  answers (`audit.ts` already separates sealed handling). The artifact records
  deadline weights even though it is emitted at reveal time.

---

## 3. Validation → the hashed counted set

The hashed `tally` (§5) is a pure function of _which responses count_ and _their
answer values_, so the validation ruleset **is** part of the hash preimage: a
verifier reproduces the hash only by applying it byte-for-byte.

**The ruleset is data, and the data is the authority.** `RULESET_DESCRIPTOR`
(`packages/cip179/src/tally/artifact.ts`) is a canonical description of every
counting rule — the covered roles, what one unit of weight measures for each, and
one string per rule. `rulesetHash()` is its blake2b-256 and is embedded in every
tally body, so two artifacts hashed under different rules can never compare
equal. `rulesetVersion` is bumped on any semantic change and a golden test pins
the resulting hash; the bump is required even when the change lives inside
`validateResponse` or `dedupeResponses` rather than in the descriptor's text, and
those files carry a matching RULESET-PINNED-BEHAVIOR note. **Read the rules
there.** Restating them here would be a second definition with nothing pinning
it — what follows is only what the rule strings cannot say.

**Authoritative ≠ the browser's pass.** `audit.ts` runs a fast approximation for
the live UI — `epochOfSlot`-estimated deadlines, `(slot, txHash)` dedup — which is
_not_ authoritative for the artifact. The counted set is produced from ledger
facts instead: the block's authoritative `epoch_no` rather than a tip-relative
estimate, which can disagree at a boundary slot, and the full CIP-179 chain order
`(slot, tx_index_in_block, response_index)`, a total order with no ties. Those
last two are read-model fields the UI lacks, which is why its key is a display
approximation only.

Why three of the rules are shaped as they are:

- **Dedup runs over the tally-valid set**, not over all responses, so an invalid
  later response never suppresses a valid earlier one.
- **Membership is checked only at `end_epoch`** (§1). Response-time membership
  (CIP-179 phase 1) is presentation-only — a deliberate deviation.
- **Talliability gates the definition**, not only the responses. A survey whose
  on-chain definition fails semantic validation produces no artifact and is never
  counted, and the gate includes CIP-179's owner rule: the defining transaction
  must itself prove the `owner` credential. Without that, a definition could name
  any credential — a known DRep, a foundation — and be tallied under a borrowed
  name. A backend that tallies an untalliable survey diverges from a conformant
  verifier, which reaches the untalliable verdict independently.

**Validate early what can be validated early.** Everything except membership and
the weights is fixed once the response transaction is confirmed, well before
`end_epoch`: its block epoch, its witnesses and any native-script resolution, the
payload itself. The serving tier persists those verdicts incrementally as
responses land (`ARCHITECTURE.md` §5) rather than re-running them in a batch at
close, so finalization does only the boundary-bound work — otherwise epoch end is
a burst of transaction fetches, proof checking and CPU, and the Koios rate
limiting that invites. Dedup's ordering fields are known early too; only the final
winner can shift, since dedup runs over the membership-filtered set.

---

## 4. Weighted tally computation (`cip-179/tally`)

Weighting is the mechanical generalization of the existing tally: **replace
"count 1 per responder" with "add the responder's weight."**

- Input is the **validated, deduped** `counted` set (§3) — joined to each
  responder's `weight` from the snapshot. Count-only roles (Keyholder) pass
  **weight = 1**, so a single uniform code path covers weighted and unweighted
  roles.
- **All aggregates are BigInt.** Lovelace sums exceed 2^53.
  - singleChoice / multiSelect / ranking-first-preference → `Σ weight` per option.
  - numericRange / rating / pointsAllocation → store the **rational as two
    integers**: `Σ(weightᵢ · valueᵢ)` and `Σ weightᵢ`.
- **Per-question aggregates are sparse**: only options actually answered appear,
  each carrying its own `index`, and rating distributions carry only populated
  levels. A definition declares its own option count and rating span, so a dense
  body would be sized by a number a hostile survey chooses — the body grows with
  responses received, never with the width declared.
- **No floats anywhere in the result.** Averages, percentages, and participation
  rates are derived by the **presentation layer** from the integer aggregates +
  the totals. This eliminates float canonicalization and makes the artifact hash
  stable across implementations.
- The function is pure and identical in browser, serving tier, and verifier.

---

## 5. Artifact format

The unit of result publication and the Koios→node seam.

- **Canonical JSON**, content-addressed by hash. Pinned (implemented in
  `cip-179/tally`'s `canonical.ts`, shared by emitter and verifier):
  `canonicalJson()` is a strict JCS-lite — keys sorted by UTF-16 code units, no
  whitespace, **safe integers only** (throws on floats/bigints/non-plain
  objects) — and the hash is **blake2b-256** of its UTF-8 bytes (the hash
  family everything on Cardano already uses). The hash is the artifact's
  identity.
- **Large integers as decimal strings.** JSON-the-format has no precision limit,
  but (a) JavaScript's `JSON.parse` coerces to lossy doubles and `JSON.stringify`
  throws on BigInt, and (b) the JCS canonicalization profile only covers
  IEEE-754 doubles. So lovelace, weights, and all aggregates are **decimal
  strings**; this dodges both and removes any dependency on consumers using a
  lossless parser.
- **Integer-only aggregates, no floats** (§4).
- **Deterministic ordering** (e.g. responders sorted by credential hex; options
  in definition order) so independent re-serialization reproduces the hash.

**Hash domain.** The document splits into a hashed inner `tally` and an unhashed
`provenance` envelope; `artifactHash = H(canonical(tally))`. The split is
structural (not a field denylist). Ledger-determined facts that any correct
re-derivation must reproduce go in `tally`; whatever records who read the ledger,
how, and when goes in `provenance`.

- **`tally` (hashed):** `rulesetHash`, `network`, `survey`, `sealed` (true iff
  the definition's submission mode is sealed — set on cancellation artifacts
  too), and per role: `role`, `total`, `responders` (`credential`, `weight`, and
  the counted answer's full on-chain coordinate `txHash` + `responseIndex` —
  unregistered responders are excluded rather than flagged, so no `registered`
  field; **sealed** responders additionally carry `answers`, their revealed
  answers in JSON-safe wire form, since the on-chain response is only a
  ciphertext and can't be rejoined), integer `questions` aggregates.
- **`provenance` (not hashed):** `source`, snapshot `fetchedAt`, per-role
  `endpoint`, and — for a sealed survey — `sealedReveal` (`chainHash`, `round`,
  and the drand `beacon` used), unhashed because the definition already pins
  `(chainHash, round)` and the beacon is independently fetchable + BLS-verifiable.

Excluding provenance is what lets Koios- and node-produced artifacts share one
hash when results are identical — keeping the Tier 1 → Tier 2 swap invisible to
the verifier (`ARCHITECTURE.md` §2, §8).

Shape (the typed definition is `TallyArtifact` in `cip-179/tally`'s
`artifact.ts`):

```jsonc
{
  "tally": {
    "rulesetHash": "…",
    "network": "mainnet",
    "survey": { "txId": "…", "index": 0, "endEpoch": 642 },
    "sealed": false,
    "perRole": [
      {
        "role": 1,
        "total": "12345678901234",
        "responders": [
          {
            "credential": "…",
            "weight": "1000000000",
            "txHash": "…",
            "responseIndex": 0,
          },
        ],
        "questions": [],
      },
    ],
  },
  "provenance": {
    "source": {
      "provider": "koios",
      "baseUrl": "https://api.koios.rest/api/v1",
    },
    "fetchedAt": 0,
    "byRole": [{ "role": 1, "endpoint": "/account_stake_history" }],
  },
}
```

- **Immutable** once `end_epoch` is finalized. **Stored in the D1/SQLite
  `tally_artifact` table** (deliberate deviation from the original R2 sketch:
  artifacts are small JSON documents, the store already exists on both
  runtimes, and one storage system beats two at PoC scale — R2 remains an easy
  later move since rows are keyed by the same content hash). Served verbatim by
  the two artifact routes (`ARCHITECTURE.md` §5.1).
- The **frontend can pin the identical bytes to IPFS** (reusing
  `enrichment/pin.ts`) for durability / censorship-resistance; same bytes → same
  hash → same id.
- **Future:** the `tally` hash is the natural handle for an **on-chain anchor**,
  closing the loop with CIP-179 itself.
- **Verifiability.** The `tally` embeds the counted responders, their answers (or
  refs), weights, and totals, so any third party re-runs the pure `cip-179/tally`
  computation and reproduces both the results and the hash; every weight is re-fetchable
  from Koios at `end_epoch`. Trust reduces to Koios's stake numbers for epoch E,
  which the node tier later removes — without changing this format.
