// Encrypt a message to a near-future Drand quicknet round R.
//
//   npm run encrypt -- "my ballot"
//   MESSAGE="my ballot" DELAY_MS=30000 OUT=ballot.age npm run encrypt
//
// Writes the armored tlock ciphertext to OUT (default ballot.age) and prints R.
// The ciphertext is self-describing: R and the chain hash live in its tlock
// stanza, so decryption needs nothing but the ciphertext and the chain URL.
import { writeFileSync } from "node:fs";
import {
  quicknetClient,
  QUICKNET_CHAIN_URL,
  timelockEncrypt,
  roundAt,
  roundTime,
  Buffer,
} from "./client.js";

const message = process.argv[2] ?? process.env.MESSAGE ?? "ballot";
const outFile = process.env.OUT ?? "ballot.age";
const delayMs = Number(process.env.DELAY_MS ?? 30_000);

if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error(`DELAY_MS must be a non-negative number, got: ${process.env.DELAY_MS}`);
}

const client = quicknetClient();
const info = await client.chain().info();

const targetTime = Date.now() + delayMs;
const round = roundAt(targetTime, info);

const ciphertext = await timelockEncrypt(round, Buffer.from(message, "utf8"), client);
writeFileSync(outFile, ciphertext);

const readyAt = new Date(roundTime(info, round));
console.log(`network       : ${info.metadata?.beaconID ?? "?"} (scheme ${info.schemeID})`);
console.log(`chain url     : ${QUICKNET_CHAIN_URL}`);
console.log(`message       : ${JSON.stringify(message)} (${Buffer.from(message, "utf8").length} bytes)`);
console.log(`target round  : ${round}`);
console.log(`decryptable at: ${readyAt.toISOString()} (~${Math.round(delayMs / 1000)}s from now)`);
console.log(`ciphertext    : ${outFile}`);
