import { useState } from "react";
import {
  TesseraRespond,
  type RespondResult,
} from "cardano-tessera-respond-react";

import { TIP_EPOCH, definition, responder, show, surveyRef } from "./sample";

export function App() {
  const [result, setResult] = useState<RespondResult | null>(null);
  return (
    <main style={{ maxWidth: "48rem", margin: "0 auto", padding: "1.5rem" }}>
      <h1>&lt;tessera-respond&gt; in React</h1>
      <p>
        The widget below runs from mock props; a real host would fetch the
        definition from an indexer and derive the responder from a wallet.
        Submitting hands your code the label-17 payload — attaching, proving,
        signing, and submitting stay host-side.
      </p>
      <TesseraRespond
        definition={definition}
        surveyRef={surveyRef}
        responder={responder}
        tipEpoch={TIP_EPOCH}
        onResponse={setResult}
      />
      {result && (
        <>
          <h2>
            Emitted payload (role {result.role}, prove{" "}
            {result.proveCredentials.map((p) => p.keyKind).join(" + ")})
          </h2>
          <pre style={{ overflowX: "auto" }}>{show(result.payload)}</pre>
        </>
      )}
    </main>
  );
}
