#!/usr/bin/env node
/**
 * Regenerates preprod-fixtures.json from live sources: the raw label-17
 * metadata comes from Koios, the expected wire forms from the deployed
 * backend's own bundle responses — so the file records what the deployment
 * actually serves rather than a hand-maintained transcription.
 *
 * After adding a fixture transaction below, or intentionally changing the
 * wire format, run `node interop/generate-fixtures.mjs && pnpm format` and
 * review the diff.
 */

import { writeFile } from "node:fs/promises";

const BACKEND =
  "https://tessera-backend-preprod.matthieu-pizenberg.workers.dev";
const KOIOS = "https://preprod.koios.rest/api/v1";
const METADATA_LABEL = 17;

/** The on-chain fixture transactions, in chain order. */
const TRANSACTIONS = [
  {
    txHash: "5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d",
    kind: "definitions",
  },
  {
    txHash: "2811d86267bbf2108a153b1598bb6a02460ca007d456ae2c0fa3f6f67c1fcb14",
    kind: "responses",
  },
];

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      // Cloudflare rejects some default library user agents outright.
      "user-agent": "tessera-interop-fixtures",
      accept: "application/json",
      ...init.headers,
    },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} ${url} → ${res.status}`);
  return res.json();
}

const rows = await getJson(`${KOIOS}/tx_metadata`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ _tx_hashes: TRANSACTIONS.map((tx) => tx.txHash) }),
});
const label17ByTx = new Map(
  rows.map((row) => [row.tx_hash, row.metadata?.[String(METADATA_LABEL)]]),
);

// One bundle per defined survey, fetched in reference order. Definitions take
// their expected wire form straight from the bundle; the same bundles also
// carry every fixture response, since responses can only target these surveys.
const bundles = [];
for (const tx of TRANSACTIONS.filter((t) => t.kind === "definitions")) {
  const label17 = label17ByTx.get(tx.txHash);
  if (!label17) throw new Error(`no label-17 metadata for ${tx.txHash}`);
  for (let index = 0; index < label17[1].length; index++) {
    bundles.push(await getJson(`${BACKEND}/api/surveys/${tx.txHash}/${index}`));
  }
}

function expectedFor(tx) {
  if (tx.kind === "definitions") {
    return bundles
      .filter((b) => b.survey.txHash === tx.txHash)
      .map((b) => b.survey.definition);
  }
  return bundles
    .flatMap((b) => b.responses.filter((r) => r.txHash === tx.txHash))
    .sort((a, b) => a.responseIndex - b.responseIndex)
    .map((r) => r.response);
}

const record = {
  network: "preprod",
  metadataLabel: METADATA_LABEL,
  transactions: TRANSACTIONS.map((tx) => {
    const label17 = label17ByTx.get(tx.txHash);
    if (!label17) throw new Error(`no label-17 metadata for ${tx.txHash}`);
    const expected = expectedFor(tx);
    if (expected.length !== label17[1].length) {
      throw new Error(
        `${tx.txHash}: ${label17[1].length} on-chain items but the backend serves ${expected.length}`,
      );
    }
    return { ...tx, label17, expected };
  }),
};

const target = new URL("preprod-fixtures.json", import.meta.url);
await writeFile(target, JSON.stringify(record, null, 2) + "\n");
console.log(
  `wrote ${record.transactions.length} transactions to ${target.pathname}`,
);
