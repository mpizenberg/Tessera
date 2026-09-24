/**
 * The verifier's progress on stderr, one line per step. On a terminal a
 * step's counter is rewritten in place at the end of its line; elsewhere the
 * step's line is printed once, as it starts, and its counter not at all, so
 * a log keeps one line per step. Anything else printed meanwhile closes the
 * step's line first, so it never lands inside one.
 */

import { stderr } from "node:process";

/** Where progress is written: stderr, or a stand-in for it. */
export interface Output {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

export interface Counter {
  /** What one tick counts, singular: "Koios request". */
  readonly unit: string;
  /** How many ticks the step takes, when that is known up front. */
  readonly total?: number;
}

export class Progress {
  private text: string | null = null;
  private counter: Counter | undefined;
  private ticks = 0;
  /** A step's line is on screen, not yet ended by a newline. */
  private open = false;
  private readonly tty: boolean;

  constructor(private readonly out: Output = stderr) {
    this.tty = out.isTTY === true;
    for (const method of ["log", "warn", "error"] as const) {
      const print = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        this.close();
        print(...args);
      };
    }
    process.once("exit", () => this.close());
  }

  /** Starts a step; `counter` names what {@link tick} counts in it. */
  step(text: string, counter?: Counter): void {
    this.close();
    this.text = text;
    this.counter = counter;
    this.ticks = 0;
    if (this.tty) this.draw();
    else this.out.write(`${text}…\n`);
  }

  /** One more of what the current step counts; ignored when it counts none. */
  tick(): void {
    if (this.counter === undefined) return;
    this.ticks++;
    if (this.tty) this.draw();
  }

  /** Ends the current step; nothing more is drawn until the next one. */
  done(): void {
    this.close();
    this.text = null;
    this.counter = undefined;
  }

  private draw(): void {
    if (this.text === null) return;
    const c = this.counter;
    const n = c?.total ?? this.ticks;
    const count =
      c === undefined || this.ticks === 0
        ? ""
        : ` (${this.ticks}${c.total === undefined ? "" : `/${c.total}`} ${c.unit}${n === 1 ? "" : "s"})`;
    this.out.write(`\r\x1b[K${this.text}…${count}`);
    this.open = true;
  }

  private close(): void {
    if (!this.open) return;
    this.out.write("\n");
    this.open = false;
  }
}
