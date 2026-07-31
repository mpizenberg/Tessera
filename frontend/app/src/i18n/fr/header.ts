import type { Messages } from "../en/header";

const header: Messages = {
  // Primary navigation.
  navExplore: "Explorer",
  navCreate: "Créer",
  navSettings: "Paramètres",

  // Network tag in the bar.
  activeNetwork: "Réseau actif",

  // Pending-transactions dropdown.
  pendingTransactions: "Transactions en attente",
  dismiss: "Ignorer",
  pendingHeadline: "{label}…",
  pendingSurvey: "Publication du sondage",
  pendingResponse: "Envoi de la réponse",
  pendingCancel: "Annulation du sondage",
  pendingGovAction: "Envoi de l'action de gouvernance",
  confirmedSurvey: "Sondage publié",
  confirmedResponse: "Réponse confirmée",
  confirmedCancel: "Sondage annulé",
  confirmedGovAction: "Action de gouvernance envoyée",
  stalled: "Aucun bloc n'a inclus cette transaction depuis 10 minutes.",
  stalledChoice:
    "Diffusez-la à nouveau, ou oubliez-la — l'oublier empêche seulement cette application de la suivre, et la transaction peut encore être incluse plus tard.",
  rebroadcast: "Diffuser à nouveau",
  rebroadcasting: "Diffusion…",
  forget: "Oublier",
  viewSurvey: "Voir le sondage →",

  // Plain/Pro display-mode toggle.
  displayMode: "Mode d'affichage",
  displayPlain: "Simple",
  displayPro: "Pro",

  // Connect / identity button.
  connecting: "Connexion…",
  connectWallet: "Connecter un portefeuille",
  noRole: "Aucun rôle",

  // Wallet picker.
  connectCip30: "Connecter un portefeuille CIP-30",
  noWalletDetected: "Aucun portefeuille CIP-30 détecté dans ce navigateur.",

  // Role menu.
  respondAs: "Répondre en tant que · 1 portefeuille",
  noClaimableRole:
    "Ce portefeuille ne détient aucun rôle revendicable : répondre depuis le navigateur exige un identifiant à clé, et ceux de ce portefeuille sont à script.",
  networkMismatch:
    "Le portefeuille est sur un réseau différent de celui de l'application ({network}). Changez de réseau dans votre portefeuille.",
  disconnect: "Déconnecter",

  // Network section (one network per deployment; a link opens the other app).
  network: "Réseau",
  oneNetworkNote: "Un seul réseau par déploiement.",
};

export default header;
