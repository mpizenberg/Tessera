import type { Messages } from "../en/appError";

const appError: Messages = {
  title: "Impossible de charger les données on-chain",
  bodyBackend:
    "L'application n'a pas pu lire depuis le backend Tessera sur {url} : {error}",
  bodyKoios: "L'application n'a pas pu lire depuis Koios : {error}",
  backendHint:
    "Le backend est peut-être inaccessible ou en cours de déploiement. Réessayez ; si l'échec persiste, les Paramètres proposent le mode direct d'urgence pour continuer à participer via Koios.",
  tokenHint:
    "Votre jeton d'API Koios est peut-être invalide ou limité en débit. Renseignez le vôtre dans les Paramètres, puis réessayez.",
  retry: "Réessayer",
  openSettings: "Ouvrir les Paramètres",
};

export default appError;
