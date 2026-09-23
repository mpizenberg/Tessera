/**
 * Prints the credentials `amaru-store-reader snapshot` must be asked about
 * for one survey, read from the block walk in `<dir>/blocks.json`:
 *
 *   pnpm --silent --filter cardano-tessera-amaru credentials -- \
 *     --dir <dir> --survey <txHash>:<index> > <dir>/credentials.json
 */

import { resolve } from "node:path";
import { exit } from "node:process";
import { parseArgs } from "node:util";

import { surveyWindow } from "./chain";
import { askedCredentials } from "./credentials";
import { AmaruStores } from "./stores";

// `pnpm <script> -- <flags>` hands the script its `--` as well.
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const { values } = parseArgs({
  args,
  options: { dir: { type: "string" }, survey: { type: "string" } },
});
if (!values.dir || !values.survey) {
  console.error("usage: credentials --dir <dir> --survey <txHash>:<index>");
  exit(2);
}
try {
  // pnpm runs the script from its package; `INIT_CWD` is where it was invoked.
  const dir = resolve(process.env["INIT_CWD"] ?? "", values.dir);
  const window = surveyWindow(new AmaruStores(dir), values.survey);
  console.log(JSON.stringify(askedCredentials(window)));
} catch (err) {
  console.error(String(err));
  exit(2);
}
