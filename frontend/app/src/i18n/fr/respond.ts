/**
 * Note la localisation au-delà des mots : « bytes » devient « octets » (symbole
 * « o »). Le groupement des nombres (1 024 vs 1,024) est géré par `n()` via Intl,
 * pas ici.
 */
import { frMessages } from "cardano-tessera-respond-core";

import type { Messages } from "../en/respond";

const respond: Messages = {
  ...frMessages.respond,

  // --- Chaînes partagées que l'app formule autrement (elle a un portefeuille)
  ineligibleLead:
    "Elle n'est ouverte qu'aux rôles ci-dessous, et votre portefeuille connecté ne peut en revendiquer aucun ici. Voici ce que signifie chacun :",
  notClaimable: " Non revendicable dans un portefeuille de navigateur.",

  // --- Top-level navigation / progress ------------------------------------
  backToResults: "Retour aux résultats",
  submitting: "Envoi…",
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

  // --- Définition invalide (le widget n'en affiche jamais) ----------------
  untalliableTitle: "La définition de ce sondage est invalide",
  untalliableBody:
    "Sa définition on-chain n'est pas conforme à CIP-179 v5 (mauvaise version de spec, ou une contrainte interdite par la spec) : elle est donc non décomptable et aucun lecteur conforme ne la compte. Répondre gaspillerait des frais, l'envoi est donc désactivé.",

  // --- Connect prompt ------------------------------------------------------
  connectTitle: "Connectez un portefeuille pour répondre",
  connectBody:
    "Utilisez le bouton « Connecter un portefeuille » dans l'en-tête. L'éligibilité est vérifiée par rapport aux identifiants de votre portefeuille. Vous pouvez lire le sondage et ses résultats sans vous connecter.",

  // --- Header --------------------------------------------------------------
  refTitle:
    "Référence complète du sondage — hash de la transaction de définition et index de sortie",
  refPrefix: "réf {ref}",

  // --- Vote deadline --------------------------------------------------------
  deadlinePassed:
    "Le vote s'est clos pendant que cette page était ouverte — une réponse envoyée maintenant serait exclue du dépouillement.",
  deadlineSoon:
    "Le vote se clôt dans environ {m} min — envoyez maintenant, sinon votre réponse risque d'arriver trop tard.",

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

  // --- Submit bar ----------------------------------------------------------
  switchNetwork: "Basculez votre portefeuille sur {network} pour envoyer",

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
};

export default respond;
