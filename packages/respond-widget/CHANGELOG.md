# Changelog

All notable changes to the `cardano-tessera-respond` package are documented
here. The element's `definition` prop is a `cip-179` `SurveyDefinition`, so a
type change in that package reaches this one as a line here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while `< 1.0.0`, breaking changes bump the **minor** version.

## [Unreleased]

### Changed

- **Breaking:** a points question's `budget` in the `definition` prop is a
  `bigint` (was `number`), following `cip-179`. A host that builds definitions
  in code writes `budget: 100n`; one that decodes them from chain or from
  `cardano-tessera-client` gets the `bigint` already. The `tessera:response`
  payload is unchanged: it was already a `Metadatum`, whose integers are
  `bigint`.
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
