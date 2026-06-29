/**
 * Note la localisation au-delà des mots : « bytes » devient « octets » (symbole
 * « o »). Le groupement des nombres (1 024 vs 1,024) est géré par `n()` via Intl,
 * pas ici.
 */
import type { Messages } from "../en/respond";

const respond: Messages = {
  // --- Top-level navigation / progress ------------------------------------
  backToResults: "Retour aux résultats",
  submitting: "Envoi…",
  encrypting: "Chiffrement…",
  pinningRationale: "Épinglage de la justification…",

  // --- Submit progress steps ----------------------------------------------
  stepPin: "Épinglage de la justification sur IPFS",
  stepEncrypt: "Chiffrement par verrou temporel de vos réponses",
  stepSubmit: "Signature et envoi de la transaction",
  progressTitleSealed: "Scellement de votre réponse",
  progressTitlePublic: "Envoi de votre réponse",

  // --- Manual rationale validation problems -------------------------------
  ratProblemUriRequired: "Justification : l'URI du document est requise.",
  ratProblemHashBytes:
    "Justification : le hash doit faire 32 octets (64 caractères hex).",
  ratProblemHashHex: "Justification : le hash n'est pas un hexadécimal valide.",

  // --- Unverified cancellation claim --------------------------------------
  cancelClaimLead: "Demande d'annulation non vérifiée.",
  cancelClaimBody:
    "Une annulation de ce sondage a été publiée mais n'a pas pu être vérifiée comme provenant du propriétaire ; elle est donc ignorée — vous pouvez toujours répondre.",

  // --- Closed / cancelled notices -----------------------------------------
  closedCancelledTitle: "Ce sondage a été annulé",
  closedTitle: "Ce sondage est clos",
  closedCancelledBody:
    "Le propriétaire l'a retirée par une annulation tag-2. Les nouvelles réponses sont rejetées. La définition reste on-chain à titre de référence.",
  closedBody:
    "Son époque de fin est passée, les nouvelles réponses ne sont donc plus acceptées. Vous pouvez toujours consulter les résultats.",

  // --- Connect prompt ------------------------------------------------------
  connectTitle: "Connectez un portefeuille pour répondre",
  connectBody:
    "Utilisez le bouton « Connecter un portefeuille » dans l'en-tête. L'éligibilité est vérifiée par rapport aux identifiants de votre portefeuille. Vous pouvez lire le sondage et ses résultats sans vous connecter.",

  // --- Ineligible ----------------------------------------------------------
  ineligibleTitle: "Vous ne pouvez pas répondre à ce sondage",
  ineligibleLead:
    "Elle n'est ouverte qu'aux rôles ci-dessous, et votre portefeuille connecté ne peut en revendiquer aucun ici. Voici ce que signifie chacun :",
  notClaimable: " Non revendicable dans un portefeuille de navigateur.",

  // --- Header --------------------------------------------------------------
  respondLabel: "Répondre",
  refTitle:
    "Référence complète du sondage — hash de la transaction de définition et index de sortie",
  refPrefix: "réf {ref}",
  untitledSurvey: "Sondage sans titre",
  respondingAs: "Vous répondez en tant que",

  // --- Already-responded banner -------------------------------------------
  alreadyResponded: "Vous avez déjà répondu en tant que {role}",
  alreadyRespondedRoleFallback: "ce rôle",
  alreadyRespondedText:
    "Vos réponses précédentes sont pré-remplies. Renvoyer publie une nouvelle réponse qui remplace entièrement la précédente selon le principe « dernière valide gagne » ; l'ancienne reste on-chain mais n'est plus comptabilisée.",

  // --- Sealed banner -------------------------------------------------------
  sealedTitle: "Ceci est un sondage scellé",
  sealedTextBefore:
    "Vos réponses sont chiffrées par verrou temporel à l'envoi — ",
  sealedNoOne: "personne, pas même vous, ne peut les lire",
  sealedTextAfter:
    " jusqu'à la publication du tour drand ({reveal}). Les résultats agrégés n'apparaissent qu'après la révélation.",

  // --- Labels-absent banner -----------------------------------------------
  labelsAbsentTitle: "Libellés de présentation indisponibles",
  labelsAbsentTextBefore: "Le document off-chain (",
  labelsAbsentTextMid:
    ") n'a pas pu être récupéré ou a échoué à sa vérification de hash ; les libellés des options sont donc affichés sous forme d'indices. ",
  labelsAbsentCanRespond: "Vous pouvez toujours répondre",
  labelsAbsentTextAfter:
    " — votre réponse référence des indices d'options, validés et comptabilisés normalement.",

  // --- Rationale section ---------------------------------------------------
  ratToggle: "Joindre un document de justification",
  ratToggleHint: "(off-chain, ancré par hash)",
  ratSourceLabel: "Source de la justification",
  ratModeWrite: "Rédiger et épingler",
  ratModeManual: "Coller l'ancre",
  ratDocUri: "URI du document",
  ratDocUriPlaceholder: "ipfs://… ou https://…",
  ratHashLabel: "Hash (blake2b-256, hex)",
  ratHashPlaceholder: "64 caractères hexadécimaux",
  ratManualHint:
    "Hébergez le document vous-même ; le hash le rend infalsifiable.",
  ratWriteLabel: "Justification",
  ratWritePlaceholder: "Pourquoi vous avez répondu ainsi…",
  ratNoPinningBefore:
    "Aucun fournisseur IPFS n'est configuré — ajoutez un jeton dans",
  ratSettingsLink: "Paramètres",
  ratNoPinningAfter:
    "pour épingler depuis ici, ou passez à « Coller l'ancre ».",
  ratWriteHint:
    "À l'envoi, ceci est épinglé sur vos fournisseurs IPFS et ancré (URI + hash blake2b-256) sur votre réponse. Informatif uniquement — n'affecte jamais la validation ni les décomptes.",

  // --- Question type labels -----------------------------------------------
  typeCustom: "Personnalisé · schéma externe",
  typeSingleChoice: "Choix unique",
  typeMultiSelect: "Sélection multiple",
  typeRanking: "Classement",
  typeNumericRange: "Plage numérique",
  typePointsAllocation: "Allocation de points",
  typeRating: "Notation",
  typeMetaRange: "{base} · {min}–{max}",
  typeMetaBudget: "{base} · budget {budget}",

  // --- Question card -------------------------------------------------------
  questionChip: "Q{n}",
  required: "Obligatoire",
  skipped: "Ignorée",
  skip: "Ignorer",
  noPrompt: "(aucun énoncé)",
  skippedNote:
    "Ignorée — abstention. Rien n'est enregistré pour cette question.",

  // --- Multi-select body ---------------------------------------------------
  multiSelectCount: "sélectionnez {min}–{max} · {chosen} choisie(s)",
  noneLead: "« Aucune de celles-ci » est une vraie réponse.",
  noneNote:
    "Cette question autorise 0 sélection — envoyer sans rien cocher enregistre une réponse vide délibérée, différente d'Ignorer (abstention).",

  // --- Ranking body --------------------------------------------------------
  rankMoveUp: "Monter",
  rankMoveDown: "Descendre",
  rankRemove: "Retirer du classement",
  rankPoolHint: "touchez pour ajouter · classez {min}–{max}",

  // --- Points allocation body ---------------------------------------------
  pointsRemainLabel: "Restant à allouer",
  pointsRemain: "{n} pts",
  pointsFooter: "répartissez {budget} points · la somme doit égaler le budget",

  // --- Custom body ---------------------------------------------------------
  customSchemaTag: "schéma",
  customPlaceholder: "Votre réponse",
  customHint:
    "Encodé comme un metadatum texte brut et interprété par la méthode à l'ancre.",

  // --- Submit bar ----------------------------------------------------------
  decidedCount: "{decided} sur {total} renseignées",
  replacesNote: "✓ remplace votre réponse précédente",
  switchNetwork: "Basculez votre portefeuille sur {network} pour envoyer",
  encryptAndSubmit: "Chiffrer et envoyer",
  signAndSubmit: "Signer et envoyer",

  // --- Submitted panel -----------------------------------------------------
  submittedTitle: "Réponse envoyée",
  submittedText:
    "Votre réponse a été publiée sous le label de métadonnées 17. Elle peut mettre quelques instants à apparaître dans le décompte, le temps que l'indexeur se mette à jour.",
  viewResults: "Voir les résultats →",

  // --- Empty / loading / error --------------------------------------------
  loading: "Chargement…",
  notFound: "Sondage introuvable.",
  loadError:
    "Impossible de charger depuis le réseau — il peut s'agir d'une erreur transitoire.",
  retry: "Réessayer",

  // --- Submit problems list ------------------------------------------------
  problemsTitle: "Veuillez corriger avant d'envoyer",

  // --- Option fallback label ----------------------------------------------
  optionFallback: "Option {n}",
};

export default respond;
