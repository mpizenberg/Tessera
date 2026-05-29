// Decrypt a tlock ciphertext once its target Drand round has been published.
//
//   npm run decrypt -- ballot.age
//   MAX_WAIT=120 npm run decrypt -- ballot.age
//
// Inputs are only the ciphertext file and the (hard-coded) quicknet chain URL.
// The target round R is read from the ciphertext's own tlock stanza, so this
// script shares no state with the encryptor — that is the auditability claim.
import { readFileSync } from "node:fs";
import {
  quicknetClient,
  QUICKNET_CHAIN_URL,
  timelockDecrypt,
  roundTime,
  decodeArmor,
  isProbablyArmored,
} from "./client.js";

const inFile = process.argv[2] ?? process.env.OUT ?? "ballot.age";
const maxWaitSec = Number(process.env.MAX_WAIT ?? 120);

if (!Number.isFinite(maxWaitSec) || maxWaitSec < 0) {
  throw new Error(`MAX_WAIT must be a non-negative number, got: ${process.env.MAX_WAIT}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The round number is the first arg of the age `tlock` stanza, in the (text)
// header of the age payload that the armor wraps.
function extractRound(ciphertext: string): number {
  const payload = isProbablyArmored(ciphertext) ? decodeArmor(ciphertext) : ciphertext;
  const match = payload.match(/->\s+tlock\s+(\d+)\s/);
  if (!match) {
    throw new Error("Could not find a tlock stanza in the ciphertext — is this a tlock file?");
  }
  return Number.parseInt(match[1], 10);
}

const ciphertext = readFileSync(inFile, "utf8");
const round = extractRound(ciphertext);

const client = quicknetClient();
const info = await client.chain().info();
const period = info.period * 1000;

const start = Date.now();
const deadline = start + maxWaitSec * 1000;
const readyAt = roundTime(info, round);

console.log(`chain url     : ${QUICKNET_CHAIN_URL}`);
console.log(`target round  : ${round}`);
console.log(`decryptable at: ${new Date(readyAt).toISOString()}`);

if (readyAt > deadline) {
  const wait = Math.ceil((readyAt - start) / 1000);
  throw new Error(
    `Round ${round} is decryptable in ~${wait}s, which exceeds MAX_WAIT=${maxWaitSec}s. ` +
      `Re-run later or raise MAX_WAIT.`,
  );
}

// Wait until the round's publication time, then poll until the beacon is live.
if (readyAt > Date.now()) {
  console.log(`waiting ~${Math.ceil((readyAt - Date.now()) / 1000)}s for round ${round}...`);
  await sleep(readyAt - Date.now());
}

let latest = await client.latest();
while (latest.round < round) {
  if (Date.now() > deadline) {
    throw new Error(`Timed out after ${maxWaitSec}s waiting for round ${round} (latest: ${latest.round}).`);
  }
  await sleep(period);
  latest = await client.latest();
}

const plaintext = await timelockDecrypt(ciphertext, client);
console.log(`\nplaintext     : ${JSON.stringify(plaintext.toString("utf8"))}`);
