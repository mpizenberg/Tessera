# @tessera/respond-ui

The shared SolidJS answering UI for CIP-179 surveys: one implementation of the
per-question body components (single choice, multi select, ranking, numeric
range, points allocation, rating, custom), consumed by **both** the Tessera app
and the `<tessera-respond>` widget so their answering behavior cannot drift.

The behavior-free logic (drafts, validation, eligibility) lives in
`@tessera/respond-core`; this package is the behavior-bearing view layer on top
of it. The two host-specific deltas are injected via Solid context:

- **i18n** — `I18nContext` carries an `I18n` accessor. Both hosts provide
  respond-core's `createI18n`, so wording comes from a single catalog: the
  widget scopes it to its `locale`/`messages` props, the app drives it from its
  reactive global locale.
- **styling** — `ClassesContext` maps each `BodyClassName` to the string
  rendered into `class=`. It defaults to the identity map (the widget's
  shadow-scoped stylesheet targets the literal names); the app provides its
  CSS-module lookup, keeping its own styles byte-for-byte.

No wallet, chain, storage, or `window` access — same host/guest discipline as
respond-core.
