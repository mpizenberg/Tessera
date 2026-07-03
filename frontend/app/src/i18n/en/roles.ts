/** One-line explanation of what each CIP-179 role is and how it's claimed. */

const roles = {
  drep: "A registered delegate representative — claimed in-browser via your wallet's CIP-95 DRep key.",
  spo: "A stake pool operator — proven with cold/hot pool keys a browser wallet can't hold.",
  cc: "A Constitutional Committee member — proven with committee keys a browser wallet can't hold.",
  stakeholder:
    "Any ada holder with a stake key — claimed in-browser by your connected wallet.",
  keyholder:
    "Anyone with a wallet — claimed in-browser with your payment (spending) key; no registration or on-chain activity needed.",
};

export type Messages = typeof roles;
export default roles;
