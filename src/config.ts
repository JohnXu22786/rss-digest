/**
 * Plugin configuration: types and the Cordis/Schemastery `Config` export.
 *
 * Every field has a default so an empty patch config is a valid setup. The
 * `Config` export is what dsh validates against when the row is loaded.
 */

import Schema from '@deepseek-ai/schemastery'

import type { DigestLanguage, SummaryMode } from './types.js'

/** Initial subscription declared in configuration (optional; use tools/CLI at runtime). */
export interface FeedSourceInput {
  url: string
  title?: string
  enabled?: boolean
}

export interface FetchSectionConfig {
  /** Enable the periodic fetch scheduler. */
  enabled: boolean
  /** Fetch interval in minutes (minimum 5). */
  intervalMinutes: number
  /** Run one fetch cycle shortly after the plugin starts. */
  onStartup: boolean
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number
  /** Maximum accepted feed document size in bytes. */
  sizeLimitBytes: number
  /** Retries for transient network/HTTP failures. */
  retries: number
  /** Maximum items kept per source per fetch cycle. */
  maxItemsPerSource: number
  /** Truncation (chars) applied to stored item summary/content text. */
  storeContentChars: number
  /** Retention cap for the item store (oldest fetched are pruned). */
  maxStoredItems: number
}

export interface SummarySectionConfig {
  /** Whether an LLM call is attempted; false forces extractive output. */
  enabled: boolean
  /** `batch` summarizes all items in one call; `single` summarizes per item. */
  mode: SummaryMode
  /** Output language of the summary body. */
  language: DigestLanguage
  /** Hard character cap on the summary body. */
  maxLength: number
  /** Token budget hint for the model call. */
  maxTokens: number
  /** dsh provider route; empty selects the first registered provider. */
  provider: string
  /** Model id for the route; empty picks the provider's first listed model. */
  model: string
}

export interface DedupeSectionConfig {
  /** Minimum token-set Jaccard similarity to count two headlines as duplicates. */
  threshold: number
  /** Let identical bodies collapse items whose titles are empty. */
  compareContent: boolean
}

export interface DigestSectionConfig {
  /** Enable the daily digest scheduler. */
  enabled: boolean
  /** Wall-clock fire time in HH:MM. */
  time: string
  /** IANA timezone; empty means the host's local time. */
  timezone: string
  /** Maximum items per digest. */
  maxItems: number
  /** Where the generated Markdown is delivered. */
  deliverTo: 'agents' | 'file' | 'both'
  /** Whether the item list embeds permalinks. */
  includeItemLinks: boolean
}

export interface Config {
  /** Store file path; empty resolves to $DSH_HOME/data/rss-digest or ~/.dsh-rss-digest. */
  dataPath: string
  /** Initial subscriptions merged into the store at startup. */
  sources: FeedSourceInput[]
  fetch: FetchSectionConfig
  summary: SummarySectionConfig
  dedupe: DedupeSectionConfig
  digest: DigestSectionConfig
}

const FeedSourceSchema = Schema.object({
  url: Schema.string().required().description('Feed URL (http/https).'),
  title: Schema.string().description('Optional human-readable label.'),
  enabled: Schema.boolean().default(true),
})

const FetchSectionSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  intervalMinutes: Schema.number().min(5).default(60),
  onStartup: Schema.boolean().default(true),
  requestTimeoutMs: Schema.number().min(1000).default(15_000),
  sizeLimitBytes: Schema.number().min(1024).default(1024 * 1024),
  retries: Schema.natural().min(0).default(2),
  maxItemsPerSource: Schema.natural().min(1).default(50),
  storeContentChars: Schema.natural().min(100).default(4000),
  maxStoredItems: Schema.natural().min(10).default(1000),
}).description('Periodic fetch policy.')

const SummarySectionSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  mode: Schema.union([Schema.const('batch'), Schema.const('single')]).default('batch'),
  language: Schema.union([Schema.const('zh'), Schema.const('en')]).default('zh'),
  maxLength: Schema.natural().min(50).max(3000).default(800),
  maxTokens: Schema.natural().min(64).max(4096).default(1024),
  provider: Schema.string().default('').description('dsh provider route; empty = first registered provider.'),
  model: Schema.string().default('').description('Model id; empty = first listed model of the provider.'),
}).description('LLM summarization policy.')

const DedupeSectionSchema = Schema.object({
  threshold: Schema.percent().default(0.9),
  compareContent: Schema.boolean().default(false),
}).description('Duplicate detection policy.')

const DigestSectionSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  time: Schema.string().pattern(/^([01]?\d|2[0-3]):[0-5]\d$/).default('08:00'),
  timezone: Schema.string().default('').description('IANA timezone (e.g. Asia/Shanghai); empty = host local time.'),
  maxItems: Schema.natural().min(1).max(200).default(20),
  deliverTo: Schema.union([
    Schema.const('agents'),
    Schema.const('file'),
    Schema.const('both'),
  ]).default('both'),
  includeItemLinks: Schema.boolean().default(true),
}).description('Daily digest policy.')

export const Config: Schema<Config> = Schema.object({
  dataPath: Schema.string().default('').description(
    'Where the JSON store lives. Empty resolves to $DSH_RSS_DIGEST_DATA, '
    + 'then $DSH_HOME/data/rss-digest/store.json, then ./.dsh-rss-digest/store.json.',
  ),
  sources: Schema.array(FeedSourceSchema).default([]),
  fetch: FetchSectionSchema,
  summary: SummarySectionSchema,
  dedupe: DedupeSectionSchema,
  digest: DigestSectionSchema,
}).description('RSS aggregation, summarization, and daily digest plugin.')

export default Config