/**
 * Localized renderings of cip-179's structured validation problems.
 *
 * Each leaf key is a cip-179 `ValidationProblemCode` (e.g. the code
 * `"answer.optionIndexOutOfRange"` maps to `validation.answer.optionIndexOutOfRange`),
 * rendered by `problemText` (../problem.ts). `{placeholder}` tokens are filled
 * from the problem's `params`; `{where}` is a machine locator such as
 * `questions[2]` — shown verbatim, never translated. A test
 * (validation.test.ts) asserts this catalog covers every declared code.
 *
 * The `response` and `answer` subtrees are `respond-core`'s: the widget renders
 * the same problems from the same codes, so the wording has one definition. The
 * `definition` and `question` codes are the app's alone — only it authors
 * surveys.
 */

import { enMessages } from "cardano-tessera-respond-core";

const validation = {
  ...enMessages.validation,
  definition: {
    specVersionUnsupported: "spec_version {actual} != supported {supported}",
    eligibleRolesEmpty: "eligible_roles must be non-empty",
    eligibleRolesDuplicate: "eligible_roles should not contain duplicates",
    noQuestions: "survey must have at least one question",
    sealedRoundInvalid: "sealed round must be > 0",
    sealedPaddingInvalid: "sealed padding_size must be > 0",
    endEpochNotAfterInclusion:
      "end_epoch {endEpoch} must be after the epoch the definition is published in ({inclusionEpoch})",
    ownerUnproven:
      "the transaction that published this survey does not prove the owner credential",
  },
  question: {
    tooFewOptions: "{where}: needs at least 2 options",
    optionCountTooLow: "{where}: option count must be >= 2",
    optionCountRequiresExternal:
      "{where}: option-count form requires external-content mode (key 8)",
    labelTooLong: "{where}: label {index} exceeds {max} UTF-8 bytes",
    maxLessThanMin: "{where}: max_value must be >= min_value",
    stepNotPositive: "{where}: step must be > 0",
    ratingTooFewLabels: "{where}: rating scale needs at least 2 labels",
    ratingCountTooLow: "{where}: rating level count must be >= 2",
    ratingCountRequiresExternal:
      "{where}: rating level-count form requires external-content mode",
    minSelectionsNegative: "{where}: min_selections must be >= 0",
    maxSelectionsTooLow: "{where}: max_selections must be >= 1",
    minSelectionsGtMax: "{where}: min_selections must be <= max_selections",
    maxSelectionsGtOptions:
      "{where}: max_selections must be <= number of options ({count})",
    minRankedTooLow: "{where}: min_ranked must be >= 1",
    minRankedGtMax: "{where}: min_ranked must be <= max_ranked",
    maxRankedGtOptions:
      "{where}: max_ranked must be <= number of options ({count})",
    budgetNotPositive: "{where}: budget must be > 0",
  },
};

export type Messages = typeof validation;
export default validation;
