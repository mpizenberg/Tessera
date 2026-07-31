import type { Messages } from "../en/cart";

const cart: Messages = {
  // Header badge + drawer chrome.
  open: "Actions en attente et en cours",
  queuedHeading: "En attente de publication",
  inFlightHeading: "En cours",

  // A queued action, by kind.
  queuedSurvey: "Publier un sondage",
  queuedResponse: "Répondre à un sondage",
  queuedCancel: "Annuler un sondage",
  queuedGovAction: "Référencer un sondage on-chain",
  remove: "Retirer",

  // Partition preview: how the queue becomes transactions.
  planPending: "Calcul des transactions…",
  planTx: "Transaction {n}",
  planChained:
    "Dépense une sortie de la transaction qui publie son sondage : les deux sont incluses ensemble, ou aucune.",
  planNote:
    "CIP-179 n'autorise qu'un type d'événement par transaction ; le reste est regroupé pour économiser des frais.",
  planMissingSignature:
    "Nécessite une signature de {credential} — connectez ce portefeuille avant de publier.",

  // Publishing.
  submit: "Signer et publier",
  submitting: "Publication…",
  submitHint:
    "Chaque transaction est signée à son tour ; rien n'est envoyé tant qu'elles ne le sont pas toutes.",
  connectWallet:
    "Connectez un portefeuille pour publier ce que vous avez mis en attente.",

  // Gathering signatures: the chain is built and waits for the keys it needs.
  signingHeading: "En cours de publication",
  signMissing: "En attente d'une signature de {credential}.",
  signHeldHere: "Le portefeuille connecté détient cette clé.",
  signComplete: "Signée.",
  signSwitchWallet:
    "Connectez le portefeuille qui détient chaque clé et signez à nouveau — vous déconnecter ne perd pas les signatures déjà obtenues. Rien n'est envoyé tant que chaque transaction n'est pas complète.",
  signWithWallet: "Signer avec ce portefeuille",
  signingNow: "Signature…",
  publish: "Publier",
  discard: "Abandonner",
  discardHint:
    "Abandonner jette les transactions et les signatures obtenues ; rien n'a été envoyé, et ce qu'elles publient reste dans votre panier.",

  // What a screen shows once it queued an action instead of publishing it.
  addToCart: "Ajouter au panier",
  queuedTitle: "Ajouté à votre panier",
  queuedBody:
    "Ce sera publié avec le reste de votre panier, regroupé en aussi peu de transactions que CIP-179 le permet.",
  queuedOpen: "Ouvrir le panier",
  signingTitle: "Votre panier est en cours de publication",
  signingBody:
    "Ses transactions sont construites et attendent d'être envoyées : le panier n'accepte rien d'autre tant que ce n'est pas fait — ou abandonné. Ouvrez-le pour voir ce qu'il reste à faire.",

  // In-flight rows (transactions submitted, chain not yet showing them).
  pendingHeadline: "{label}…",
  pendingSurvey: "Publication du sondage",
  pendingResponse: "Envoi de la réponse",
  pendingCancel: "Annulation du sondage",
  pendingGovAction: "Envoi de l'action de gouvernance",
  confirmedSurvey: "Sondage publié",
  confirmedResponse: "Réponse confirmée",
  confirmedCancel: "Sondage annulé",
  confirmedGovAction: "Action de gouvernance envoyée",
  dismiss: "Ignorer",
  stalled: "Aucun bloc n'a inclus cette transaction depuis 10 minutes.",
  stalledChoice:
    "Diffusez-la à nouveau, ou oubliez-la — l'oublier remet son contenu dans votre panier, mais la transaction elle-même peut encore être incluse plus tard.",
  rebroadcast: "Diffuser à nouveau",
  rebroadcasting: "Diffusion…",
  forget: "Oublier",
  viewSurvey: "Voir le sondage →",
};

export default cart;
