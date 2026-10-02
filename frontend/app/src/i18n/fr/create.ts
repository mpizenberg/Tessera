/**
 * French catalog for the Create screen. Bytes are localized to "octets" (and
 * the inline "(bytes)" hint to "(octets)"). Number grouping is handled by `n()`.
 */
import type { Messages } from "../en/create";

const create: Messages = {
  // --- Back link & page header ---
  backToSurveys: "Tous les sondages",
  pageTitle: "Créer un sondage",
  pageSubtitle:
    "Définissez les questions, qui peut répondre, quand le sondage se clôture et si les réponses sont publiques ou scellées, puis signez pour publier la définition on-chain sous le label de métadonnées 17.",
  restoredDraft: "Votre brouillon non publié a été restauré.",
  startOver: "Recommencer",

  // --- Submit progress overlay ---
  progressTitle: "Publication de votre sondage",
  stepPin: "Épinglage de la présentation sur IPFS",
  stepSubmit: "Signature et envoi de la transaction",

  // --- Busy / step text (publish flow) ---
  busyPublishing: "Publication…",
  busyPinning: "Épinglage de la présentation…",
  busySubmitting: "Envoi…",

  // --- Basics section ---
  sectionBasics: "Bases",
  fieldTitle: "Titre",
  titlePlaceholder: "p. ex. Priorités du trésor pour la prochaine époque",
  fieldDescription: "Description",
  descriptionPlaceholder: "Contexte facultatif pour les répondants.",

  // --- Who can cancel (owner) section ---
  sectionWhoCanCancel: "Qui peut annuler",
  ownerHeading: "Détenu par votre credential de paiement.",
  ownerBody:
    "Vous signez avec lui pour publier, et lui seul peut annuler ce sondage par la suite.",
  ownerNoWalletHeading: "Aucun wallet connecté.",
  ownerNoWalletBody:
    "Le sondage sera détenu par le wallet qui le publie, et seul ce wallet pourra l'annuler. Vous pouvez dès maintenant le rédiger et l'exporter ; connectez un wallet avec le bouton de l'en-tête pour le publier.",
  ownerScriptHeading: "Ce wallet ne peut pas détenir de sondage.",
  ownerScriptBody:
    "Publier prouve le credential propriétaire par une signature, et le credential de paiement de ce wallet est à script — rien qu'il puisse signer ne le prouverait. Connectez un wallet dont le credential de paiement est à clé pour publier.",

  // --- Who can respond (roles) section ---
  sectionWhoCanRespond: "Qui peut répondre",
  rolesHint:
    "L'éligibilité est une revendication, vérifiée indépendamment par rapport à l'état du registre. Keyholder est ouvert à quiconque possède un wallet (une simple clé de paiement — aucun enregistrement requis). Les SPO et les CC peuvent être listés, mais ne peuvent pas répondre depuis un wallet de navigateur (ils ont besoin de clés froides/chaudes).",

  // --- Timing section ---
  sectionTiming: "Calendrier",
  govToggleTitle: "Lier ce sondage à une action de gouvernance",
  govToggleDesc:
    "Une action de gouvernance on-chain annoncera ce sondage et ils se clôturent ensemble.",
  endEpochLabel: "Époque de fin (incluse)",
  autoLockedBadge: "auto · verrouillé",
  closesOn: "Clôture ~{date}",
  loadingEpoch: "Chargement de l'époque actuelle…",
  acceptedThroughEpoch:
    "Les réponses sont acceptées jusqu'à la fin de cette époque. {hint}",
  currentEpochIs: "L'époque actuelle est {epoch}.",
  govLifetimeUnreadable:
    "Impossible de lire gov_action_lifetime depuis la chaîne, le délai ne peut donc pas être calculé. Saisissez manuellement l'époque d'expiration de l'action — elles doivent correspondre exactement.",
  govNoteIntro:
    "Verrouillé sur l'époque d'expiration de l'action de gouvernance. Sur {network}, une action de gouvernance soumise à cette époque{epochParen} se clôture à l'époque",
  govNoteOutro:
    ", l'époque de fin du sondage doit donc être égale à celle-ci. Si vous soumettez l'action à une époque ultérieure, désactivez l'option et définissez à la main une époque correspondante.",
  tooEarlyWarning:
    "L'époque de fin doit être postérieure à l'époque actuelle ({epoch}), sinon le sondage est clôturé dès sa publication.",

  // --- Visibility section ---
  sectionVisibility: "Visibilité",
  visPublicTitle: "Public",
  visPublicDesc:
    "Les réponses sont en clair, comptabilisées à mesure qu'elles arrivent.",
  visSealedTitle: "Scellé",
  visSealedDesc: "Chiffré par verrou temporel ; ouvre à un round drand.",
  drandChainLabel: "Chaîne drand",
  revealRoundLabel: "Round de révélation",
  drandAuto: "Auto",
  drandManual: "Manuel",
  drandAutoHint:
    "Dérivé de l'époque de fin — le premier round drand après la clôture des réponses.",
  drandRoundPlaceholder: "numéro de round drand",
  revealsOn: "Révèle {date}",
  revealsRoundOn: "round {round} · révèle {date}",
  paddingLabel: "Taille de remplissage (octets)",
  paddingAutoPlaceholder: "auto · {size}",
  paddingHint:
    "Chaque réponse est complétée par des zéros jusqu'à cette longueur avant chiffrement, afin que la taille du chiffré ne révèle pas l'étendue des réponses. Laissez vide pour dimensionner automatiquement au pire cas ({size} octets pour ces questions).",
  sealedNote:
    "Les réponses sont chiffrées au fur et à mesure de leur arrivée et restent cachées jusqu'au moment de la révélation — même vous ne pouvez pas les lire avant.",

  // --- Content section ---
  sectionContent: "Contenu",
  contentEmbeddedTitle: "Intégré",
  contentEmbeddedDesc:
    "Tout le texte on-chain. Aucune dépendance externe — recommandé.",
  contentExternalTitle: "Externe",
  contentExternalDesc:
    "Les énoncés et libellés vivent dans un document IPFS épinglé ; la chaîne porte une ancre de hachage.",
  contentExternalNote:
    "À la publication, le titre, la description, les énoncés et les libellés d'options sont écrits dans un document de présentation, épinglé sur vos fournisseurs IPFS, et ancré on-chain par son hachage blake2b-256. Seuls les décomptes, contraintes, le détenteur et le calendrier restent on-chain — le sondage reste donc valide et comptabilisable même si le document devient ensuite inaccessible (seuls les libellés disparaissent). Garde une charge utile on-chain réduite pour les grands sondages.",
  contentNoPinningPre: "Aucun fournisseur IPFS n'est configuré. ",
  contentNoPinningLink: "Ajoutez-en un dans les Paramètres",
  contentNoPinningPost:
    " pour publier du contenu externe, ou passez en mode Intégré.",

  // --- Questions section ---
  sectionQuestions: "Questions",
  addAQuestion: "Ajouter une question",
  questionChip: "Q{n}",
  required: "Obligatoire",
  optional: "Facultatif",
  removeQuestion: "Supprimer la question",
  promptPlaceholder: "Énoncé de la question",

  // --- Add-a-question buttons (short type names) ---
  addSingle: "Unique",
  addMulti: "Multiple",
  addRanking: "Classement",
  addNumeric: "Numérique",
  addPoints: "Points",
  addRating: "Évaluation",
  addCustom: "Personnalisé",

  // --- Options editor ---
  addOption: "+ Ajouter une option",
  addLevel: "+ Ajouter un niveau",
  scaleHint:
    "ordonné du pire → au meilleur · les réponses stockent l'indice à base 0",
  optionPlaceholder: "Option {n}",
  endBadgeWorst: "pire",
  endBadgeBest: "meilleur",
  removeOption: "Supprimer l'option {n}",

  // --- Min/max & numeric rows ---
  minOf: "min {label}",
  maxOf: "max {label}",
  selectionsLabel: "sélections",
  rankedLabel: "classées",
  min: "min",
  max: "max",
  step: "pas",
  stepOptional: "pas (facultatif)",
  numericStepPlaceholder: "1",

  // --- Points allocation ---
  budget: "Budget",

  // --- Rating ---
  ratingNumericScale: "Échelle numérique",
  ratingLabelledScale: "Échelle avec libellés",
  ratingRequireAllLabel: "Exiger la notation de chaque option",
  ratingRequireAllHint:
    "Activé, une réponse doit noter chaque option. Désactivez-le pour laisser les répondants n'en noter qu'une partie.",

  // --- Custom question ---
  customUriLabel: "URI du schéma de méthode",
  customUriPlaceholder: "ipfs://… ou https://…",
  customHashLabel: "Hachage du schéma (blake2b-256, hex)",
  customHashPlaceholder: "64 caractères hex",

  // --- Summary card ---
  summary: "Résumé",
  untitledSurvey: "Sondage sans titre",
  summaryQuestions: "Questions",
  summaryWhoResponds: "Qui répond",
  summaryEnds: "Fin",
  summaryVisibility: "Visibilité",
  noRolesSelected: "Aucun rôle sélectionné",
  endsNone: "—",
  endsEpoch: "époque {epoch}",
  summarySealedReveals: "Scellé · révèle {date}",
  summarySealed: "Scellé",
  summaryPublic: "Public",

  // --- Publish button & note ---
  publishBlockedNetwork: "Basculez votre wallet sur {network} avant de publier",
  publishBlockedNoIpfs:
    "Ajoutez un fournisseur IPFS dans les Paramètres pour publier du contenu externe",
  publishBlockedNoWallet: "Connectez un wallet pour publier",
  publishBlockedScriptOwner:
    "Ce wallet ne peut pas détenir de sondage : connectez-en un dont le credential de paiement est à clé",
  signAndPublish: "Signer et publier le sondage",
  publishNoteOkPre: "signe avec votre credential de détenteur · ",
  publishNoteOkPost: " · autorise l'annulation",
  publishNoteProblems: "{count} élément{plural} à corriger avant de publier",
  problemPluralSuffix: "s",

  // --- Problem list & section heads ---
  fixBeforePublishing: "À corriger avant de publier",
  problemInQuestion: "{question} {field}",

  // --- Survey file (export / import) ---
  fileHead: "Fichier du sondage",
  fileHint:
    "Enregistrez le sondage comme fichier de métadonnées cardano-cli (label 17, schéma détaillé), ou chargez-en un dans le formulaire.",
  exportFile: "Exporter",
  importFile: "Importer",
  exportNeedsValid:
    "L'export est disponible une fois que le sondage n'a plus rien à corriger.",
  exportOwnerNote:
    "Le fichier désigne la clé de votre wallet comme détentrice : la transaction qui le publie doit être signée par cette clé.",
  exportExternalWarning:
    "Le texte du sondage est dans son document de présentation, un second fichier. Épinglez ce fichier sans le modifier, puis remplacez {placeholder} dans le fichier de métadonnées par son URI (une URI de plus de 64 octets s'écrit comme une liste de chaînes).",
  exportPlaceholderOwner:
    "Aucun wallet connecté ne peut détenir ce sondage, le détenteur du fichier est donc un substitut : un hash de clé de 28 octets nuls. Publier le fichier tel quel achète un sondage que tout lecteur ignore ; remplacez-le par le hash de la clé qui signe la transaction de publication.",
  exportDocument: "Télécharger le document de présentation",
  importReplaceConfirm:
    "Remplacer le sondage du formulaire par celui importé ?",
  importReplace: "Remplacer",
  importKeep: "Garder le mien",
  importFailed: "Échec de l'import",
  importNoPresentation:
    "Ce sondage garde son texte dans un document de présentation qui n'a pas été importé : ses questions et libellés sont vides. Importez le document avec le fichier de métadonnées pour récupérer le texte.",

  // --- Submitted receipt ---
  surveyPublished: "Sondage publié",
  submittedBody:
    "Votre définition a été soumise sous le label de métadonnées 17. Elle peut mettre quelques instants à apparaître, le temps que l'indexeur se synchronise.",
  submittedRef: "réf {ref}",
  viewSurvey: "Voir le sondage →",
  allSurveysButton: "Tous les sondages",

  // --- Connect prompt ---
};

export default create;
