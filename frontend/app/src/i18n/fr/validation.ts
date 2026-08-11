/**
 * Traductions des problèmes de validation cip-179. Les identifiants techniques
 * du format (spec_version, eligible_roles, min_selections, …) et le locateur
 * {where} (p. ex. questions[2]) restent tels quels — ce ne sont pas de la prose.
 */
import { frMessages } from "cardano-tessera-respond-core";

import type { Messages } from "../en/validation";

const validation: Messages = {
  ...frMessages.validation,
  definition: {
    specVersionUnsupported:
      "spec_version {actual} != version prise en charge {supported}",
    eligibleRolesEmpty: "eligible_roles ne doit pas être vide",
    eligibleRolesDuplicate: "eligible_roles ne doit pas contenir de doublons",
    noQuestions: "le sondage doit comporter au moins une question",
    sealedRoundInvalid: "le round scellé doit être > 0",
    sealedPaddingInvalid: "le padding_size scellé doit être > 0",
    endEpochNotAfterInclusion:
      "end_epoch {endEpoch} doit être postérieur à l'époque de publication de la définition ({inclusionEpoch})",
    ownerUnproven:
      "la transaction qui a publié ce sondage ne prouve pas la propriété du credential owner",
  },
  question: {
    tooFewOptions: "{where} : au moins 2 options sont requises",
    optionCountTooLow: "{where} : le nombre d'options doit être >= 2",
    optionCountRequiresExternal:
      "{where} : la forme par nombre d'options requiert le mode contenu externe (clé 8)",
    labelTooLong: "{where} : l'étiquette {index} dépasse {max} octets UTF-8",
    maxLessThanMin: "{where} : max_value doit être >= min_value",
    stepNotPositive: "{where} : step doit être > 0",
    ratingTooFewLabels:
      "{where} : l'échelle de notation nécessite au moins 2 étiquettes",
    ratingCountTooLow:
      "{where} : le nombre de niveaux de notation doit être >= 2",
    ratingCountRequiresExternal:
      "{where} : la forme par nombre de niveaux de notation requiert le mode contenu externe",
    minSelectionsNegative: "{where} : min_selections doit être >= 0",
    maxSelectionsTooLow: "{where} : max_selections doit être >= 1",
    minSelectionsGtMax: "{where} : min_selections doit être <= max_selections",
    maxSelectionsGtOptions:
      "{where} : max_selections doit être <= au nombre d'options ({count})",
    minRankedTooLow: "{where} : min_ranked doit être >= 1",
    minRankedGtMax: "{where} : min_ranked doit être <= max_ranked",
    maxRankedGtOptions:
      "{where} : max_ranked doit être <= au nombre d'options ({count})",
    budgetNotPositive: "{where} : budget doit être > 0",
  },
};

export default validation;
