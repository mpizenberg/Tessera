# Changelog

All notable changes to the `cardano-tessera-respond` package are documented
here. The element's `definition` prop is a `cip-179` `SurveyDefinition`, so a
type change in that package reaches this one as a line here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while `< 1.0.0`, breaking changes bump the **minor** version.

## [0.5.0] - 2026-10-14

### Added

- `noneLabels` prop: the survey's own words for a multi-select's "None of
  these" box, keyed by question index, in the definition's language. A label
  is 1 to 64 bytes; one on a question without that box, or out of bounds, is
  dropped with a console warning. A translation words the box with a
  question's `noneLabel`. The `NoneLabels` type is exported.
- `"none"` in a condition's `anyOf` or `noneOf`: it matches a multi-select
  answered with its None box, which a skip does not. It is valid only on a
  multi-select with `minSelections: 0`. The `ConditionOption` type is
  exported.
- Keyboard shortcuts while the focus is in a question: a letter picks,
  toggles or ranks the option it badges, a digit rates, Enter moves on and
  Shift+Enter goes back (with Ctrl or Cmd held in a text area). Enter never
  submits. The badges, and the stepper's key hints beside Previous and Next,
  show with a mouse, not on a touch screen. The `messages` prop gains
  `respond.enterHint` and `respond.shiftEnterHint` for the hints.
- `keyboardShortcuts` prop (attribute `keyboard-shortcuts`): `false` turns the
  shortcuts off, for a host with keys of its own. Default `true`.
- Focus: choice rows and rating levels are native radios and checkboxes, so a
  single choice, or a rating's item, is one Tab stop whose arrow keys move the
  pick; Delete or Backspace clears a rating. Each group is named by its prompt.
  After Previous, Next or Skip the focus goes to the new question's prompt.
  Every control, text inputs included, shows a focus ring in the accent
  colour, and the question holding the focus an accent border.

### Changed

- Skip moves on: to the next shown question, or after the last one to the
  submit button. Taking the skip back stays on the question.
- Enter no longer picks or toggles an option; it moves on. Space still picks.

### Fixed

- A multi-select's two columns overflowed a narrow screen. It now shows one
  column when two would get less than 260px each.

## [0.4.0] - 2026-10-13

### Added

- `showRole` prop (attribute `show-role`): `false` hides the "Responding as"
  row, for a host that settles the role itself through `initialRole` or a
  single-role `responder`. Default `true`.
- `hiddenSchemas` prop: schema URIs whose anchor a custom question leaves
  out, along with the hint that names it, for a schema the respondent needn't
  see, such as plain text.

### Changed

- **Breaking:** the header no longer shows the "Respond" label above the
  survey title, and the `messages` prop loses `respond.respondLabel` with it.

### Fixed

- The progress dots wrap within the submit bar; with many questions they ran
  past its right edge.

## [0.3.0] - 2026-10-01

### Added

- `maxTextBytes` prop (attribute `max-text-bytes`): a cap on a custom answer's
  UTF-8 length. The input shows a byte count, and a longer text leaves its
  question undecided; it is never cut. The `messages` prop gains
  `respond.customBytes` for the count.
- `stash` prop: where unsent answers are kept, as plain JSON, one form per
  survey under its `<txHash>:<index>` key. A durable one, such as
  `localStorage`, brings them back after a reload; a kept form that no longer
  fits the questions is ignored. Without one they stay in memory, as before.
  The `DraftStash` type is exported.
- `translations` prop: the survey's title, description, prompts, option
  labels and rating labels in other languages, as an overlay document beside
  the definition. `locale` picks the text field by field (`fr-CA`, then `fr`,
  then the definition's own); answers and payload are unchanged. An entry for
  the default language, or one that does not match the questions, is ignored
  with a console warning. The `SurveyTranslations`, `SurveyTranslation` and
  `QuestionTranslation` types are exported.
- `conditions` prop: show a question only when an earlier single- or
  multi-choice question has one of some options selected (`anyOf`), or none
  (`noneOf`). A hidden question records nothing and counts as decided; the
  list layout shows a one-line note in its place. If any condition is faulty,
  none applies, with a console warning and a notice. The `messages` prop gains
  `respond.hiddenNote`, `respond.conditionsIgnoredTitle` and
  `respond.conditionsIgnoredBody`. The `DisplayConditions` and
  `DisplayCondition` types are exported.

### Changed

- Switching role, or the host swapping the wallet behind a role, keeps the
  answers the user has entered. It used to start a fresh form for each role
  and credential, prefilled from that one's prior response; that still
  happens while the form is untouched.
- A custom answer longer than 64 bytes is written as `chunked_text`, an array
  of 64-byte chunks that never splits a character. It used to be written as
  one string, which is not a valid metadatum past 64 bytes. A prior response
  prefills from either form.
- The custom answer input is a multi-line text area.
- Each progress dot shows its own question's state: filled when answered,
  outlined when skipped or hidden, ringed for the question on screen in the
  stepper. The dots used to fill from the left by the decided count.

## [0.2.0] - 2026-09-15

### Changed

- **Breaking:** a points question's `budget` in the `definition` prop is a
  `bigint` (was `number`), following `cip-179`. A host that builds definitions
  in code writes `budget: 100n`; one that decodes them from chain or from
  `cardano-tessera-client` gets the `bigint` already. The `tessera:response`
  payload is unchanged: it was already a `Metadatum`, whose integers are
  `bigint`.
- **Breaking:** the `messages` prop loses `respond.noneLead` and
  `respond.noneNote` with the note they rendered, and gains
  `respond.noneOfThese` and `respond.numericUnset`. The
  `--tessera-label-strong` theme token is removed; no style read it.
- A multi-select that allows no selection starts unset. Its empty answer is
  recorded only when "None of these", the last choice in the options grid, is
  picked, and unchecking the last option returns it to unset. It used to start
  as an empty selection, which a submit recorded as a deliberate empty answer.
- A numeric answer starts unset instead of at its minimum, so an untouched
  question is never recorded. While unset, the value reads "—", the slider is
  muted and rests mid-track, and it announces "Not set".
- Switching the element to another survey and back restores the edits made on
  the first one, where it used to show a blank form.
- The points slider moves in power-of-ten strides (at most 1 000 positions),
  so a lovelace-sized budget still gets one; the ± buttons move by the same
  stride and the number field takes any amount. The numeric slider is shown
  for up to 100 000 steps at any bounds, and both sliders announce the value
  through `aria-valuetext`.

## [0.1.3] - 2026-08-17

### Changed

- The answering state machine lives in `cardano-tessera-respond-core` and the
  shared bodies in the workspace's `respond-ui`; the packed types are
  byte-identical to 0.1.2. README rewritten around the eligibility one-liners.

## [0.1.2] - 2026-08-01

### Fixed

- Republish of 0.1.1, whose manifest pointed the root and `./element` entries
  at `src/`, a directory the tarball never ships.

## [0.1.1] - 2026-08-01

### Fixed

- The `./artifact` subpath is exported, so
  `cardano-tessera-respond-react` resolves it.

## [0.1.0] - 2026-08-01

### Added

- `<tessera-respond>`: the self-contained answering element, typed, dist-only
  and dependency-free, with the `tessera:response`, `tessera:change` and
  `tessera:invalid` events and `--tessera-*` theming.
