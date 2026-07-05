# CIP-179 change suggestions — Governance Action Linkage anchor metadata

Status: proposal for review (not yet applied to `cip-179.md`).

These changes refine **only** how a governance action's anchor advertises a survey.
The on-chain label-17 format, the Action → Survey direction, the `end_epoch` rule,
and every validation rule about _who may respond_ are unchanged.

## Why

The current spec ([`cip-179.md` §Governance Action Linkage](./cip-179.md#L512))
says the link is "in its anchor metadata (an off-chain JSON document)" as a flat
top-level object:

```json
{
  "specVersion": 4,
  "kind": "cardano-governance-survey-link",
  "surveyTxId": "<hex-encoded 32-byte transaction id>",
  "surveyIndex": 0
}
```

Two problems:

1. **Placement is underspecified.** A governance action anchor is a **CIP-108**
   JSON-LD document (`@context`, `hashAlgorithm`, `body`, `authors`). "In the
   anchor metadata" doesn't say _where_. A bare top-level object sits outside
   `body`, so it is **not** part of the canonicalized body the author witness
   signs, and a JSON-LD processor that re-serializes from the expanded form can
   drop it (it has no `@context` term, so it expands to nothing).
2. **The link should be integrity-protected.** Whether the survey is the action's
   whole purpose (e.g. an Info Action created only to advertise a poll) or a
   supplement to an action that has its own on-chain effect (e.g. a treasury
   withdrawal that also polls the parameter values to initialize), consumers
   should be able to trust the link is exactly what the proposer signed — which
   requires it to live in the witnessed `body`, not bolted on the side.

The fix: put the link inside `body`, under a namespaced `cip179` key, and add
the CIP-179 terms to the document's `@context` so it is valid JSON-LD and part
of the canonicalized, author-witnessed body.

## Summary of changes

| #   | Change                                                                                                                         |
| :-- | :----------------------------------------------------------------------------------------------------------------------------- |
| 1   | The link object moves to **`body.cip179`** (inside the CIP-108 body).                                                          |
| 2   | `kind` value shortens from `"cardano-governance-survey-link"` to **`"survey-link"`** (the `cip179` key already namespaces it). |
| 3   | The anchor's **`@context` MUST define the CIP-179 terms** (new requirement).                                                   |

---

## Change 1 + 2 — replacement for the "Governance Action Linkage" anchor text

Replace the paragraph beginning "An action links a survey by including…" and its
JSON block (in `### Governance Action Linkage`) with:

> A governance action's anchor is a [CIP-108](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0108)
> governance-metadata document (itself extending [CIP-100](https://github.com/cardano-foundation/CIPs/tree/master/CIP-0100)).
> A governance action linking to a survey MUST carry the link as a `cip179` object
> **inside the CIP-108 `body`**, so the link is part of the canonicalized body
> covered by the author witness:
>
> ```jsonc
> "body": {
>   "title": "Fund the Ekklesia incentives implementation",
>   "abstract": "…",
>   "motivation": "…",
>   "rationale": "Parameter values to initialize are gathered in the linked CIP-179 survey.",
>   "cip179": {
>     "specVersion": 4,
>     "kind": "survey-link",
>     "surveyTxId": "<hex-encoded 32-byte transaction id>",
>     "surveyIndex": 0
>   }
> }
> ```
>
> The document's `@context` MUST define the CIP-179 terms (see
> [CIP-179 `@context` terms](#cip-179-context-terms)) so `body.cip179` and its
> fields are contextualized — i.e. the link survives RDF canonicalization and is
> covered by the author witness, rather than being silently dropped.
>
> Field notes:
>
> - `specVersion` — the CIP-179 revision the link conforms to (integer); a
>   reader MAY use it to gate how it interprets later revisions.
> - `kind` — discriminator; MUST be `"survey-link"` for a survey link.
> - `surveyTxId` — the survey definition transaction id, hex-encoded per JSON
>   convention (lower- or upper-case; readers compare case-insensitively).
> - `surveyIndex` — the definition's index in that transaction's payload array;
>   MUST be a non-negative integer. A missing or malformed index is a
>   broken link (readers MUST reject it), never silently survey `0`.

---

## Change 3 — required `@context` terms (new subsection)

Add a subsection `#### CIP-179 @context terms` <a id="cip-179-context-terms"></a>:

> A linking anchor MUST extend the CIP-108 `@context` with the CIP-179 namespace
> and the `cip179` term (mirroring how CIP-108 defines `references` as a nested
> context). Add the namespace at the context root:
>
> ```json
> "CIP179": "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0179/README.md#"
> ```
>
> and the `cip179` term **inside the `body` context** (alongside `title`,
> `abstract`, …):
>
> ```json
> "cip179": {
>   "@id": "CIP179:link",
>   "@context": {
>     "specVersion": "CIP179:specVersion",
>     "kind":        "CIP179:kind",
>     "surveyTxId":  "CIP179:surveyTxId",
>     "surveyIndex": "CIP179:surveyIndex"
>   }
> }
> ```
>
> Every `cip179` sub-field MUST be mapped. The CIP-108 context sets no `@vocab`,
> so an unmapped field is dropped during canonicalization — it would remain in
> the raw JSON (and so be readable by a raw-JSON reader) yet fall outside the
> author witness, an inconsistency a linking author MUST avoid.

---

## Change 4 — reader algorithm reference

In the reader steps (`### Block Explorer and dApp Implementation Guide`), replace:

> 3. Optionally discover governance actions whose anchor metadata carries `kind = "cardano-governance-survey-link"`.

with:

> 3. Optionally discover governance actions whose anchor `body.cip179.kind` equals
>    `"survey-link"`.

---

## Worked example — complete linking anchor document

```json
{
  "@context": {
    "@language": "en-us",
    "CIP100": "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#",
    "CIP108": "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0108/README.md#",
    "CIP179": "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0179/README.md#",
    "hashAlgorithm": "CIP100:hashAlgorithm",
    "body": {
      "@id": "CIP108:body",
      "@context": {
        "title": "CIP108:title",
        "abstract": "CIP108:abstract",
        "motivation": "CIP108:motivation",
        "rationale": "CIP108:rationale",
        "references": {
          "@id": "CIP108:references",
          "@container": "@set",
          "@context": {
            "GovernanceMetadata": "CIP100:GovernanceMetadataReference",
            "Other": "CIP100:OtherReference",
            "label": "CIP100:reference-label",
            "uri": "CIP100:reference-uri",
            "referenceHash": {
              "@id": "CIP108:referenceHash",
              "@context": {
                "hashDigest": "CIP108:hashDigest",
                "hashAlgorithm": "CIP100:hashAlgorithm"
              }
            }
          }
        },
        "cip179": {
          "@id": "CIP179:link",
          "@context": {
            "specVersion": "CIP179:specVersion",
            "kind": "CIP179:kind",
            "surveyTxId": "CIP179:surveyTxId",
            "surveyIndex": "CIP179:surveyIndex"
          }
        }
      }
    },
    "authors": {
      "@id": "CIP100:authors",
      "@container": "@set",
      "@context": {
        "name": "http://xmlns.com/foaf/0.1/name",
        "witness": {
          "@id": "CIP100:witness",
          "@context": {
            "witnessAlgorithm": "CIP100:witnessAlgorithm",
            "publicKey": "CIP100:publicKey",
            "signature": "CIP100:signature"
          }
        }
      }
    }
  },
  "hashAlgorithm": "blake2b-256",
  "body": {
    "title": "Fund the Ekklesia incentives implementation",
    "abstract": "Treasury withdrawal to pay the implementation team.",
    "motivation": "The community already approved the change; this funds the work.",
    "rationale": "The parameter values to initialize are gathered in the linked CIP-179 survey.",
    "cip179": {
      "specVersion": 4,
      "kind": "survey-link",
      "surveyTxId": "9a1c0c8f6b2e4d1a7c3f5e9b8d2a4c6e0f1b3d5a7c9e1f2b4d6a8c0e2f4b6d8a",
      "surveyIndex": 0
    }
  },
  "authors": [
    {
      "name": "…",
      "witness": {
        "witnessAlgorithm": "ed25519",
        "publicKey": "…",
        "signature": "…"
      }
    }
  ]
}
```

(The `authors`/`witness` block is optional CIP-108 authorship; omit it if the
action carries no author witness. The on-chain anchor hash still covers the whole
document regardless.)
