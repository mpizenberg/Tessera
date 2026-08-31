/**
 * Note the localization beyond words : octets pour bytes, et le vocabulaire de
 * gouvernance (Info Action, end_epoch, body.cip179) gardé en jetons techniques.
 * Le groupement des nombres est géré par `n()` via Intl, pas ici.
 */
import type { Messages } from "../en/linkSurvey";

const linkSurvey: Messages = {
  // En-tête / introduction
  backToSurvey: "Retour au sondage",
  govPill: "Gouvernance",
  title: "Lier à une action de gouvernance",
  leadPre:
    "Produisez le document de métadonnées CIP-108 qui annonce ce sondage, hébergez-le, puis construisez et signez l'",
  leadPost:
    " Conway qui le porte. L'action n'a aucun effet on-chain — elle se contente d'orienter les votants vers le sondage — et son dépôt remboursable revient à votre adresse de staking lorsqu'elle est ratifiée ou expire.",

  // Le sondage à lier (chargé depuis son bundle)
  linkingLabel: "Sondage à lier",
  untitledSurvey: "Sondage sans titre",
  endEpochLine: "end_epoch {endEpoch}",
  loadingSurvey: "Chargement du sondage…",
  surveyNotFound: "Sondage introuvable.",
  surveyLoadFailed:
    "Impossible de charger le sondage. Il n'est peut-être pas encore indexé.",
  retry: "Réessayer",
  badKey: "Ce n'est pas une référence de sondage.",

  // Problèmes de validation (vérification de la forme du JSON)
  problemNotJson: "JSON invalide : {message}",
  problemMissingContext:
    "Champ JSON-LD « @context » manquant (termes CIP-100/108).",
  problemContextMissingCip179Terms:
    "Le « @context » doit définir l'espace de noms CIP179 et déclarer « cip179 » (avec ses sous-termes specVersion, kind, surveyTxId et surveyIndex) dans le contexte du corps, sinon le lien est supprimé lors de la canonicalisation JSON-LD et sort du témoin d'auteur. Voir l'exemple complet du CIP-179.",

  // Notes d'alignement d'époque
  alignTipNotLoaded:
    "Pointe de chaîne pas encore chargée — impossible de vérifier l'alignement d'époque.",
  alignSurveyNotOnchain:
    "Le sondage lié n'est pas encore on-chain — impossible de vérifier son end_epoch. Assurez-vous qu'il est publié et indexé.",
  alignLifetimeUnknown:
    "gov_action_lifetime est inconnu — impossible de calculer l'échéance du vote.",
  alignAligned:
    "Aligné — l'époque courante {epoch} est l'époque de soumission : proposer maintenant fixe l'échéance du vote à l'époque {end}, correspondant au end_epoch du sondage. Cette fenêtre se ferme le {windowEnd}.",
  alignTooEarly:
    "Trop tôt — proposez pendant l'époque {submitEpoch} ({windowStart} → {windowEnd}) pour que l'échéance de l'action corresponde au end_epoch {end} du sondage. L'époque courante est {epoch} ; proposer maintenant fixerait l'échéance à l'époque {deadline}.",
  alignWindowPassed:
    "Fenêtre dépassée — le sondage se termine à l'époque {end}, donc l'action devait être proposée pendant l'époque {submitEpoch} ({windowStart} → {windowEnd}). L'époque courante est {epoch} ; le lien vers ce sondage ne peut plus se former.",

  // Étape 1 · Le document
  step1Head: "1 · Le document",
  entryQuestion:
    "Créer les métadonnées de l'action de gouvernance de zéro, ou partir d'un document JSON CIP-108 que vous avez déjà ?",
  entryFromScratch: "Créer de zéro",
  entryFromScratchHint:
    "Un formulaire minimal produisant une base CIP-108 valide pour l'Info Action, lien de sondage inclus.",
  entryUpload: "J'ai un document",
  entryUploadHint:
    "Produit par votre outillage de gouvernance et pas encore lié — le lien de sondage est inséré pour vous.",
  entryChange: "Recommencer",

  // Formulaire « de zéro »
  formTitle: "Titre",
  formTitleHint: "Affiché sur la page du sondage comme « Annoncé par … ».",
  formAbstract: "Résumé",
  formMotivation: "Motivation",
  formRationale: "Justification",
  formGenerate: "Générer le document lié",

  // Branche « document existant »
  uploadHintPre: "Choisissez le fichier ",
  uploadHintMid:
    " CIP-108 produit par votre outillage de gouvernance, sans aucun lien de sondage. Il est lu localement ; le lien ",
  uploadHintPost:
    " et ses termes @context sont insérés, et le document réémis.",
  refusalNotJson: "JSON invalide : {message}",
  refusalNotObject:
    "Pas un document CIP-108 — le niveau supérieur n'est pas un objet JSON.",
  refusalNoBody: "Pas un document CIP-108 — il n'a pas d'objet « body ».",
  refusalNoContext:
    "Pas un document JSON-LD — il n'a pas d'objet « @context » où fusionner les termes CIP-179.",
  refusalAlreadyLinkedTo:
    "Ce document lie déjà le sondage {ref}. L'outillage de gouvernance n'écrit jamais body.cip179 — repartez du document non lié, ou liez ce sondage depuis sa propre page.",
  refusalAlreadyLinked:
    "Ce document porte déjà une entrée body.cip179 (malformée). L'outillage de gouvernance n'écrit jamais ce champ — repartez du document non lié.",
  strippedAuthors:
    "La section authors du document a été vidée : son témoin signait le corps non lié et ne peut pas survivre à cette modification. Faites re-signer le document émis par chaque auteur si vous avez besoin du témoin.",

  // Étape 2 · Héberger le document
  step2Head: "2 · Héberger le document",
  ready: "Document prêt",
  problemsTitle: "Lien de sondage CIP-179 invalide :",
  linksToSurvey: "Lien vers le sondage",
  refIndex: " · index {index}",
  hostHintPre:
    "Hébergez ces octets exacts à une URL publique (un lien brut GitHub, ou ajoutez un fournisseur IPFS dans ",
  hostHintPost: " pour épingler depuis ici), puis collez l'URL ci-dessous.",
  settingsLinkText: "Paramètres",
  pinHint:
    "Épinglez aux fournisseurs IPFS configurés dans vos Paramètres, en un clic. Les octets exacts ci-dessous sont épinglés, donc le document servi correspond au hash on-chain.",
  pinning: "Épinglage…",
  pinToIpfs: "Épingler sur IPFS",
  downloadJsonld: "Télécharger le .jsonld",
  copiedHash: "Hash copié ✓",
  copyAnchorHash: "Copier le hash de l'ancre",
  pinnedNote: "Épinglé sur {providers}. URL renseignée ci-dessous.",
  anchorHashLabel: "Hash de l'ancre (blake2b-256)",
  urlPlaceholder: "ipfs://… ou https://…/info-action-survey-link.jsonld",
  urlHint:
    "Renseignée automatiquement lorsque vous épinglez sur IPFS ci-dessus ; sinon, collez l'endroit où vous avez hébergé le document. Stockée on-chain avec son hash.",
  urlInvalidPre: "L'URL de l'ancre doit être une adresse ",
  urlInvalidMid: " ou ",
  urlInvalidPost: " — celle-ci sera rejetée avant la signature.",

  // Étape 3 · Signer & soumettre
  step3Head: "3 · Signer & soumettre",
  submitSectionNote:
    "Tessera construit et soumet une Info Action. Pour tout autre type d'action, téléchargez le document et attachez son URL et son hash avec votre propre outillage.",
  connectWallet:
    "Connectez un portefeuille CIP-30 (en haut à droite) pour signer la proposition.",
  networkMismatch:
    "Votre portefeuille est sur un réseau différent de celui de l'application ({network}). Changez-le avant de soumettre.",
  resolveIssues:
    "Corrigez les problèmes ci-dessus avant de soumettre — l'action ne serait pas un lien de sondage CIP-179 valide.",
  building: "Construction & signature…",
  submit: "Construire, signer & soumettre",
  submittedTitle: "Proposition soumise ✓",
  submittedHint:
    "Une fois dans un bloc, la page du sondage l'affichera comme « Lié à la gouvernance » après que l'indexeur a résolu l'ancre.",
};

export default linkSurvey;
