/**
 * The rss-digest service: everything that touches sources, fetching,
 * deduplication, and digest generation, independent of the host runtime.
 *
 * Both the dsh plugin and the CLI instantiate this service with their own
 * store, logger, fetcher, and LLM client. No dsh dependency.
 */

import { randomUUID } from 'node:crypto'

import { itemHash, tokenSimilarity } from './dedupe.js'
import { renderDigest } from './digest.js'
import { createFetcher } from './fetcher.js'
import { FeedParseError, parseFeedDocument, stripHtml, truncateCodePoints } from './parser.js'
import { Store, undigestedItems } from './store.js'
import { summarize, type LlmClient, type SummarizableItem, type SummarizeResult } from './summarizer.js'
import { zonedDayKey } from './time.js'
import type {
  DigestDocument,
  DigestLanguage,
  FeedItem,
  FeedSource,
  FetchCycleResult,
  FetchedDocument,
  FetchFailure,
  LogSink,
  SourceFetchResult,
  SummaryMode,
} from './types.js'
import { noopLog } from './types.js'

/** Error used for user-facing validation failures (tools/CLI turn it into a message). */
export class RssServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RssServiceError'
  }
}

export interface DigestPolicy {
  language: DigestLanguage
  mode: SummaryMode
  /** Whether a model call is attempted; false forces extractive output. */
  summaryEnabled: boolean
  /** Hard character cap on the summary body. */
  maxLength: number
  /** Token budget hint for the model call. */
  maxTokens?: number
  /** Maximum number of items included per digest. */
  maxItems: number
  /** IANA timezone used to determine the digest "day" boundary. */
  timezone: string
  /** Whether the item list embeds permalinks. */
  includeItemLinks: boolean
}

export interface RssServiceOptions {
  store: Store
  log?: LogSink
  /** Feed document fetcher; defaults to a production `createFetcher()`. */
  fetcher?: (url: string, signal?: AbortSignal) => Promise<FetchedDocument | FetchFailure>
  /** Exact/fuzzy duplicate policy. */
  dedupe?: { threshold: number; compareContent: boolean }
  /** Maximum parsed items kept per source per cycle. */
  maxItemsPerSource?: number
  /** Truncation (chars) for stored summary/content text. */
  storeContentChars?: number
  /** Model client used for summaries when `digestPolicy.summaryEnabled`. */
  llmClient?: LlmClient
  digestPolicy?: Partial<DigestPolicy>
  /** Injectable clock for deterministic tests. */
  now?: () => Date
}

const DEFAULT_POLICY: DigestPolicy = {
  language: 'zh',
  mode: 'batch',
  summaryEnabled: true,
  maxLength: 800,
  maxTokens: 1024,
  maxItems: 20,
  timezone: '',
  includeItemLinks: true,
}

export class RssService {
  readonly store: Store
  readonly policy: DigestPolicy
  private readonly log: LogSink
  private readonly fetch: (url: string, signal?: AbortSignal) => Promise<FetchedDocument | FetchFailure>
  private readonly dedupe: { threshold: number; compareContent: boolean }
  private readonly maxItemsPerSource: number
  private readonly storeContentChars: number
  private readonly llmClient: LlmClient | undefined
  private readonly now: () => Date

