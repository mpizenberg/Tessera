# CIP-179 v4 changelog

Concise record of the breaking changes introduced in `spec_version = 4`, with the
rationale for each. Many of these converge CIP-179 toward CIP-191 (Ekklesia) at
the question/answer and vocabulary layers, without importing CIP-191's L2 /
IPFS-as-primary-store / trust-an-operator architecture (which would undercut
CIP-179's trustless, fully-on-chain model).

A final section ([Earlier: changes introduced in v3](#earlier-changes-introduced-in-v3-v2--v3))
recaps the `v2 → v3` changes for continuity, since the published spec jumped
through v3 on the way to v4.

## 1. Question type tags renumbered; `custom` moved to tag 0

- **Change.** Tag assignments are now: `0 = custom`, `1 = single-choice`,
  `2 = multi-select`, `3 = ranking`, `4 = numeric-range`, plus the two new types
  below. Answer tags match their question tag.
- **Rationale.** Placing the extension (`custom`) type at a fixed tag `0` gives
  decoders a stable, predictable home for the catch-all, and lets future
  built-in types be appended at higher tags without ever renumbering it. We are
  still `Proposed` with effectively no production users, so this is the cheapest
  moment to adopt the convention.

## 2. Two new question types: `points_allocation` (5) and `rating` (6)

- **Change.** `points_allocation_question` distributes a fixed `budget` of points
  across options; `rating_question` rates options on a `rating_scale`. Their
  answers are lists of `(option_index, value)` pairs.
- **Rating scale is numeric *or* labeled.** The scale is a sum type: a
  `numeric_constraints` grid (presented as numbers, e.g. 1–5) or an ordered list
  of level labels from worst to best (presented as text, e.g.
  `["bad","meh","good"]`; a level count in external-content mode). The rating
  value in a response is **always an integer** — a value on the grid, or the
  0-based index into the labels — so tallying stays numeric and compact
  regardless of how the scale is presented. This supports ordinal labeled scales
  without forcing authors to abuse single-choice per item.
- **Rationale.** Budget allocation and rating scales are common polling needs the
  option-only types cannot express. They map onto CIP-191's `weighted` and
  `likert` methods, making the two standards' method spaces compatible. Names
  chosen (`points_allocation`, `rating`) are clearer than CIP-191's
  `weighted`/`likert`.

## 3. `min` constraints on multi-select and ranking

- **Change.** `multi_select_question` now carries `min_selections` and
  `max_selections`; `ranking_question` carries `min_ranked` and `max_ranked`. Both
  bounds are explicit positional fields.
- **Rationale.** Completes the constraint surface (previously only `max` existed)
  and matches CIP-191. Resolves the long-standing TODO in the spec.
- **`min_selections = 0` is allowed** (multi-select only). A present, empty
  selection (`[2, q_idx, []]`) is a valid, tallied answer meaning "none
  selected" — e.g. "which of these do you deem acceptable?" answered with
  nothing acceptable. This is deliberately distinct from omitting the question,
  which is an abstain: the encoding distinguishes a present empty array from an
  absent answer item, so both meanings are representable. Ranking keeps
  `min_ranked >= 1` (ranking zero options is not a meaningful present answer and
  collapses into abstain). The multi-select answer is therefore `[2, uint,
  [* uint]]` (zero or more), while ranking stays `[3, uint, [+ uint]]`.

## 4. Per-question `required` flag

- **Change.** Every question type ends with an optional trailing `bool`
  (default `false`). When `true`, a response omitting that question is invalid as
  a whole.
- **Rationale.** Lets creators force an explicit answer where abstention is not
  acceptable. Pairs with abstain-by-omission (next item). Mirrors CIP-191's
  `requireAnswer`.

## 5. Abstain by omission

- **Change.** A question with no answer item in a response is treated as an
  abstain on that question. The previous "empty multi-select selection = no
  options" special case is removed.
- **Rationale.** Abstention is the most common non-answer; encoding it as the
  *absence* of an answer item costs zero bytes and removes the need for a
  dedicated abstain marker. A respondent who never submits at all is a
  non-participant, not an abstainer, so the distinction that matters is
  preserved. This is more data-efficient than CIP-191's explicit `abstain: true`
  field while expressing the same intent. Authors who want a *counted,
  selectable* abstain may still add an explicit "Abstain" option.

## 6. `role_weighting` replaced by `eligible_roles`; weighting modes removed

- **Change.** The role→weighting-mode map is replaced by a plain set of eligible
  roles. The `weighting_mode` enumeration and the entire normative "Weighting
  Semantics" section are deleted. A new `Owner` role (role `4`) is added.
- **Rationale.** The old field conflated two separable concerns:
  - *Eligibility* — who may respond and which credential they prove. This
    affects **validation** and is a useful **UI hint** (which key to present). It
    stays in the definition.
  - *Weighting* — how a recorded selection is interpreted into influence. This
    changes nothing the respondent signs; it is purely downstream interpretation.

  Enumerating `CredentialBased / StakeBased / PledgeBased` is inherently
  incomplete: it cannot express quadratic voting, Borda counts, or custom
  formulas, and the choice between modes does not change the signed payload — only
  the result interpretation. Moving weighting/aggregation entirely outside CIP
  boundaries lets the same recorded vote set be re-tallied later under any rule,
  and keeps the on-chain definition honest about what the chain actually
  enforces. `end_epoch` is retained as the validity cutoff and a canonical
  snapshot-epoch reference for whoever does the weighting.

  This also dissolves two earlier questions: "should Stakeholder also allow
  CredentialBased?" and "should Owner be CredentialBased-only?" — once weighting
  leaves the schema, both roles are just eligibility/UI hints. `Owner` means
  "prove control of a payment/spending credential" (a UI hint to present a
  spending key), suited to e.g. NFT-gated surveys where the actual gating is
  enforced off-chain.

  Note: `SPO` and CIP-191's `pool` are the same role; a CIP-151 calidus hot key
  is only an alternative proof mechanism for that role, not a distinct role.

## 7. `content_anchor` primitive (URI + blake2b-256 hash)

- **Change.** A single `content_anchor = [uri, hash]` type is introduced and
  reused in three places:
  1. Optional external survey **presentation text** (new optional field on
     `survey_definition`).
  2. The **custom-method schema** reference (replacing the inline
     `method_schema_uri` + `method_schema_hash` pair).
  3. Optional per-response **voter rationale** (new optional field on
     `survey_response`).
- **Rationale.** One tamper-evident off-chain reference primitive covers all
  three bulky/optional payloads.
  - *External definitions* enable much larger surveys at small on-chain cost.
    Crucially, only **presentation text** moves off-chain; the structural
    skeleton (question count, type tags, all constraints, eligible roles,
    end_epoch, owner, submission mode) stays on-chain. Responses remain validatable
    and talliable from on-chain data alone (answers reference option *indices*),
    and the survey degrades gracefully — if the off-chain doc is unavailable, only
    labels are missing. This is the variant chosen over a bare-reference
    replacement, which would import CIP-191's availability weakness wholesale.
  - In external mode, option-bearing questions may store an option **count**
    (`uint`) instead of an empty label array; the CBOR decoder distinguishes the
    uint form from the array form automatically.
  - *Voter rationales* answer a real gap (CIP-191 has no rationale field in its
    evidence schema) and align with Cardano governance's CIP-100/CIP-108 anchor
    conventions.

## 8. Method Identifier Registry (URN cross-walk)

- **Change.** A registry table maps each integer question tag to an interop URN
  (e.g. `urn:cardano:poll-method:ranking:v1`) and to the corresponding CIP-191
  method name.
- **Rationale.** URNs aid interoperability with CIP-191 (which names methods with
  strings/URNs) but must **not** appear in the compact CBOR — that would
  reintroduce the text bloat the encoding exists to avoid. The integer tag is the
  on-chain identifier; the URN is a documentation/registry alias (mirrorable into
  CIP-10). The only place a URN appears in data is the `custom` type's anchor URI.
- **URN versioning.** The version suffix versions a method's *semantic contract*,
  not this CIP's document version. `single-choice`, `multi-select`, and
  `numeric-range` go to `:v2`: their `:v1` was defined by CIP-179 v1 (the
  string-based encoding) and is referenced today by CIP-191/Ekklesia, and this
  document materially redefines them (CBOR-first encoding, abstain-by-omission,
  and a meaningful empty selection for multi-select), so reusing `:v1` would be a
  contract collision — CIP-191 will repoint at `:v2`. `ranking`,
  `points-allocation`, and `rating` have no prior `urn:cardano:poll-method:*`
  definition (CIP-191 carries them under `urn:ekklesia:*`), so they start at
  `:v1`. Method names follow the CIP-179 type names (`ranking`,
  `points-allocation`, `rating`), not Ekklesia's
  (`ranked`/`weighted`/`likert`).

## 9. Top-level records → integer-keyed maps (forward-compat)

- **Change.** `survey_definition` and `survey_response` move from positional CBOR
  arrays to deterministically-encoded **integer-keyed maps** (keys `0..n`, the
  same field order as before). The optional fields (`content_anchor`) sit at a
  fixed key rather than as a trailing array element. The nested discriminated
  unions — `survey_question` and `answer_item` variants, `content_anchor`,
  `survey_ref`, option lists — stay as tagged positional arrays.
- **Rationale.** Maps are the Cardano forward-compat idiom: Conway's
  `transaction_body` is an integer-keyed map precisely so new fields (e.g.
  `voting_procedures`, `treasury`, `donation`) could be added at new keys across
  eras without renumbering. The same applies here.
  - *Definition* is low-volume (one per survey, amortized over many responses) and
    the structure most likely to accrete optional fields (`start_epoch`, quorum
    hint, category, a second anchor…), so key overhead is negligible and the
    flexibility is most valuable.
  - *Response* gains less in bytes, but the deferred CIP-8 work will add optional
    signature material (and a nonce) *alongside* the already-optional rationale —
    multiple independent optionals, which an array cannot express without null
    placeholders or brittle trailing-order rules. A map handles them cleanly, and
    the ~5 bytes of keys are dwarfed by the credential and answers.
  - The nested tagged unions are versioned by *tag/URN* and evolve by adding new
    tags, not new fields, so a map there would only bloat them with no compat gain.
- **Determinism requirement.** Encoders MUST use deterministic CBOR for these
  maps (integer keys ascending, no duplicates — plain numeric order per RFC 8949
  §4.2), so any hashing/equality/dedup over the payload stays unambiguous.
  Decoders SHOULD ignore unrecognized keys (reserved for future versions).

## 10. Governance linkage decoupled from eligibility

- **Change.** A governance-linked survey no longer restricts who may respond, and
  no longer requires a `voting_procedures` vote on the linked action. All of the
  survey's `eligible_roles` participate in a linked survey exactly as they would
  standalone. The `voting_procedures` vote on `linked_action_id` becomes an
  **optional binding**: when present it is cross-checked (voter credential matches
  the response credential, votes on the linked action, Conway voter tag matches the
  claimed role); when absent the response is validated by the standalone proof.
  Credential proof is now stated as an explicit **either/or**: `required_signers`
  (mechanism A) *or* a ledger-validated `voting_procedures` binding (mechanism B).
  When B holds, the credential need **not** also be in `required_signers` — the
  ledger already enforced the voter's witness when it accepted the vote — and for
  Plutus-script credentials B is the only mechanism.
- **Rationale.** The prior rule (inherited from v3, not new to v4) made the
  governance vote the *proof mechanism* for linked responses, which conflated three
  separate concerns — discovery, eligibility, and credential proof — and as a side
  effect excluded the two roles with no Conway voter type (Stakeholder, Owner). An
  Info Action linking to a survey is essentially advertising it; that should widen
  reach, not narrow it. The standalone credential proof + ledger role-validation
  already covers every role, so the governance-vote requirement was unnecessary for
  validity.
- **Why keep the optional binding (not drop it).** It is the *only* mechanism that
  yields ledger-evaluated verification of **Plutus-script credentials**: the Conway
  `voter` type supports Plutus voters (tags 1, 3) and the ledger evaluates the
  voting redeemer, whereas the standalone `required_signers` path cannot evaluate a
  Plutus script (no redeemer tag in metadata). It also lets voter-role respondents
  correlate "voted X on the action, answered Y on the survey" when they want to.
- **Docs.** The credential-proof rules now distinguish key / native-script /
  Plutus-script credentials explicitly, and the "Plutus script credentials"
  limitation subsection is generalized (no longer "…for standalone surveys") to
  state the single supported Plutus path is the optional linked binding.

## Deferred (documented as open design questions, not implemented in v4)

- **CIP-8 message-signing proof / calidus support.** Motivated by letting SPOs
  prove the SPO role via a CIP-151 calidus hot key, and by enabling batched
  third-party submission of message-signed responses. Needs a design pass on:
  what payload is signed (replay binding via `survey_ref` + a per-response nonce),
  where the signature/recovered key live in the response, within-survey replay
  handling, and how batched submission is expressed in the label `17` payload.
  (Correction from earlier discussion: `required_signers` is *not* coupled to who
  pays the fee — it is just a ledger-enforced guarantee that a credential
  witnessed the tx. The genuine advantage of CIP-8 is supporting message-signing
  credential types and offline/aggregated submission.)
- **Canonical tally interchange format.** CIP-191's rigid `results.json` schema is
  driven by its hash-and-audit commitment model, which CIP-179 does not have. A
  *recommended, non-normative* per-method tally interchange shape (for cross-tool
  result comparison on shared test vectors) is worth designing in its own pass.

## Earlier: changes introduced in v3 (v2 → v3)

For continuity, this section recaps the breaking changes the published spec made
in `spec_version = 3` (between v2 and v4). Unlike the v4 items above, these were
not about CIP-191 convergence; they were independent additions, all carried
forward into v4.

### v3.1 Timelocked submission mode (Drand `tlock`)

- **Change.** A `submission_mode` field is added to `survey_definition` as a
  tagged sum type: `[0]` **public** (plaintext answer items, as in v1/v2) or
  `[1, drand_chain_hash, round, padding_size]` **timelocked**. In timelocked mode
  a response carries a Drand `tlock` ciphertext (a new `chunked_bytes` primitive)
  in place of plaintext answers; the `response_answers` field therefore accepts
  *either* `[+ answer_item]` (public) *or* `chunked_bytes` (timelocked), the two
  distinguished by shape (arrays vs. byte strings). Answers are encrypted at
  submission and become decryptable by anyone once `round` publishes on the pinned
  Drand chain. `padding_size` is the minimum plaintext length each response is
  padded to before encryption, so ciphertext length does not leak answer content.
- **Rationale.** Enables **delayed-reveal** polling — commit answers now, everyone
  can decrypt after the round — with no trusted operator or reveal phase: the
  trustless, fully-on-chain analogue of commit-reveal voting (the model this
  repository is named for). It is delayed reveal, *not* permanent secrecy. New
  primitive `drand_chain_hash = bytes .size 32` and the Abstract gain a line
  noting "public or timelocked responses."

### v3.2 `specVersion` restored to `survey_response`

- **Change.** A `specVersion` `uint` is reinstated as the first element of
  `survey_response` (it was present in v1, then dropped in v2 on the assumption the
  referenced survey supplied it). A response's `specVersion` MUST match the
  referenced definition's.
- **Rationale.** It lets a response be decoded on its own — in particular its
  answer encoding and whether answers are plaintext or timelocked ciphertext —
  without first having to resolve the survey definition. (v4 keeps this as key `0`
  of the `survey_response` map.)

### v3.3 `survey_definition` field reorder

- **Change.** The `survey_definition` positional array is reordered so the
  fixed-size header fields precede the variable-length `questions` array, which now
  comes last:
  `[specVersion, owner, title, description, roleWeighting, endEpoch, submissionMode, questions]`
  (v2 placed `questions` at position 4, ahead of `roleWeighting`/`endEpoch`).
  Question indices are unchanged, so `survey_response` answer references are
  unaffected.
- **Rationale.** Keeping the single variable-length field last gives every
  fixed-size header field a stable position — the conventional layout for
  positional records. This concern is moot in v4, where both top-level records
  became integer-keyed maps (see [item 9](#9-top-level-records--integer-keyed-maps-forward-compat)),
  but it motivated the placement of `submission_mode` and `questions` that v4
  inherited as keys 6 and 7.
