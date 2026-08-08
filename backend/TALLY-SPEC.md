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
answer values_, so the validation ruleset **is** part of the hash preimage — a
verifier reproduces the hash only by applying it byte-for-byte, which is what
`rulesetHash` binds. This authoritative validation is distinct from the browser's
fast **approximate** pass (`audit.ts`: `epochOfSlot`-estimated deadline,
`(slot, txHash)` dedup) that drives the live UI but is _not_ authoritative for the
artifact; the serving tier produces the counted set below from ledger facts.

A response is **tally-valid** iff all of:

1. **On-time.** The response tx's block epoch ≤ `end_epoch` (inclusive, §2),
   read from the block's authoritative `epoch_no` (Koios) — _not_ the tip-relative
   `epochOfSlot` estimate, which can disagree at a boundary slot.
2. **Credential proof** (CIP-179 Mechanism A/B). Control of `credential` is proven
   by `required_signers` (field 14: key hash present, or native script resolved +
   satisfied) or by a `voting_procedures` entry binding it to `linked_action_id`.
   Unproven ⇒ excluded; without this the tally is forgeable (anyone could name
   another's credential). Needs the tx body + witnesses / native-script resolution
   (the `NativeScriptInfo` seam).
3. **Well-formed.** Passes `cip-179` `validateResponse` (mode, eligible-role claim,
   in-constraint answers, no duplicate/out-of-range indices, required answered).
   The **pinned validator version** is part of the ruleset.
4. **Member.** `credential` is **registered at `end_epoch`** (§1; inactive ⇒
   weight 0). Membership is checked **only** at `end_epoch` — response-time
   membership (CIP-179 phase 1) is presentation-only, a deliberate deviation.

**Dedup.** Among the tally-valid responses, one wins per
`(survey_ref, role, credential)` by CIP-179 chain order
**`(slot, tx_index_in_block, response_index)`** — a total order (no ties), latest
wins. Deduping over the _tally-valid_ set (not all responses) means an invalid
later response never suppresses a valid earlier one. This requires two read-model
fields the UI lacks — `tx_index_in_block` (Koios block tx index) and
`response_index` (payload array position); the UI's `(slot, txHash)` key is a
display approximation only.

**Validate early what can be validated early.** Rules 1–3 need only the response
transaction plus complementary network info — its block `epoch_no` (on-time), the
tx witnesses / `required_signers` and any native-script resolution (proof), and
the payload itself (well-formed) — all fixed once the tx is confirmed, well before
`end_epoch`. The serving tier should check and **persist** them incrementally as
responses land (e.g. during the read-path refresh, `ARCHITECTURE.md` §5), not
re-run them in a batch at close. Only rule 4 (membership) and the weights
(`ARCHITECTURE.md` §6.2) need the `end_epoch` snapshot, so finalization does just
that boundary-bound work over the already-validated responder set — flattening
what would otherwise be a burst of tx fetches, proof-checking, and CPU at epoch
end (and the Koios rate-limiting it would invite). Dedup's ordering fields
(`slot`, `tx_index_in_block`, `response_index`) are likewise known early; only the
final winner can shift, since dedup runs over the membership-filtered set.

**Sealed surveys.** The counted set is final only at reveal: decrypt, re-run
`validateResponse`, drop undecryptable/invalid. Deadline is by submission slot;
weights by `end_epoch`.

**Cancelled surveys.** An owner-verified, in-window cancellation ⇒ the survey
emits an artifact whose hashed body is a single **cancellation record** (cancelling
`txHash`, owner-proof reference, slot/epoch) and no per-role tally. Unverified
("claimed") cancellations are ignored.

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

Contents (sketch):

```jsonc
{
  // hashed:  artifactHash = H(canonical(tally))
  "tally": {
    "rulesetHash": "...", // binds the §3 validation ruleset + epoch semantics + role→measure + pinned cip-179 validator
    "network": "mainnet",
    "survey": { "txId": "...", "index": 0, "endEpoch": 642 },
    "sealed": false, // true iff sealed submission mode; reveal context in provenance
    "perRole": [
      {
        "role": 1, // CIP-179 Role
        "total": "12345678901234", // epoch total for this role (denominator; presentation decides use)
        "responders": [
          {
            "credential": "…",
            "weight": "1000000000",
            "txHash": "…",
            "responseIndex": 0, // position in the tx's label-17 payload
            // sealed surveys only: the revealed answers in JSON-safe wire form
            // (bytes→hex, bigint→decimal string, Map→tagged pairs sorted by the
            // canonical JSON of the tagged key), e.g.
            // "answers": [{ "type": "singleChoice", "questionIndex": 0, "optionIndex": 1 }]
          },
          // unregistered responders are excluded, not listed here
        ],
        "questions": [
          /* BigInt-string aggregates + {numerator,denominator} ratios */
        ],
      },
    ],
  },
  // NOT hashed: provenance envelope
  "provenance": {
    "source": {
      "provider": "koios",
      "baseUrl": "https://api.koios.rest/api/v1",
    },
    "fetchedAt": 0,
    "byRole": [
      { "role": 1, "endpoint": "/account_stake_history" },
      // fallback-estimated weights, if any: "estimated": [ "<cred>", … ]
    ],
    // sealed surveys only: the reveal context an offline auditor re-checks.
    // "sealedReveal": {
    //   "chainHash": "52db9ba7…c84e971", // quicknet
    //   "round": 19000000,
    //   "beacon": { "round": 19000000, "randomness": "…", "signature": "…" },
    // },
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
