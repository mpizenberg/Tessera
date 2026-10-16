/**
 * The progress squares' layout, which depends on the question count: a
 * container query on the squares' row picks their size and lines from its
 * width, against breakpoints only the count can give. The squares' look is
 * each host's, through the class map; their box and font size are set here.
 *
 * The ladder: 20px squares on one line while they fit, else 16px on one line,
 * else 20px in balanced lines (32 squares on a line of 24 break 16 and 16, not
 * 24 and 8). With Previous and Next, "on one line" means between them, and
 * the balanced lines go above them; the squares never take two lines between
 * the buttons, unless the buttons outgrow the width kept for them. With
 * `scroll`, a touch screen gets one line of 20px squares that scrolls
 * sideways, its edges faded where more squares are hidden.
 */

/** A square's side, its number's size, and the gap after it. */
const BIG = 20;
const SMALL = 16;
const FONT = { [BIG]: 10.5, [SMALL]: 9 };
const GAP = 4;
/** Between the squares and Previous or Next. */
const NAV_GAP = 10;
/** Around a scrolling line, which clips: the focus ring's reach. */
const PAD = 7;
const FADE = 24;

export interface SquaresLayout {
  /** The row's container name, also its `data-squares-row` value. */
  readonly name: string;
  readonly count: number;
  /** Width kept for Previous and Next beside the squares; without it, no nav. */
  readonly room?: number | undefined;
  /** One scrolling line on a touch screen, in place of lines. */
  readonly scroll?: boolean | undefined;
}

/** The style sheet text laying out one row of squares. */
export function squaresRules({
  name,
  count,
  room,
  scroll,
}: SquaresLayout): string {
  const row = `[data-squares-row="${name}"]`;
  const line = `${row} [data-squares]`;
  const at = (min: number, rules: string) =>
    `@container ${name} (width >= ${min}px) {\n${rules}}\n`;
  // One line of n squares, and what it leaves either side for the buttons.
  const width = (side: number, n: number) => n * (side + GAP) - GAP;
  const beside = room === undefined ? 0 : room + 2 * NAV_GAP;

  const base =
    `${row} { container: ${name} / inline-size; width: 100%; }\n` +
    `${line} { --sq: ${BIG}px; font-size: ${FONT[BIG]}px; display: grid; ` +
    `grid-template-columns: repeat(auto-fill, var(--sq)); ` +
    `justify-content: center; gap: 7px ${GAP}px; }\n` +
    `${line} > * { box-sizing: border-box; width: var(--sq); height: var(--sq); }\n` +
    (room === undefined
      ? ""
      : `${row} [data-squares-nav] { display: grid; ` +
        `grid-template-columns: auto minmax(0, 1fr) auto; ` +
        `grid-template-areas: "line line line" "prev count next"; ` +
        `align-items: center; gap: 12px ${NAV_GAP}px; }\n` +
        `${line} { grid-area: line; }\n` +
        `${row} [data-squares-prev] { grid-area: prev; justify-self: start; }\n` +
        `${row} [data-squares-next] { grid-area: next; justify-self: end; }\n` +
        `${row} [data-squares-count] { grid-area: count; text-align: center; }\n`);

  // Fewest squares per line first, so the widest that fits wins.
  const perLine = [
    ...new Set(
      Array.from({ length: count }, (_, i) => Math.ceil(count / (i + 1))),
    ),
  ].reverse();
  const ladder =
    perLine
      .map((n) =>
        at(
          width(BIG, n),
          `${line} { grid-template-columns: repeat(${n}, var(--sq)); }\n`,
        ),
      )
      .join("") +
    at(
      width(SMALL, count) + beside,
      `${line} { --sq: ${SMALL}px; font-size: ${FONT[SMALL]}px; ` +
        `grid-template-columns: repeat(auto-fit, var(--sq)); }\n` +
        (room === undefined
          ? ""
          : `${row} [data-squares-nav] { grid-template-areas: "prev line next"; }\n` +
            `${row} [data-squares-count] { position: absolute; width: 1px; ` +
            `height: 1px; overflow: hidden; clip-path: inset(50%); ` +
            `white-space: nowrap; }\n`),
    ) +
    at(
      width(BIG, count) + beside,
      `${line} { --sq: ${BIG}px; font-size: ${FONT[BIG]}px; }\n`,
    );

  if (!scroll) return base + ladder;
  const fine = "(hover: hover) and (pointer: fine)";
  return (
    base +
    `@media ${fine} {\n${ladder}}\n` +
    `@media not all and ${fine} {\n` +
    `${line} { position: relative; box-sizing: border-box; ` +
    `grid-template-columns: none; grid-auto-flow: column; ` +
    `grid-auto-columns: var(--sq); justify-content: start; ` +
    `width: fit-content; max-width: 100%; margin: 0 auto; ` +
    `padding: ${PAD}px; overflow-x: auto; scrollbar-width: none; ` +
    `--fade-l: 0px; --fade-r: 0px; mask-image: linear-gradient(to right, ` +
    `transparent, #000 var(--fade-l), #000 calc(100% - var(--fade-r)), ` +
    `transparent); }\n` +
    `${line}[data-scrolled] { --fade-l: ${FADE}px; }\n` +
    `@container ${name} (width < ${width(BIG, count) + 2 * PAD}px) {\n` +
    `${line}:not([data-end]) { --fade-r: ${FADE}px; }\n}\n` +
    `}\n`
  );
}
