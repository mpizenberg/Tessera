# CIP-179 change suggestions — Rating question "complete coverage" flag

Status: proposal for review (not yet applied to `cip-179.md`).

This change adds **one** authoring option to the rating question type (tag 6): a
flag that says whether a respondent may rate a _subset_ of the options (today's
behavior) or **must rate every option** to submit a valid answer. Nothing else
changes — not the rating scale, not the answer encoding, not any other question
type.

## Why

A rating question is the spec's compact way to express a rating **matrix** —
"rate each of these N options on this scale" in a single question, rather than N
separate questions. For matrices, "require a response in every row" is the single
most common authoring toggle in real survey tooling, and today the spec cannot
express it.

The current spec ([`cip-179.md` §Rating (tag 6)](./frontend/cip-179.md)) fixes
partiality one way, unconditionally:

> Response: `(option_index, rating)` pairs, each rating valid for the scale,
> option indices unique and valid. **A respondent MAY rate a subset of options.**

So an author who wants "rate all five features, or skip the question entirely"
has no way to say it. Their only workaround is to split the matrix into N
separate rating questions, each marked `required` — which defeats the reason the
rating type carries an option list at all, and bloats both the definition and
every response.

Note this is deliberately **not** the `min_rated`/`max_rated` pair that
multi-select and ranking carry. There, the _count of chosen options_ is the
answer, so bounding it bounds the answer's shape. For rating, the answer is the
per-option _score_; whether an option is rated is a separate coverage axis. The
only point on that axis with clear author intent is the binary "all or a subset",
so this proposal adds exactly that and nothing more. A `max_rated` (a cap on how
many options you may rate) has no polling use and is intentionally omitted.

## Summary of changes

| #   | Change                                                                                                                                                                      |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `rating_question` gains a **mandatory** `require_all` bool, placed **before** the optional `required` flag.                                                                 |
| 2   | New validation rule: when `require_all` is true, a present rating answer MUST rate **every** option (rated-option count = option count); otherwise a subset is still valid. |
| 3   | Prose in §Rating (tag 6) updated to describe the flag and its interaction with abstain / `required`.                                                                        |

The **answer encoding is unchanged** — `rating_answer = [6, uint, [+ [uint, int]]]`
already carries whatever `(option_index, rating)` pairs are present; `require_all`
only changes whether a given set of pairs is _valid_, not how it is written.

---

## Change 1 — CDDL for `rating_question`

Replace:

```cddl
; Tag 6: Rating. Rate options on the scale given by rating_scale.
rating_question = [6, chunked_text, options_or_count, rating_scale, ? flag]
```

with:

```cddl
; Tag 6: Rating. Rate options on the scale given by rating_scale.
;   require_all: when 1, a present answer MUST rate every option (no per-option
;   abstain); when 0, a respondent MAY rate a subset. Omitting the whole
;   question is still an abstain (subject to the trailing `required` flag).
rating_question = [6, chunked_text, options_or_count, rating_scale, require_all, ? flag]
                ;   tag  prompt        opts/count      rating_scale  require_all  required
```

where `require_all` is a `bool` (a uint `0`/`1`, matching the existing `flag`
convention).

### Why `require_all` is mandatory, not another `? flag`

The trailing `required` flag is decoded **positionally** as the _optional last_
array element. A second trailing `? flag` would be ambiguous: given
`[6, prompt, opts, scale, 1]`, a decoder cannot tell whether that `1` is
`require_all` or `required`. Making `require_all` a **fixed, always-present**
element at index 4 keeps decoding unambiguous and leaves `required` as the
optional trailing element at index 5. (A packed flags-bitfield in a single
trailing slot would also work but would special-case rating against every other
question type's `? flag`; a plain mandatory bool is the smaller change.)

Since the CIP has no deployed producers yet, making this element mandatory —
rather than optional-with-default for backward compatibility — is free and keeps
the wire shape simplest.

## Change 2 — validation rule

Add to §Rating (tag 6):

> - If the question's `require_all` is `1`, a **present** rating answer MUST
>   contain exactly one `(option_index, rating)` pair per option (every option
>   rated; indices still unique and in range). An answer that rates only some
>   options is **invalid**, and — like any invalid answer — makes the whole
>   response invalid and untallied. If `require_all` is `0`, a subset is valid
>   (current behavior).
> - `require_all` constrains only a **present** answer. Omitting the question
>   entirely is still an abstain, unless the question is also `required`.

This composes with the existing `required` flag as two orthogonal axes:

| `required` | `require_all` | Respondent must…                                                         |
| :--------- | :------------ | :----------------------------------------------------------------------- |
| false      | false         | _(today)_ optionally answer; if answering, rate any non-empty subset     |
| false      | true          | either skip the question, **or** rate every option — no half-filled grid |
| true       | false         | answer; at least one option rated (the answer CDDL's `+`)                |
| true       | true          | answer, and rate every option                                            |

## Change 3 — prose for §Rating (tag 6)

Replace the final bullet:

> - Response: `(option_index, rating)` pairs, each rating valid for the scale,
>   option indices unique and valid. A respondent MAY rate a subset of options.

with:

> - Response: `(option_index, rating)` pairs, each rating valid for the scale,
>   option indices unique and valid. Whether a **subset** of options may be
>   rated is controlled by the question's `require_all` flag: with `require_all
= 0` a respondent MAY rate any non-empty subset; with `require_all = 1` a
>   present answer MUST rate every option (see the validation rule above).
>   Omitting the whole question is an abstain either way (subject to `required`).

## Interaction with abstain and tallies

- **Abstain model is unchanged.** `require_all` never forces a respondent to
  answer — omission is still an abstain (that is `required`'s job). It only
  rejects a _partially filled_ present answer. This is consistent with how
  `required` already invalidates a whole response that omits a required question
  (§Abstain semantics).
- **Tally shape is unchanged.** Per-option rating aggregates already record, for
  each option, how much weight/how many responders rated it. So `require_all`
  adds no new tally field; it only affects which responses are counted at all.
  An author who merely wants to _observe_ partial coverage does **not** need this
  flag — partial mode already surfaces that. `require_all` is specifically for
  authors who want to **reject** incomplete grids.

## Ruleset-version impact (ties into the pinned ruleset hash)

`require_all` changes what "a valid response" means, which is the "validity" rule
committed to by `RULESET_DESCRIPTOR` / `rulesetHash()`. Adopting it is therefore
a semantic ruleset change: it requires bumping `rulesetVersion` (and updating the
pinned golden hash) in lockstep, per the ruleset-hash discipline. As with the
wire format, doing this now — before any artifacts exist — costs nothing.

## Non-goals

- **No `min_rated` / `max_rated`.** Arbitrary count thresholds on rating have no
  clear author intent and collide with the per-option abstain model; only the
  all-vs-subset binary is added.
- **No change to `rating_scale`.** The scale still bounds each option's _value_
  (numeric grid or ordered labels); `require_all` bounds _coverage_, an
  orthogonal concern.
- **No change to the answer encoding or to any other question type.**

## Implementation surface (for a follow-up, not part of this proposal)

For reference, adopting this would touch: the CDDL + prose in `frontend/cip-179.md`;
the `RatingQuestion` type, decoder (a new mandatory element at index 4 in
`decodeQuestion`), encoder, and `validateResponse` rating branch in `packages/cip179`;
`RULESET_DESCRIPTOR.rulesetVersion` + the golden hash in `packages/core`; the
authoring UI (a "require every option to be rated" toggle) and the responding UI
(finding 10 — enforce all-rows vs. allow a subset based on the flag), plus i18n
and test vectors.
