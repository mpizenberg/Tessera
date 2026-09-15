# Changelog

All notable changes to the `cardano-tessera-respond-react` package are
documented here. It wraps `cardano-tessera-respond`, whose changelog names the
element's own changes; a prop type change there reaches this one as a line
here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while `< 1.0.0`, breaking changes bump the **minor** version.

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
