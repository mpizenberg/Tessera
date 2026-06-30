import type { Messages } from "../en/appError";

const appError: Messages = {
  title: "Impossible de charger les données on-chain",
  body: "L'application n'a pas pu lire depuis Koios : {error}",
  tokenHint:
    "Votre jeton d'API Koios est peut-être invalide ou limité en débit. Renseignez le vôtre dans les Paramètres, puis réessayez.",
  retry: "Réessayer",
  openSettings: "Ouvrir les Paramètres",
};

export default appError;
