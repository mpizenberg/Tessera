/**
 * Traductions des problèmes de validation cip-179. Les identifiants techniques
 * du format (spec_version, eligible_roles, min_selections, …) et le locateur
 * {where} (p. ex. questions[2]) restent tels quels — ce ne sont pas de la prose.
 */
import type { Messages } from "../en/validation";

const validation: Messages = {
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
  response: {
    specVersionMismatch:
      "spec_version de la réponse {actual} != sondage {expected}",
    roleNotEligible:
      "le rôle {role} ne figure pas dans les eligible_roles du sondage",
    sealedRequired: "un sondage scellé requiert une réponse scellée (chiffrée)",
    publicRequired:
      "un sondage public requiert des réponses publiques (en clair)",
    sealedCiphertextEmpty: "le texte chiffré de la réponse scellée est vide",
    answersEmpty: "répondez à au moins une question avant de soumettre",
    duplicateAnswer:
      "{where} : réponse en double pour la question {questionIndex}",
    questionIndexOutOfRange:
      "{where} : l'index de question {questionIndex} est hors limites",
    requiredNotAnswered:
      "la question obligatoire {questionIndex} n'a pas de réponse",
  },
  answer: {
    typeMismatch:
      "{where} : le type de réponse « {answerType} » ne correspond pas au type de question « {questionType} »",
    optionIndexOutOfRange:
      "{where} : l'index d'option {index} est hors limites",
    optionIndicesOutOfRange: "{where} : index d'option hors limites",
    duplicateOptionIndices: "{where} : index d'options en double",
    selectionCountOutOfRange:
      "{where} : nombre de sélections {count} hors de [{min}, {max}]",
    duplicateRankedIndices: "{where} : index de classement en double",
    rankedIndexOutOfRange: "{where} : index de classement hors limites",
    rankedCountOutOfRange:
      "{where} : nombre d'éléments classés {count} hors de [{min}, {max}]",
    valueOutOfRange: "{where} : la valeur {value} est hors limites",
    valueStepMismatch:
      "{where} : la valeur {value} ne respecte pas le pas {step}",
    pointsNegative: "{where} : les points doivent être >= 0",
    pointsSumMismatch: "{where} : somme des points {sum} != budget {budget}",
    ratingInvalid:
      "{where}.ratings[{index}] : la note {rating} est invalide pour l'échelle",
    ratingRequireAll:
      "{where} : une notation require_all doit couvrir les {count} options, {got} fournie(s)",
  },
};

export default validation;
