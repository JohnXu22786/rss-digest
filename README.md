# dsh-rss-digest

RSS/Atom aggregation, smart summarization, and daily Markdown briefings — a
first-party-style **dsh bundle** (DeepSeek Harness, "everything is a plugin").

The plugin manages feed subscriptions with local persistence, polls feeds on a
schedule, deduplicates stories (exact + near-duplicate), summarizes them with
the harness's LLM (with a deterministic extractive fallback when the model is
unavailable), and delivers a daily Markdown digest into live conversations
and/or files. It also ships a standalone CLI that shares the same core.

- **dsh integration**: bundle spec (`dsh.bundle` + `cordis.patch.yml`),
  model-facing tools via `ctx.tools`, scheduling via the harness timer seam,
  delivery via agent follow-up messages. See [Architecture](#architecture).
- **Zero-friction core**: the fetch/parse/dedupe/store/digest core has no
  dependencies at all — only the dsh integration layer imports dsh packages.

---

## Features

- **Subscriptions** — add / remove / list / enable / disable RSS 2.0, Atom,
  and RSS 1.0 (RDF) feeds; persisted in a single versioned JSON document with
  atomic writes and corruption quarantine.
- **Scheduled fetching** — configurable poll interval, startup cycle,
  per-request timeout, size cap, retries, and an item retention cap.
- **Deduplication** — exact-match hashing plus token-Jaccard near-duplicate
  detection (CJK-aware bigrams), configurable threshold.
- **LLM summaries** — one batch call per digest or per-item summaries,
  Chinese or English, bounded output length; automatic degradation to
  extractive summaries on any model failure.
- **Daily digest** — Markdown briefing at a wall-clock time (optional IANA
  timezone) delivered to live sessions (`Agent.followup`) and/or written to
  `digests/<day>.md` files.
- **Two entry points** — the same `RssService` powers both the dsh plugin
  (`ctx.tools` + scheduler) and the standalone CLI.

## Installation (dsh)

A bundle is an npm package that ships a configuration layer. Install this
package into a dsh profile; the loader picks up the `dsh.bundle` declaration
and applies `cordis.patch.yml` automatically:

```bash
# from inside a dsh profile (or with --profile <name> from anywhere)
dsh plugin --profile demo add ./path/to/dsh-rss-digest
# or from a registry:  dsh plugin --profile demo add dsh-rss-digest
```

The profile manifest now lists `dsh-rss-digest` in `dsh.profile.bundles`, and
the bundle's patch inserts the plugin row:

```yaml
- insert:
    - id: rss-digest
      name: 'dsh-rss-digest'
```

Optional: tune the plugin from your profile's own
`$DSH_HOME/profiles/demo/cordis.patch.yml` (a bare row by id replaces the
row's config; every omitted field keeps its default). A fully annotated
example lives in [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml):

```yaml
- id: rss-digest
  config:
    fetch:
      intervalMinutes: 60
    summary:
      language: zh
      mode: batch
    digest:
      time: '08:30'
      timezone: Asia/Shanghai
      deliverTo: both
```

The plugin starts with sensible defaults even with no configuration at all;
use `rss_add` in a conversation or `dsh-rss-digest add` in a shell to register
feeds at runtime.

> **Peer dependencies**: the plugin declares the dsh packages it links
> against (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
> `@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis-plugin-timer`) as peers. A dsh
> profile already provides them; if your package manager complains about
> unmet peers, `pnpm --dir $DSH_HOME/profiles/demo add` the same four packages
> once (the profile linker heals the rest).

## Configuration reference

All fields are optional; `apply(ctx, config)` always receives fully defaulted
values.

| Field | Default | Description |
| --- | --- | --- |
| `dataPath` | `''` | Store file path. `''` resolves to `$DSH_RSS_DIGEST_DATA`, else `$DSH_HOME/data/rss-digest/store.json`, else `./.dsh-rss-digest/store.json`. |
| `sources[]` | `[]` | Initial subscriptions merged at startup: `{ url, title?, enabled? }`. Duplicate URLs are ignored. |
| `fetch.enabled` | `true` | Whether the periodic poller runs. |
| `fetch.intervalMinutes` | `60` | Poll interval (min 5). |
| `fetch.onStartup` | `true` | Run one cycle ~10 s after startup. |
| `fetch.requestTimeoutMs` | `15000` | Per-request timeout. |
| `fetch.sizeLimitBytes` | `1048576` | Max accepted document size. |
| `fetch.retries` | `2` | Retries for transient failures (network / 5xx / 429 / 408). |
| `fetch.maxItemsPerSource` | `50` | Parsed items kept per source per cycle (newest kept). |
| `fetch.storeContentChars` | `4000` | Truncation for stored summary/content text. |
| `fetch.maxStoredItems` | `1000` | Retention cap (oldest fetched pruned on save). |
| `dedupe.threshold` | `0.9` | Min token-set Jaccard similarity for near-duplicates. |
| `dedupe.compareContent` | `false` | Let identical bodies collapse empty-title items. |
| `summary.enabled` | `true` | `false` forces extractive summaries. |
| `summary.mode` | `batch` | `batch` = one model call per digest; `single` = per item. |
| `summary.language` | `zh` | Output language of the summary body: `zh` \| `en`. |
| `summary.maxLength` | `800` | Hard character cap on the summary body. |
| `summary.maxTokens` | `1024` | Token budget hint for the model call. |
| `summary.provider` | `''` | dsh provider route; `''` = first registered provider. |
| `summary.model` | `''` | Model id; `''` = first listed model of the provider. |
| `digest.enabled` | `true` | Whether the daily digest scheduler runs. |
| `digest.time` | `'08:00'` | Wall-clock fire time (`HH:MM`). |
| `digest.timezone` | `''` | IANA timezone; `''` = host local time. |
| `digest.maxItems` | `20` | Max items per digest. |
| `digest.deliverTo` | `both` | `agents` \| `file` \| `both` — deliver to live sessions, to `digests/<day>.md`, or both. |
| `digest.includeItemLinks` | `true` | Whether the item list embeds permalinks (http/https only). |

## Tools (model-facing)

Registered through `ctx.tools`; the model can call them in any conversation:

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `rss_list` | — | Lists subscriptions (id, url, title, enabled). |
| `rss_add` | `url` (req), `title?` | Subscribes to a feed; returns the new source. |
| `rss_remove` | `id` (req) | Unsubscribes and drops that source's items. |
| `rss_fetch` | `id?` | Polls one source (or all) now; dedupe is automatic. |
| `rss_digest` | `language?`, `mode?`, `maxItems?` | Builds the Markdown digest over undigested items and returns it. |

Example conversation flow:

```
user: 帮我把 Hacker News 加进来，然后生成今天的简报
model: [rss_add: https://hnrss.org/frontpage]
       [rss_fetch]
       [rss_digest: language=zh]
```

## Scheduling model

dsh's `ctx.jobs` registry tracks long-running task *executions* (bash /
subagent jobs) — it is not a cron API. The harness's scheduling seam is the
timer service (`ctx.timeout` / `ctx.interval`, injected via `'timer'`), which
is what this plugin uses:

- fetch cycles: `ctx.interval` (configurable), plus one startup cycle;
- daily digest: a self-re-arming `ctx.timeout` — after every run the next
  `HH:MM` occurrence is recomputed (`Intl`-based, timezone- and DST-aware), so
  the digest stays anchored to the configured wall-clock time; overlapping
  runs are guarded with an in-flight lock.

## Delivery

The harness has no broadcast API; a plugin reaches live sessions by queueing
a user-role message on each running `Agent` (`Agent.followup`, the same
mechanism the shipped job notices use). `digest.deliverTo = agents` does that;
`file` writes `digests/<day>.md` next to the store; `both` is the default.
Headless profiles without the agent service simply get the file/log path, and
the plugin never depends on the agent service at startup.

## CLI

The same core, no harness required:

```bash
dsh-rss-digest add https://hnrss.org/frontpage
dsh-rss-digest fetch
dsh-rss-digest digest --lang en --out digest.md
dsh-rss-digest list --items
dsh-rss-digest status
```

Run `dsh-rss-digest help` for the full command reference. The CLI talks to an
OpenAI-compatible `/chat/completions` endpoint for summaries (DeepSeek by
default: `https://api.deepseek.com`, key from `DEEPSEEK_API_KEY`, model
`deepseek-chat`); without credentials it degrades to extractive summaries,
exactly like the plugin does when the harness LLM fails.

## Data

One JSON document (`schema: 1`), written atomically; corrupt files are moved
aside (`.corrupt-<timestamp>`) rather than deleted. Full subscription URLs
(including query strings, which signed feeds often need) are persisted as
given; log lines show the URL without its query string. Environment
overrides: `DSH_RSS_DIGEST_DATA` (store path), `DEEPSEEK_API_KEY` (CLI).

## Architecture

```
src/
  index.ts        dsh bundle entry: name / inject / Config / apply
  config.ts       Config interface + Schemastery schema (defaults)
  tools.ts        rss_list / rss_add / rss_remove / rss_fetch / rss_digest
  scheduler.ts    timer-seam scheduling (fetch cycles + self-re-arming digest)
  delivery.ts     Agent.followup delivery + digests/<day>.md files
  dsh-llm.ts      ctx.llm adapter (streaming, provider/model resolution)
  service.ts      RssService — orchestrates everything (dsh-free)
  parser.ts       dependency-free RSS 2.0 / Atom / RSS 1.0 parser
  fetcher.ts      fetch with timeout, size cap, retries, charset detection
  dedupe.ts       normalization, exact hashing, token-Jaccard similarity
  store.ts        versioned JSON persistence (atomic, quarantining)
  summarizer.ts   LLM + extractive summarization (degrade contract)
  digest.ts       Markdown briefing renderer (safe link handling)
  llm-client.ts   OpenAI-compatible REST client (CLI)
  cli.ts          standalone CLI entry (bin: dsh-rss-digest)
```

The core (`service.ts` and below) has **zero** runtime dependencies; only the
dsh layer imports `@deepseek-ai/*` packages.

## Development

```bash
npm install
npm run build     # tsc -> lib/
npm test          # build + node --test (79 tests: parser, dedupe, store,
                  # fetcher, time, summarizer, digest, service, cli, wiring)
node lib/cli.js status
```

Requires Node >= 22.18.

## License

MIT — see [LICENSE](LICENSE).
