# Changelog

All notable changes to the `cardano-tessera-respond-react` package are
documented here. It wraps `cardano-tessera-respond`, whose changelog names the
element's own changes; a prop type change there reaches this one as a line
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while `< 1.0.0`, breaking changes bump the **minor** version.

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
