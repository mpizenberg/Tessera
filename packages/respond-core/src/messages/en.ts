/**
 * English message catalog for the `<tessera-respond>` widget — the source of
 * truth every other locale's shape is checked against (`RespondMessages =
 * typeof en`, see ./types.ts).
 *
 * Three namespaces: `respond` (the answering UI), `roles` (role explanations),
 * and `validation` (the structured cip-179 problem codes the widget renders when
 * it emits `tessera:invalid`). The first two are ported from the app's
 * `i18n/en/respond.ts` + `roles.ts` as a **subset** — strings for concerns the
 * widget doesn't own (wallet connection, network conformance, IPFS/rationale
 * pinning, chain fetch/loading, submit progress and navigation) stay in the host
 * app and are intentionally absent. `validation` carries only the `response.*`
 * and `answer.*` codes `validateResponse` can emit (the widget doesn't create
 * surveys, so the `definition.*`/`question.*` codes are omitted).
 *
 * Messages are whole phrases with `{token}` placeholders filled at call time by
 * `I18n.t(key, params)`; a host can override or extend any subtree via the
 * `messages` option (deep-merged, see ./i18n.ts).
 */

const en = {
  respond: {
    // --- Closed / cancelled notices ---------------------------------------
    closedCancelledTitle: "This survey was cancelled",
    closedTitle: "This survey has closed",
    closedCancelledBody:
      "The owner withdrew it with a tag-2 cancellation. New responses are rejected. The definition stays on-chain for reference.",
    closedBody:
      "Its end epoch has passed, so new responses are no longer accepted. You can still read the results.",

    // --- Ineligible --------------------------------------------------------
    ineligibleTitle: "You can't respond to this survey",
    ineligibleLead:
      "It's open only to the roles below, and your identity can't claim any of them here. Here's what each one means:",
    notClaimable:
      " Browser wallets can't hold this credential — the site must supply it.",

    // --- Header ------------------------------------------------------------
    respondLabel: "Respond",
    untitledSurvey: "Untitled survey",
    respondingAs: "Responding as",

    // --- Already-responded banner ------------------------------------------
    /** {role} is the role label, or the fallback below when unknown. */
    alreadyResponded: "You already responded as {role}",
    alreadyRespondedRoleFallback: "this role",
    alreadyRespondedText:
      "Your previous answers are pre-filled. Submitting again publishes a new response that fully replaces the earlier one under latest-valid-wins; the old one stays on-chain but is no longer tallied.",

    // --- Sealed banner -----------------------------------------------------
    sealedTitle: "This is a sealed survey",
    /** Wraps a bold clause (sealedNoOne) and the formatted reveal date. */
    sealedTextBefore: "Your answers are timelock-encrypted on submit — ",
    sealedNoOne: "no one, not even you, can read them",
    sealedTextAfter:
      " until the drand round publishes ({reveal}). Aggregate results appear only after the reveal.",

    // --- Sealed on an unsupported drand chain (submission blocked) ---------
    sealedUnsupportedTitle: "This sealed survey can't be answered",
    sealedUnsupportedBody:
      "It's pinned to a drand chain Tessera can't decrypt, so a submitted answer could never be revealed. Submission is disabled.",
    sealedUnsupportedNote: "Unsupported drand chain — cannot reveal",

    // --- Rating coverage hint ---------------------------------------------
    ratingRequireAll: "Rate every option for your answer to count.",
    ratingAllowSubset:
      "Rate as many options as you like; leave the rest blank.",

    // --- Question type labels ---------------------------------------------
    typeCustom: "Custom · external schema",
    typeSingleChoice: "Single choice",
    typeMultiSelect: "Multi-select",
    typeRanking: "Ranking",
    typeNumericRange: "Numeric range",
    typePointsAllocation: "Points allocation",
    typeRating: "Rating",
    /** Type meta suffixes; {min}/{max}/{budget} are locale-formatted counts. */
    typeMetaRange: "{base} · {min}–{max}",
    typeMetaBudget: "{base} · budget {budget}",

    // --- Question card -----------------------------------------------------
    /** {n} is the 1-based question number. */
    questionChip: "Q{n}",
    required: "Required",
    skipped: "Skipped",
    skip: "Skip",
    noPrompt: "(no prompt)",
    skippedNote: "Skipped — abstaining. Nothing is recorded for this question.",

    // --- Stepper (one-per-screen layout) ------------------------------------
    stepPrev: "Previous",
    stepNext: "Next",
    /** {n}/{total} are locale-formatted counts. */
    stepCount: "Question {n} of {total}",

    // --- Multi-select body -------------------------------------------------
    /** {min}/{max}/{chosen} are locale-formatted counts. */
    multiSelectCount: "select {min}–{max} · {chosen} chosen",
    noneLead: '"None of these" is a real answer.',
    noneNote:
      "This question allows 0 selections — submitting with nothing checked records a deliberate empty answer, different from Skip (abstain).",

    // --- Ranking body ------------------------------------------------------
    rankMoveUp: "Move up",
    rankMoveDown: "Move down",
    rankRemove: "Remove from ranking",
    /** {min}/{max} are locale-formatted counts. */
    rankPoolHint: "tap to add · rank {min}–{max}",

    // --- Points allocation body -------------------------------------------
    pointsRemainLabel: "Remaining to allocate",
    /** {n} is the locale-formatted remaining points. */
    pointsRemain: "{n} pts",
    /** {budget} is the locale-formatted budget. */
    pointsFooter: "distribute {budget} points · sum must equal budget",

    // --- Custom body -------------------------------------------------------
    customSchemaTag: "schema",
    customPlaceholder: "Your answer",
    customHint:
      "Encoded as a raw text metadatum and interpreted by the method at the anchor.",

    // --- Submit bar --------------------------------------------------------
    /** {decided}/{total} are locale-formatted counts. */
    decidedCount: "{decided} of {total} decided",
    replacesNote: "✓ replaces your previous response",
    encrypting: "Encrypting…",
    encryptAndSubmit: "Encrypt & submit",
    signAndSubmit: "Sign & submit",

    // --- Submit problems list ---------------------------------------------
    problemsTitle: "Please fix before submitting",

    // --- Option fallback label --------------------------------------------
    /** {n} is the 1-based option number. */
    optionFallback: "Option {n}",
  },

  roles: {
    drep: "A registered delegate representative — claimed in-browser via your wallet's CIP-95 DRep key.",
    spo: "A stake pool operator — proven with cold/hot pool keys a browser wallet can't hold.",
    cc: "A Constitutional Committee member — proven with committee keys a browser wallet can't hold.",
    stakeholder:
      "Any ada holder with a stake key — claimed in-browser by your connected wallet.",
    keyholder:
      "Anyone with a wallet — claimed in-browser with your payment (spending) key; no registration or on-chain activity needed.",
  },

  // Localized renderings of the cip-179 structured problems `validateResponse`
  // can emit. Keyed by `ValidationProblemCode` (e.g. code
  // "answer.optionIndexOutOfRange" → `validation.answer.optionIndexOutOfRange`);
  // `{where}` is a machine locator (e.g. `answers[0]`) shown verbatim, never
  // translated. Ported from the app's `i18n/en/validation.ts` (response + answer
  // subtrees only).
  validation: {
    response: {
      specVersionMismatch:
        "response spec_version {actual} != survey {expected}",
      roleNotEligible: "role {role} is not in the survey's eligible_roles",
      sealedRequired: "sealed survey requires a sealed (ciphertext) response",
      publicRequired: "public survey requires public (plaintext) answers",
      sealedCiphertextEmpty: "sealed response ciphertext is empty",
      duplicateAnswer: "{where}: duplicate answer for question {questionIndex}",
      questionIndexOutOfRange:
        "{where}: question index {questionIndex} out of range",
      requiredNotAnswered: "required question {questionIndex} is not answered",
    },
    answer: {
      typeMismatch:
        '{where}: answer type "{answerType}" does not match question type "{questionType}"',
      optionIndexOutOfRange: "{where}: option index {index} out of range",
      optionIndicesOutOfRange: "{where}: option index out of range",
      duplicateOptionIndices: "{where}: duplicate option indices",
      selectionCountOutOfRange:
        "{where}: selection count {count} not in [{min}, {max}]",
      duplicateRankedIndices: "{where}: duplicate ranked indices",
      rankedIndexOutOfRange: "{where}: ranked index out of range",
      rankedCountOutOfRange:
        "{where}: ranked count {count} not in [{min}, {max}]",
      valueOutOfRange: "{where}: value {value} out of range",
      valueStepMismatch: "{where}: value {value} does not satisfy step {step}",
      pointsNegative: "{where}: points must be >= 0",
      pointsSumMismatch: "{where}: points sum {sum} != budget {budget}",
      ratingInvalid:
        "{where}.ratings[{index}]: rating {rating} invalid for scale",
      ratingRequireAll:
        "{where}: require_all rating must cover all {count} options, got {got}",
    },
  },
};

export default en;
