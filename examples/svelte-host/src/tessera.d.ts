// Types the <tessera-respond> tag for Svelte templates: camelCase entries are
// set as DOM properties (Svelte checks `key in element` at runtime), and the
// `ontessera:*` event attributes carry the typed CustomEvent details.
declare namespace svelteHTML {
  interface IntrinsicElements {
    "tessera-respond": Partial<
      import("cardano-tessera-respond/artifact").TesseraRespondElementProps
    > & {
      "ontessera:response"?: (
        e: CustomEvent<
          import("cardano-tessera-respond/artifact").RespondResult
        >,
      ) => void;
      "ontessera:change"?: (
        e: CustomEvent<
          import("cardano-tessera-respond/artifact").RespondChangeDetail
        >,
      ) => void;
      "ontessera:invalid"?: (
        e: CustomEvent<
          import("cardano-tessera-respond/artifact").RespondInvalidDetail
        >,
      ) => void;
    };
  }
}
