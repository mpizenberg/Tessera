import { useEffect, useState } from "react";
import {
  TesseraRespond,
  type RespondResult,
} from "cardano-tessera-respond-react";
import type { SurveyBundlePayload } from "cardano-tessera-client";

import { responder, show } from "./sample";
import { loadSurvey } from "./tessera";

export function App() {
  const [bundle, setBundle] = useState<SurveyBundlePayload | null>(null);
  const [result, setResult] = useState<RespondResult | null>(null);
  useEffect(() => {
    void loadSurvey().then(setBundle);
  }, []);
  return (
    <main style={{ maxWidth: "48rem", margin: "0 auto", padding: "1.5rem" }}>
      <h1>&lt;tessera-respond&gt; in React</h1>
      <p>
        The survey below is a real preprod bundle read through{" "}
        <code>cardano-tessera-client</code> (from a recording, so this page runs
        offline); the responder is a mock a real host derives from a wallet.
        Submitting hands your code the label-17 payload — attaching, proving,
        signing, and submitting stay host-side.
      </p>
      {bundle && (
        <TesseraRespond
          definition={bundle.survey.definition}
          surveyRef={bundle.survey.ref}
          responder={responder}
          // A live host passes the calendar's epoch, `currentEpoch(network)`
          // from the client package; the recording keeps its own tip so the
          // survey stays answerable after it has closed on chain.
          tipEpoch={bundle.tip.epoch}
          onResponse={setResult}
        />
      )}
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
