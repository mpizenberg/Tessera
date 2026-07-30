/**
 * Public prop / event contract for `<tessera-respond>`.
 *
 * Object-valued props (`definition`, `responder`, `surveyRef`, …) are set as DOM
 * **properties** (`el.definition = …`), not attributes; `solid-element`
 * exposes them as reactive props. `locale` / `layout` may also
 * be plain string attributes. The widget emits everything back through
 * `CustomEvent`s (`bubbles: true, composed: true`, so they cross the shadow
 * boundary) — it never touches a wallet, chain, or the host's `<html>`.
 */

import type {
  ContentAnchor,
  Credential,
  Metadatum,
  Role,
  SurveyDefinition,
  SurveyRef,
  SurveyResponse,
  ValidationProblem,
} from "cip-179";
import type {
  DeepPartial,
  Responder,
  RespondMessages,
} from "@tessera/respond-core";

export type { Responder };

export interface TesseraRespondProps {
  /** Required. Display definition — on-chain, or host-enriched with off-chain labels. */
  definition: SurveyDefinition;
  /**
   * Required. The survey's on-chain location (`tx_id` + `index`). A
   * {@link SurveyDefinition} is content only and carries no ref, so the host —
   * which fetched the definition from that location — passes it explicitly. It
   * rides back out on every {@link RespondResult} and into the built response.
   */
  surveyRef: SurveyRef;
  /** Who is answering: the credential asserted for each role (wallet-derived and/or host-trusted). */
  responder: Responder;
  /**
   * Required. Current chain-tip epoch — the widget derives active/ended via
   * `surveyStatus(definition.endEpoch, tipEpoch)` and blocks a closed survey. A
   * snapshot: re-set the prop to refresh.
   */
  tipEpoch: number;
  /** A valid on-chain cancellation exists (host-checked); renders the cancelled state. */
  cancelled?: boolean;
  /**
   * Optional, for an edit/replace flow: the responder's prior responses to this
   * survey, as fetched from chain by the host — **one per role** they've
   * answered as. The role is chosen inside the widget (a responder eligible in
   * several roles switches between them), so the host can't know up front which
   * prior response applies; it passes them all and the widget selects the one
   * matching the current role + credential. Pass sealed priors too — they mark
   * the form as a replacement, they just can't prefill it (ciphertext).
   */
  priorResponses?: readonly SurveyResponse[];
  /** Optional host-pinned rationale (CIP-179 key 5); the widget never pins. */
  rationaleAnchor?: ContentAnchor;
  /** BCP-47 locale; default `"en"`. Drives both strings and number/date formatting. */
  locale?: string;
  /** Deep-merged string overrides / an unshipped language. */
  messages?: DeepPartial<RespondMessages>;
  /**
   * Design-token overrides: each entry is reflected as an inline
   * `--tessera-<key>` custom property on the host element, e.g.
   * `{ accent: "#6b46ff", "role-drep": "#6b46ff" }`. Equivalent to setting the
   * same properties on `tessera-respond` in host CSS; see theme.css for the
   * token list.
   */
  theme?: Record<string, string>;
  /** Layout of the form: `"one-per-screen"` (default) steps through the questions one at a time; `"list"` renders them all at once. */
  layout?: "one-per-screen" | "list";
  /**
   * Optional initial role when the responder is eligible in several — a
   * preference only; the user can still switch. Not named `role`: that would
   * shadow the element's global ARIA `role` attribute/property, so a host or
   * a11y library setting `el.role = "region"` would corrupt this prop (and ARIA
   * reflection would stop working).
   */
  initialRole?: Role;
}

/** Which wallet/pool key must sign for a credential's proof. */
export type ProofKeyKind = "payment" | "stake" | "drep" | "pool" | "cc";

export interface CredentialProof {
  credential: Credential;
  keyKind: ProofKeyKind;
}

/** Emitted on `tessera:response` when the user finalizes a valid answer set. */
export interface RespondResult {
  surveyRef: SurveyRef;
  role: Role;
  credential: Credential;
  /** Attach at metadata label 17. */
  payload: Metadatum;
  /** Prove each through the carrying tx (required_signers or a governance-vote binding); keyKind names the signing key. */
  proveCredentials: CredentialProof[];
  sealed: boolean;
}

/** Emitted on `tessera:change` — progress, for host-driven submit buttons. */
export interface RespondChangeDetail {
  decided: number;
  total: number;
  /**
   * Every question decided (with ≥1 actually answered — an all-skipped form is
   * spec-invalid), the survey is open, and a role is claimable.
   */
  valid: boolean;
}

/** Emitted on `tessera:invalid` — structured codes plus their localized text. */
export interface RespondInvalidDetail {
  problems: ValidationProblem[];
  messages: string[];
}

/** The event names the widget dispatches (all `bubbles: true, composed: true`). */
export const RESPOND_EVENTS = {
  response: "tessera:response",
  change: "tessera:change",
  invalid: "tessera:invalid",
} as const;
