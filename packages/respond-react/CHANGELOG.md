# Changelog

All notable changes to the `cardano-tessera-respond-react` package are
documented here. It wraps `cardano-tessera-respond`, whose changelog names the
element's own changes; a prop type change there reaches this one as a line
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while `< 1.0.0`, breaking changes bump the **minor** version.

## [Unreleased]

### Added

- Every type the element exports is exported here too, the new ones included:
  `Credential`, `Role`, `SurveyDefinition`, `SurveyRef`, `ContentAnchor`,
  `Metadatum`, `SurveyResponse`, `ValidationProblem`, `RespondMessages` and
  `DeepPartial`. So are `TesseraRespondElementProps`, and `RESPOND_EVENTS` as a
  type. `TesseraRespondProps` stays this package's own.

## [0.7.0] - 2026-10-16

### Removed

- **Breaking:** the `messages` prop loses `respond.leftNone`, following the
  element, whose submit bar no longer says "All questions answered or
  skipped."

## [0.6.0] - 2026-10-16

### Added

- `onChange`'s detail gains `unseen`, `required`, `unfinished` and
  `unanswered`, following the element: the indexes of the questions left in
  each case.
- The `messages` prop takes the element's new keys for its progress squares,
  the line naming the questions left, and the confirmation before skipping
  them.

### Removed

- **Breaking:** the `messages` prop loses `respond.decidedCount`, following
  the element, whose submit bar no longer shows "5 of 22 decided".

## [0.5.0] - 2026-10-14

### Added

- `noneLabels` prop, following the element: the survey's own words for a
  multi-select's None box. The `NoneLabels` type is exported.
- `keyboardShortcuts` prop, following the element: `false` turns its letter,
  digit and Enter keys off.
- The `ConditionOption` type is exported, following the element: a
  condition's `anyOf` and `noneOf` may hold `"none"`.
- The `translations` prop takes a question's `noneLabel`, and the `messages`
  prop `respond.enterHint` and `respond.shiftEnterHint`, following the
  element.

## [0.4.0] - 2026-10-13

### Added

- `showRole` prop, following the element: `false` hides the "Responding as"
  row.
- `hiddenSchemas` prop, following the element: schema URIs a custom question
  doesn't show.

### Changed

- **Breaking:** the peer dependency on `cardano-tessera-respond` is the exact
  version of the same number (was the range `^0.3.0`). The component's prop
  types come from the installed widget while the props it assigns are fixed
  at release, so a wrapper beside a newer widget accepted a prop it never
  set. Install and update the two packages together.
- **Breaking:** the `messages` prop loses `respond.respondLabel`, following
  the element, whose header no longer shows the "Respond" label.

## [0.3.0] - 2026-10-01

### Added

- `maxTextBytes` prop, following the element: a cap on a custom answer's
  UTF-8 length.
- `stash` prop, following the element: where unsent answers are kept, one
  form per survey. The `DraftStash` type is exported.
- `translations` prop, following the element: the survey's text in other
  languages, shown by `locale`. The `SurveyTranslations`,
  `SurveyTranslation` and `QuestionTranslation` types are exported.
- `conditions` prop, following the element: questions shown only after some
  earlier answers. The `DisplayConditions` and `DisplayCondition` types are
  exported.

### Changed

- A custom answer longer than 64 bytes is written as `chunked_text`, following
  the element; it used to be an invalid metadatum.
- Switching role or wallet keeps the answers entered, following the element.
- Progress dots show each question's state, following the element.

## [0.2.0] - 2026-09-15

### Changed

- **Breaking:** a points question's `budget` in the `definition` prop is a
  `bigint` (was `number`), following `cip-179` through the widget. The
  `onResponse` payload is unchanged: it was already a `Metadatum`, whose
  integers are `bigint`.
- **Breaking:** the `messages` prop follows the element's catalog:
  `respond.noneLead` and `respond.noneNote` are removed, and
  `respond.noneOfThese` and `respond.numericUnset` are added.

## [0.1.0] - 2026-08-01

### Added

- `<TesseraRespond>`: registers the element, re-syncs every widget prop as a
  DOM property each render, and delivers the `tessera:*` events as
  `onResponse`, `onChange` and `onInvalid`; identical on React 18 and 19,
  SSR-safe.
