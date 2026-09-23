/**
 * One Dolos node's store, read two ways that exclude each other: served, for
 * the chain's routes, and dumped entity by entity with `dolos data
 * dump-entity`, for the ledger values no route serves. Dolos locks a store
 * while it serves it, so a dump stops the server first. Serving never syncs,
 * so the store stays where its replay stopped.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { Minibf } from "./minibfClient";
import { OVERLAY, PORTS } from "./build";

/** How long `dolos serve` may take to answer before it counts as failed. */
const SERVE_TIMEOUT_MS = 120_000;

export class DolosNode {
  private server: { child: ChildProcess; exited: Promise<void> } | null = null;

  constructor(readonly dir: string) {}

  /** Serves the store with the audit overlay and waits until it answers. */
  async serve(): Promise<{ minibf: Minibf; minikupo: string }> {
    const minibf = new Minibf(`http://localhost:${PORTS.minibf}`);
    const minikupo = `http://localhost:${PORTS.minikupo}`;
    if (this.server) return { minibf, minikupo };
    let output = "";
    const child = spawn("dolos", ["-c", OVERLAY, "serve"], { cwd: this.dir });
    child.stdout?.on("data", (c) => (output += String(c)));
    child.stderr?.on("data", (c) => (output += String(c)));
    let gone = false;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => {
        gone = true;
        resolve();
      }),
    );
    const stop = () => child.kill("SIGINT");
    process.once("exit", stop);
    void exited.then(() => process.off("exit", stop));
    this.server = { child, exited };
    const deadline = Date.now() + SERVE_TIMEOUT_MS;
    for (;;) {
      if (gone) {
        this.server = null;
        throw new Error(
          `\`dolos serve\` in ${this.dir} exited: ${output.trim().split("\n").slice(-3).join(" / ")}`,
        );
      }
      try {
        await minibf.get("/blocks/latest");
        return { minibf, minikupo };
      } catch {
        if (Date.now() > deadline) {
          await this.stop();
          throw new Error(
            `\`dolos serve\` in ${this.dir} did not answer within ${SERVE_TIMEOUT_MS / 1000} s`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /** Stops serving, and waits until the store's lock is released. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const { child, exited } = this.server;
    this.server = null;
    child.kill("SIGINT");
    await exited;
  }

  /** The slot of the block the store's ledger state stands at. */
  async tipSlot(): Promise<number | null> {
    const out = await this.run(["data", "summary"]);
    return (JSON.parse(out) as { state: { tip_slot: number | null } }).state
      .tip_slot;
  }

  /** The entity stored under `key` (hex), as `Debug` text; null when none. */
  async dump(
    namespace: "accounts" | "dreps" | "pools",
    key: string,
  ): Promise<string | null> {
    const out = await this.run([
      "data",
      "dump-entity",
      "--namespace",
      namespace,
      "--key",
      key,
    ]);
    return out.trim() === "entity not found" ? null : out;
  }

  private async run(args: readonly string[]): Promise<string> {
    await this.stop();
    const run = spawnSync("dolos", args, {
      cwd: this.dir,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    if (run.status !== 0)
      throw new Error(
        `\`dolos ${args.join(" ")}\` failed in ${this.dir}: ${(run.stderr || String(run.error)).trim()}`,
      );
    return run.stdout;
  }
}
