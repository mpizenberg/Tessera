/**
 * The survey the widget renders, read through `cardano-tessera-client` exactly
 * as a live host would — one bundle by reference, decoded into cip-179 types —
 * from a recorded preprod answer instead of the network. Swap `fetch` for the
 * global one and `baseUrl` for the deployed backend to go live.
 */

import {
  API_VERSION,
  createTesseraClient,
  type SurveyBundlePayload,
} from "cardano-tessera-client";

import { PREPROD_BUNDLE, PREPROD_SURVEY_KEY } from "./preprodBundle";

const [txHash, index] = PREPROD_SURVEY_KEY.split(":");

/** Answers the two routes the read below needs, from the recording. */
const recordedFetch: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path === "/health")
    return Response.json({
      ok: true,
      network: "preprod",
      apiVersion: API_VERSION,
    });
  if (path === `/api/surveys/${txHash}/${index}`)
    return Response.json(PREPROD_BUNDLE);
  return Response.json({ error: "not recorded" }, { status: 404 });
};

const client = createTesseraClient({
  baseUrl: "https://tessera-backend-preprod.recorded.invalid",
  network: "preprod",
  fetch: recordedFetch,
});

export async function loadSurvey(): Promise<SurveyBundlePayload> {
  const answer = await client.wholeBundle(PREPROD_SURVEY_KEY);
  if (!answer.ready) throw new Error("the recorded backend is always ready");
  return answer.body;
}
