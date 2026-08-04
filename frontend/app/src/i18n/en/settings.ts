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
    "Reads and transaction-building both go through the Tessera backend by default, so no Koios token is needed (transactions are still signed by your wallet). A token is only for the direct-Koios path — emergency direct mode below, or a build with no backend configured — where it reads chain data and builds transactions. Stored only in this browser; applies on save. Each deployment serves a single network.",
  networkLabel: "Network",
  /** {network} is a network identifier, untranslated. */
  networkLink: "open the {network} app ↗",
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
  indexerUrlLabel: "Your backend URL",
  indexerUrlPlaceholder: "https://… (empty = direct Koios)",
  indexerUrlAria: "Tessera backend URL",
  indexerUrlHint:
    "Overrides the built-in backend for this network, in this browser only. It must serve the same network — the app checks and refuses a mismatched backend. Saving or clearing reloads the app.",
  directModeLabel: "Emergency direct mode",
  directModeProse:
    "If the backend is down, this browser can keep participating by reading the chain and building transactions via Koios directly, with your token. Responses shown that way are unverified — credential proofs and voting weights are only checked at finalization — and finalized results are unavailable. The mode expires on its own after 24 hours; your token stays saved either way.",
  directModeActivate: "Read via Koios for 24 h",
  /** {time} is a local wall-clock datetime, e.g. "Jul 31, 2026, 14:05". */
  directModeActive: "Active — the backend resumes {time}",
  directModeDeactivate: "Back to the backend now",
  directModeNeedsToken:
    "Save a Koios token above first — direct reads are impossible without one.",

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
