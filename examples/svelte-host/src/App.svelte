<script lang="ts">
  // Registers the element. Outside this repository the root import
  // (`import "cardano-tessera-respond"`) resolves to the same artifact.
  import "cardano-tessera-respond/artifact";
  import type { RespondResult } from "cardano-tessera-respond/artifact";

  import { TIP_EPOCH, definition, responder, show, surveyRef } from "./sample";

  let result = $state<RespondResult | null>(null);
</script>

<main>
  <h1>&lt;tessera-respond&gt; in Svelte</h1>
  <p>
    The widget below runs from mock props; a real host would fetch the
    definition from an indexer and derive the responder from a wallet.
    Submitting hands your code the label-17 payload — attaching, proving,
    signing, and submitting stay host-side.
  </p>
  <!-- The colon in the event attribute is legal on elements (it compiles to
       addEventListener("tessera:response", …)); the warning it silences only
       guards against confusion with Svelte's own directives. -->
  <!-- svelte-ignore attribute_illegal_colon -->
  <tessera-respond
    {definition}
    {surveyRef}
    {responder}
    tipEpoch={TIP_EPOCH}
    ontessera:response={(e) => (result = e.detail)}
  ></tessera-respond>
  {#if result}
    <h2>
      Emitted payload (role {result.role}, prove {result.proveCredentials
        .map((p) => p.keyKind)
        .join(" + ")})
    </h2>
    <pre>{show(result.payload)}</pre>
  {/if}
</main>

<style>
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1.5rem;
  }
  pre {
    overflow-x: auto;
  }
</style>
