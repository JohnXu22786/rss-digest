/**
 * Shared data types of the rss-digest core.
 *
 * This module is intentionally free of any dsh / Cordis dependency so that
 * the same types are used by the plugin entry, the CLI, and the tests.
 */

/** Language used for summarization and generated digest texts. */
export type DigestLanguage = 'zh' | 'en'

/** How multiple news items are turned into a digest summary. */
export type SummaryMode = 'batch' | 'single'

/** A subscribed RSS/Atom feed. */
export interface FeedSource {
  /** Stable local identity, assigned on creation (short id string). */
  id: string
  /** The absolute URL of the feed document. */
  url: string
  /** Optional human-readable label; fallback: the feed's own title. */
  title: string
  /** Whether the scheduler actively polls this feed. */
  enabled: boolean
  /** ISO-8601 timestamp of when the source was added. */
  addedAt: string
}

/** A single normalized story extracted from a feed. */
export interface FeedItem {
  /** Stable identity within this store (guid, entry id, link, or content hash). */
  id: string
  /** Id of the {@link FeedSource} this item came from. */
  sourceId: string
  /** Item headline. */
  title: string
  /** Canonical (or first) permalink. */
  link: string
  /** Short description / summary as published by the feed. */
  summary: string
  /** Rendered (HTML) body as published by the feed, if any. */
  content: string
  /** ISO-8601 publish/update time, when the feed provides one. */
  publishedAt: string
  /** ISO-8601 timestamp of when this item was fetched into the store. */
  fetchedAt: string
  /** Digest token used for exact duplicate detection. */
  hash: string
  /** ISO date (YYYY-MM-DD, in digest timezone) a digest last included this item. */
  digestedDay: string
}

/** Result of fetching and persisting one source. */
export interface SourceFetchResult {
  sourceId: string
  sourceUrl: string
  fetched: number
  added: number
  duplicated: number
  error?: string
}

/** Result of a fetch-all cycle. */
export interface FetchCycleResult {
  startedAt: string
  finishedAt: string
  sources: SourceFetchResult[]
  totalFetched: number
  totalAdded: number
  errors: number
}

/** A digest document together with provenance about the items it covered. */
export interface DigestDocument {
  title: string
  date: string
  language: DigestLanguage
  markdown: string
  itemCount: number
  itemIds: string[]
  summaryMode: SummaryMode
  summarySource: 'llm' | 'extractive'
}

/** A fresh item as produced by the parser before normalization. */
export interface ParsedFeedItem {
  title: string
  link: string
  summary: string
  content: string
  publishedAt: string
  id: string
}

/** Parsed feed metadata plus its items. */
export interface ParsedFeed {
  title: string
  items: ParsedFeedItem[]
}

/** Normalized result of one HTTP fetch of a feed document. */
export interface FetchedDocument {
  url: string
  status: number
  body: string
}

/** Structured failure returned by the fetcher instead of a document. */
export interface FetchFailure {
  url: string
  status: number
  error: string
  /** Explicitly false when retrying the same request cannot succeed. */
  retryable?: boolean
}

/** Human-friendly logger surface used by the service (dsh/CLI adapt).
 * Kept minimal so core code never depends on a logging framework.
 */
export interface LogSink {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

/** No-op logger used as a safe default. */
export const noopLog: LogSink = {
  info() {},
  warn() {},
  error() {},
}