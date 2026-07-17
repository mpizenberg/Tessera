/**
 * French catalog for the widget. Typed as {@link RespondMessages} (the English
 * shape), so a missing or extra key fails the build. Ported from the app's
 * `i18n/fr/respond.ts` + `roles.ts` for the subset the widget bundles.
 *
 * Localization goes beyond words: "bytes" → "octets". Number/date grouping
 * (1 024 vs 1,024) is handled by `n()`/`d()` via Intl, keyed on the locale.
 */

import type { RespondMessages } from "./types.js";

const fr: RespondMessages = {
  respond: {
    // --- Closed / cancelled notices ---------------------------------------
    closedCancelledTitle: "Ce sondage a été annulé",
    closedTitle: "Ce sondage est clos",
    closedCancelledBody:
      "Le propriétaire l'a retirée par une annulation tag-2. Les nouvelles réponses sont rejetées. La définition reste on-chain à titre de référence.",
    closedBody:
      "Son époque de fin est passée, les nouvelles réponses ne sont donc plus acceptées. Vous pouvez toujours consulter les résultats.",

    // --- Ineligible --------------------------------------------------------
    ineligibleTitle: "Vous ne pouvez pas répondre à ce sondage",
    ineligibleLead:
      "Elle n'est ouverte qu'aux rôles ci-dessous, et votre identité ne peut en revendiquer aucun ici. Voici ce que signifie chacun :",
    notClaimable:
      " Un portefeuille de navigateur ne peut pas détenir ce justificatif — le site doit le fournir.",

    // --- Header ------------------------------------------------------------
    respondLabel: "Répondre",
    untitledSurvey: "Sondage sans titre",
    respondingAs: "Vous répondez en tant que",

    // --- Already-responded banner ------------------------------------------
    alreadyResponded: "Vous avez déjà répondu en tant que {role}",
    alreadyRespondedRoleFallback: "ce rôle",
    alreadyRespondedText:
      "Vos réponses précédentes sont pré-remplies. Renvoyer publie une nouvelle réponse qui remplace entièrement la précédente selon le principe « dernière valide gagne » ; l'ancienne reste on-chain mais n'est plus comptabilisée.",

    // --- Sealed banner -----------------------------------------------------
    sealedTitle: "Ceci est un sondage scellé",
    sealedTextBefore:
      "Vos réponses sont chiffrées par verrou temporel à l'envoi — ",
    sealedNoOne: "personne, pas même vous, ne peut les lire",
    sealedTextAfter:
      " jusqu'à la publication du tour drand ({reveal}). Les résultats agrégés n'apparaissent qu'après la révélation.",

    // --- Scellé sur une chaîne drand non prise en charge (envoi bloqué) ----
    sealedUnsupportedTitle: "Impossible de répondre à ce sondage scellé",
    sealedUnsupportedBody:
      "Il est rattaché à une chaîne drand que Tessera ne peut pas déchiffrer : une réponse envoyée ne pourrait jamais être révélée. L'envoi est désactivé.",
    sealedUnsupportedNote:
      "Chaîne drand non prise en charge — révélation impossible",

    // --- Indication de couverture de notation ------------------------------
    ratingRequireAll: "Notez chaque option pour que votre réponse compte.",
    ratingAllowSubset:
      "Notez autant d'options que vous le souhaitez ; laissez le reste vide.",

    // --- Question type labels ---------------------------------------------
    typeCustom: "Personnalisé · schéma externe",
    typeSingleChoice: "Choix unique",
    typeMultiSelect: "Sélection multiple",
    typeRanking: "Classement",
    typeNumericRange: "Plage numérique",
    typePointsAllocation: "Allocation de points",
    typeRating: "Notation",
    typeMetaRange: "{base} · {min}–{max}",
    typeMetaBudget: "{base} · budget {budget}",

    // --- Question card -----------------------------------------------------
    questionChip: "Q{n}",
    required: "Obligatoire",
    skipped: "Ignorée",
    skip: "Ignorer",
    noPrompt: "(aucun énoncé)",
    skippedNote:
      "Ignorée — abstention. Rien n'est enregistré pour cette question.",

    // --- Navigation pas-à-pas (mode une question par écran) -----------------
    stepPrev: "Précédente",
    stepNext: "Suivante",
    stepCount: "Question {n} sur {total}",

    // --- Multi-select body -------------------------------------------------
    multiSelectCount: "sélectionnez {min}–{max} · {chosen} choisie(s)",
    noneLead: "« Aucune de celles-ci » est une vraie réponse.",
    noneNote:
      "Cette question autorise 0 sélection — envoyer sans rien cocher enregistre une réponse vide délibérée, différente d'Ignorer (abstention).",

    // --- Ranking body ------------------------------------------------------
    rankMoveUp: "Monter",
    rankMoveDown: "Descendre",
    rankRemove: "Retirer du classement",
    rankPoolHint: "touchez pour ajouter · classez {min}–{max}",

    // --- Points allocation body -------------------------------------------
    pointsRemainLabel: "Restant à allouer",
    pointsRemain: "{n} pts",
    pointsFooter:
      "répartissez {budget} points · la somme doit égaler le budget",

    // --- Custom body -------------------------------------------------------
    customSchemaTag: "schéma",
    customPlaceholder: "Votre réponse",
    customHint:
      "Encodé comme un metadatum texte brut et interprété par la méthode à l'ancre.",

    // --- Submit bar --------------------------------------------------------
    decidedCount: "{decided} sur {total} renseignées",
    replacesNote: "✓ remplace votre réponse précédente",
    encrypting: "Chiffrement…",
    encryptAndSubmit: "Chiffrer et envoyer",
    signAndSubmit: "Signer et envoyer",

    // --- Submit problems list ---------------------------------------------
    problemsTitle: "Veuillez corriger avant d'envoyer",

    // --- Option fallback label --------------------------------------------
    optionFallback: "Option {n}",
  },

  roles: {
    drep: "Un délégué représentant enregistré — revendiqué dans le navigateur via la clé DRep CIP-95 de votre portefeuille.",
    spo: "Un opérateur de pool de stake — prouvé avec les clés de pool (froides/chaudes) qu'un portefeuille de navigateur ne peut pas détenir.",
    cc: "Un membre du Comité constitutionnel — prouvé avec les clés du comité qu'un portefeuille de navigateur ne peut pas détenir.",
    stakeholder:
      "Tout détenteur d'ada avec une clé de stake — revendiqué dans le navigateur par votre portefeuille connecté.",
    keyholder:
      "Quiconque possède un portefeuille — revendiqué dans le navigateur avec votre clé de paiement (dépense) ; aucune inscription ni activité on-chain requise.",
  },

  // Traductions des problèmes structurés cip-179 (sous-arbres response + answer).
  // Les identifiants techniques et le locateur {where} restent tels quels.
  validation: {
    response: {
      specVersionMismatch:
        "spec_version de la réponse {actual} != sondage {expected}",
      roleNotEligible:
        "le rôle {role} ne figure pas dans les eligible_roles du sondage",
      sealedRequired:
        "un sondage scellé requiert une réponse scellée (chiffrée)",
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
  },
};

export default fr;
