import type { Messages } from "../en/pin";

const pin: Messages = {
  noProvider:
    "Aucun fournisseur IPFS configuré — ajoutez un jeton dans les Paramètres.",
  allFailed: "L'épinglage IPFS a échoué chez tous les fournisseurs — {detail}",
  nmkrToken: "le jeton doit être de la forme userId:apiKey",
};

export default pin;