  constructor(options: RssServiceOptions) {
    this.store = options.store
    this.log = options.log ?? noopLog
    this.fetch = options.fetcher ?? createFetcher()
    this.dedupe = options.dedupe ?? { threshold: 0.9, compareContent: false }
    this.maxItemsPerSource = options.maxItemsPerSource ?? 50
    this.storeContentChars = options.storeContentChars ?? 4000
    this.llmClient = options.llmClient
    this.policy = { ...DEFAULT_POLICY, ...options.digestPolicy }
    this.now = options.now ?? (() => new Date())
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  // ---------- sources ----------

  listSources(): FeedSource[] {
    return this.store.sources.map((source) => ({ ...source }))
  }

  /** Normalize and validate a subscription URL. */
  static normalizeUrl(url: string): string {
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new RssServiceError(`unsupported feed URL ${JSON.stringify(trimmed)} (only http(s) is allowed)`)
    }
    let parsed
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new RssServiceError(`malformed feed URL ${JSON.stringify(trimmed)}`)
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new RssServiceError('feed URLs with embedded credentials are not supported')
    }
    return parsed.toString()
  }

  /** Register a new subscription; duplicates by normalized URL are refused. */
  async addSource(input: { url: string; title?: string }): Promise<FeedSource> {
    const url = RssService.normalizeUrl(input.url)
    if (this.store.sources.some((source) => source.url === url)) {
      throw new RssServiceError(`already subscribed to ${url}`)
    }
    const source: FeedSource = {
      id: `src-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      url,
      title: (input.title ?? '').trim(),
      enabled: true,
      addedAt: this.nowIso(),
    }
    this.store.addSource(source)
    await this.store.save()
    this.log.info(`added source ${source.id} → ${redactUrl(url)}`)
    return { ...source }
  }

  /** Remove a source and every stored item that belongs to it. */
  async removeSource(id: string): Promise<boolean> {
    const removed = this.store.removeSource(id)
    if (removed) {
      await this.store.save()
      this.log.info(`removed source ${id}`)
    }
    return removed
  }

  /** Enable/disable a source; returns false when the id is unknown. */
  async setSourceEnabled(id: string, enabled: boolean): Promise<boolean> {
    const source = this.store.sources.find((candidate) => candidate.id === id)
    if (source === undefined) return false
    source.enabled = enabled
    await this.store.save()
    return true
  }

  // ---------- fetching ----------

  /** Fetch and ingest one source; persists immediately. */
  async fetchOne(sourceId: string, signal?: AbortSignal): Promise<SourceFetchResult> {
    const source = this.store.sources.find((candidate) => candidate.id === sourceId)
    if (source === undefined) {
      return {
        sourceId,
        sourceUrl: '',
        fetched: 0,
        added: 0,
        duplicated: 0,
        error: `unknown source id ${sourceId}`,
      }
    }
    const result = await this.captureSource(source, signal)
    this.store.meta.lastFetchAt = this.nowIso()
    await this.store.save()
    return result
  }

  async fetchOneByUrl(sourceUrl: string, signal?: AbortSignal): Promise<SourceFetchResult> {
    const source = this.store.sources.find((candidate) => candidate.url === sourceUrl)
    if (source === undefined) {
      return {
        sourceId: '',
        sourceUrl,
        fetched: 0,
        added: 0,
        duplicated: 0,
        error: `not subscribed: ${sourceUrl}`,
      }
    }
    return this.fetchOne(source.id, signal)
  }

  /** Fetch every enabled source sequentially; persists once at the end. */
  async fetchCycle(signal?: AbortSignal): Promise<FetchCycleResult> {
    const startedAt = this.nowIso()
    const sources = this.store.sources.filter((source) => source.enabled)
    const results: SourceFetchResult[] = []
    let totalFetched = 0
    let totalAdded = 0
    let errors = 0
    for (const source of sources) {
      if (signal !== undefined && signal.aborted) break
      const result = await this.captureSource(source, signal)
      results.push(result)
      totalFetched += result.fetched
      totalAdded += result.added
      if (result.error !== undefined) errors += 1
    }
    this.store.meta.lastFetchAt = this.nowIso()
    await this.store.save()
    return {
      startedAt,
      finishedAt: this.nowIso(),
      sources: results,
      totalFetched,
      totalAdded,
      errors,
    }
  }

  /** Fetch, parse, dedupe, and append one source without persisting. */
  private async captureSource(
    source: FeedSource,
    signal?: AbortSignal,
  ): Promise<SourceFetchResult> {
    const base = {
      sourceId: source.id,
      sourceUrl: source.url,
      fetched: 0,
      added: 0,
      duplicated: 0,
    }
    const doc = await this.fetch(source.url, signal)
    if ('error' in doc) {
      this.log.warn(`source ${source.id} (${redactUrl(source.url)}) fetch failed: ${doc.error}`)
      return { ...base, error: doc.error }
    }
    let parsed
    try {
      parsed = parseFeedDocument(doc.body)
    } catch (error) {
      const reason = error instanceof FeedParseError ? error.message : String(error)
      this.log.warn(`source ${source.id} (${redactUrl(source.url)}) parse failed: ${reason}`)
      return { ...base, error: `feed parse failed: ${reason}` }
    }
    // Keep the NEWEST items when a feed exceeds the per-source cap: some
    // feeds are append-only (oldest first), where the newest entries live at
    // the tail and would otherwise be truncated every cycle. Dated items
    // sort newest-first; undated ones trail behind.
    const dated = parsed.items.filter((item) => item.publishedAt !== '')
    const undated = parsed.items.filter((item) => item.publishedAt === '')
    dated.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    const rawItems = [...dated, ...undated].slice(0, this.maxItemsPerSource)
    const added = this.appendUnique(source, rawItems.map((item) => ({ ...item })))
    this.log.info(`source ${source.id} (${redactUrl(source.url)}) fetched ${rawItems.length} items, added ${added.added}, duplicated ${added.duplicated}`)
    return { ...base, fetched: rawItems.length, added: added.added, duplicated: added.duplicated }
  }

  /** Normalize, dedupe, and append parsed items against the store + current batch. */
  private appendUnique(source: FeedSource, rawItems: Array<{
    id: string
    title: string
    link: string
    summary: string
    content: string
    publishedAt: string
  }>): { added: number; duplicated: number } {
    const exactKnown = new Set<string>()
    const knownSameSource: Array<{ title: string; hash: string }> = []
    const collect = (item: FeedItem): void => {
      exactKnown.add(item.hash)
      if (item.sourceId === source.id) knownSameSource.push({ title: item.title, hash: item.hash })
    }
    for (const item of this.store.items) collect(item)

    let added = 0
    let duplicated = 0
    const batch: FeedItem[] = []
    const threshold = this.dedupe.threshold
    for (const raw of rawItems) {
      const title = truncateCodePoints(stripHtml(raw.title), 300)
      const summary = truncateCodePoints(stripHtml(raw.summary), this.storeContentChars)
      const content = truncateCodePoints(stripHtml(raw.content), this.storeContentChars)
      const hash = itemHash(raw.title, raw.summary + raw.content, this.dedupe.compareContent)
      if (exactKnown.has(hash)) {
        duplicated += 1
        continue
      }
      if (title !== '' && knownSameSource.some((known) => tokenSimilarity(title, known.title) >= threshold)) {
        duplicated += 1
        continue
      }
      const item: FeedItem = {
        id: `${source.id}:${hashItem(raw.id)}`,
        sourceId: source.id,
        title,
        link: raw.link,
        summary,
        content,
        publishedAt: raw.publishedAt,
        fetchedAt: this.nowIso(),
        hash,
        digestedDay: '',
      }
      batch.push(item)
      exactKnown.add(hash)
      knownSameSource.push({ title, hash })
      added += 1
    }
    added = this.store.addItems(batch)
    return { added, duplicated }
  }

  // ---------- digests ----------

  /** Build and persist a digest over not-yet-digested items; newest first. */
  async digest(overrides: Partial<Pick<DigestPolicy, 'language' | 'mode' | 'maxItems'>> = {}, signal?: AbortSignal): Promise<DigestDocument> {
    const policy: DigestPolicy = { ...this.policy, ...overrides }
    const now = this.now()
    const day = zonedDayKey(now, policy.timezone)
    const selected = undigestedItems(this.store.items, day, policy.maxItems)
    const items = selected.map((item) => ({ ...item }))
    this.log.info(`digest: ${items.length} items for ${day} (${policy.language}, ${policy.mode})`)

    const summarizable: SummarizableItem[] = items.map((item) => ({
      title: item.title,
      link: item.link,
      summary: item.summary,
      content: item.content,
      sourceTitle: this.sourceTitle(item.sourceId),
      publishedAt: item.publishedAt,
    }))
    const summaryResult: SummarizeResult = await summarize(
      {
        items: summarizable,
        language: policy.language,
        mode: policy.mode,
        maxLength: policy.maxLength,
        maxTokens: policy.maxTokens,
        signal,
      },
      this.llmClient,
      policy.summaryEnabled,
    )
    if (summaryResult.source === 'llm') {
      this.log.info('digest summary generated by LLM')
    } else if (this.policy.summaryEnabled && summaryResult.error !== undefined) {
      this.log.warn(`digest summary degraded to extractive (model error: ${summaryResult.error})`)
    }

    const sourceTitles = new Map<string, string>()
    for (const item of items) {
      sourceTitles.set(item.sourceId, this.sourceTitle(item.sourceId))
    }
    const markdown = renderDigest({
      date: day,
      language: policy.language,
      sourceTitles,
      items,
      summaryText: summaryResult.text,
      includeItemLinks: policy.includeItemLinks,
    })

    if (items.length > 0) {
      this.store.markDigested(items.map((item) => item.id), day)
    }
    this.store.meta.lastDigestAt = now.toISOString()
    this.store.meta.lastDigestDay = day
    await this.store.save()

    return {
      title: `${day} ${policy.language === 'zh' ? 'RSS 简报' : 'RSS Daily Digest'}`,
      date: day,
      language: policy.language,
      markdown,
      itemCount: items.length,
      itemIds: items.map((item) => item.id),
      summaryMode: policy.mode,
      summarySource: summaryResult.source,
    }
  }

  /** Latest freshly fetched items (introspection / CLI). */
  recentItems(limit = 20): FeedItem[] {
    return [...this.store.items]
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
      .slice(0, limit)
  }

  status(): {
    sources: number
    enabledSources: number
    items: number
    undigested: number
    lastFetchAt: string
    lastDigestAt: string
    lastDigestDay: string
  } {
    const day = zonedDayKey(this.now(), this.policy.timezone)
    return {
      sources: this.store.sources.length,
      enabledSources: this.store.sources.filter((source) => source.enabled).length,
      items: this.store.items.length,
      undigested: this.store.countUndigested(day),
      lastFetchAt: this.store.meta.lastFetchAt,
      lastDigestAt: this.store.meta.lastDigestAt,
      lastDigestDay: this.store.meta.lastDigestDay,
    }
  }

  private sourceTitle(sourceId: string): string {
    const source = this.store.sources.find((candidate) => candidate.id === sourceId)
    if (source === undefined) return sourceId
    return source.title !== '' ? source.title : source.url
  }
}

function hashItem(value: string): string {
  let hash = 5381
  const input = value === '' ? 'none' : value
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** Log-friendly URL: scheme + host + path, without query strings or fragments. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}