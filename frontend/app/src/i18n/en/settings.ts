const settings = {
  // Page header
  title: "Settings",
  lead: "Stored only in this browser. None of it touches the on-chain payload — surveys always validate and tally from chain data alone.",

  // --- Off-chain content storage (IPFS providers) section ---
  storageSectionHead: "Off-chain content storage",
  storageHeading: "IPFS pinning services",
  // Prose split around inline-bold fragments (storageProseAuthor / storageProseEvery).
  storageProse1: "Needed only to ",
  storageProseAuthor: "author",
  storageProse2:
    " content the app stores off-chain — an external survey's presentation document, or a voter rationale. Enable one or more; each document is pinned to ",
  storageProseEvery: "every",
  storageProse3:
    " enabled service in parallel for wider availability (same content hash everywhere). Embedded surveys and reading never need these.",
  /** {count} is locale-formatted; "N enabled" provider count. */
  enabledCount: "{count} enabled",
  providerSet: "Set",
  providerNotSet: "Not set",
  /** aria-label on a provider's token input; {provider} is a provider name (Pinata/Blockfrost/NMKR). */
  providerTokenLabel: "{provider} API token",
  // Note split around the inline-bold algorithm name (storageNoteBlake).
  storageNote1:
    "Pinning keeps a document reachable; if it ever drops, surveys still validate and tally from on-chain data — only the presentation labels can't be rendered. The anchor hash is computed locally (",
  storageNoteBlake: "blake2b-256",
  storageNote2:
    ") from the exact bytes uploaded, so a provider can't alter what you anchor. Tokens stay in this browser only.",

  // --- Network & data source (Koios) section ---
  koiosSectionHead: "Network & data source",
  koiosHeading: "Network & Koios token",
  koiosProse:
    "Reads and transaction-building both go through the Tessera backend by default, so no Koios token is needed (transactions are still signed by your wallet). A token is only for the direct-Koios path, used when no backend is configured — then it reads chain data and builds transactions. Stored only in this browser; applies on save. Switching network reloads the app on Explore to apply the new endpoint.",
  networkLabel: "Network",
  dataSourceLabel: "Data source",
  dataSourceDirect: "Direct Koios",
  endpointLabel: "Koios endpoint",
  activeTokenLabel: "Koios token",
  tokenYours: "set",
  tokenNone: "none",
  koiosTokenLabel: "Your Koios token",
  koiosTokenPlaceholder: "paste a Koios bearer token",
  koiosTokenAria: "Koios bearer token",
  save: "Save",
  clearToken: "Clear",
  savedMsg: "✓ saved · snapshot reloaded",

  // --- Display preferences section ---
  displaySectionHead: "Display",
  detailHeading: "Detail level",
  // Prose split around inline-bold mode names (detailProsePro / detailProsePlain).
  detailProsePro: "Pro",
  detailProse1:
    " mode surfaces technical detail across the app — survey refs, epochs, drand rounds, padding sizes, and extra authoring fields. ",
  detailProsePlain: "Plain",
  detailProse2: " hides them. Also toggleable from the header.",
  displayModeAria: "Display mode",
  displayPlain: "Plain",
  displayPro: "Pro",

  // --- Language (already migrated) ---
  languageHeading: "Language",
  languageProse:
    "Choose the interface language. Numbers and units follow your choice too.",
};

export type Messages = typeof settings;
export default settings;
