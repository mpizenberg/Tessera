import { afterEach, describe, expect, it } from "vitest";

import { Progress } from "./progress";

const { log, warn, error } = console;

afterEach(() => {
  Object.assign(console, { log, warn, error });
});

function progressOn(isTTY: boolean) {
  let written = "";
  const progress = new Progress({
    isTTY,
    write: (text: string) => (written += text),
  });
  // What a terminal shows: each `\r` + clear-line redraws the current line.
  const screen = () =>
    written
      .split("\n")
      .map((line) => line.split("\r\x1b[K").at(-1))
      .join("\n");
  return { progress, screen };
}

describe("Progress", () => {
  it("rewrites a step's counter in place on a terminal", () => {
    const { progress, screen } = progressOn(true);
    progress.step("reading", { unit: "credential", total: 3 });
    progress.tick();
    progress.tick();
    progress.step("reading the total", { unit: "Koios request" });
    progress.tick();
    progress.done();
    expect(screen()).toBe(
      "reading… (2/3 credentials)\nreading the total… (1 Koios request)\n",
    );
  });

  it("prints each step once off a terminal, without counters", () => {
    const { progress, screen } = progressOn(false);
    progress.step("reading", { unit: "credential", total: 3 });
    progress.tick();
    progress.step("cross-checking");
    progress.done();
    expect(screen()).toBe("reading…\ncross-checking…\n");
  });

  it("ends a step's line before anything else is printed", () => {
    let atNote = "";
    console.warn = () => (atNote = screen());
    const { progress, screen } = progressOn(true);
    progress.step("reading", { unit: "Koios request" });
    progress.tick();
    console.warn("note");
    progress.tick();
    progress.done();
    expect(atNote).toBe("reading… (1 Koios request)\n");
    expect(screen()).toBe(
      "reading… (1 Koios request)\nreading… (2 Koios requests)\n",
    );
  });
});
