# Contributing

Thanks for considering a contribution to `dsh-rss-digest`.

## Setup

```bash
npm install
npm run build     # tsc -> lib/
npm test          # build + node --test
```

Requires Node >= 22.18.

## Project layout

The dsh-facing layer lives in `src/index.ts` (bundle entry), `src/config.ts`
(schema), `src/tools.ts` (model tools), `src/scheduler.ts` and
`src/delivery.ts`; the dependency-free core is everything from `src/service.ts`
downward (`parser`, `fetcher`, `dedupe`, `store`, `summarizer`, `digest`).
Keep the core free of `@deepseek-ai/*` imports - that is the whole point.

## Guidelines

- Add or extend a test under `test/` for any behavior change; the suite runs
  with `node --test` against the compiled `lib/`.
- Update `README.md` (English) and `README.zh.md` (Chinese) together when the
  user-visible surface (tools, config keys, CLI) changes.
- Add a CHANGELOG entry under `[Unreleased]`.
- Match the existing style: single quotes, no semicolons, ~2-space typing.

## Release checklist

1. Bump the version in `package.json` and the CHANGELOG.
2. `npm run check`-style flow: build + typecheck + tests pass.
3. `npm pack` and inspect the tarball contents.
4. `npm publish` (the `prepublishOnly` hook builds first).
