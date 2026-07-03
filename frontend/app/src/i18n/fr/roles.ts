import type { Messages } from "../en/roles";

const roles: Messages = {
  drep: "Un délégué représentant enregistré — revendiqué dans le navigateur via la clé DRep CIP-95 de votre portefeuille.",
  spo: "Un opérateur de pool de stake — prouvé avec les clés de pool (froides/chaudes) qu'un portefeuille de navigateur ne peut pas détenir.",
  cc: "Un membre du Comité constitutionnel — prouvé avec les clés du comité qu'un portefeuille de navigateur ne peut pas détenir.",
  stakeholder:
    "Tout détenteur d'ada avec une clé de stake — revendiqué dans le navigateur par votre portefeuille connecté.",
  keyholder:
    "Quiconque possède un portefeuille — revendiqué dans le navigateur avec votre clé de paiement (dépense) ; aucune inscription ni activité on-chain requise.",
};

export default roles;
