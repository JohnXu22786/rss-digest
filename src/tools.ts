/**
 * dsh tool registration: model-facing surfaces for the RSS service.
 *
 * Tools registered via `ctx.tools.register(defineTool(...))`:
 *  - rss_list    — current subscriptions
 *  - rss_add     — subscribe to a feed URL
 *  - rss_remove  — unsubscribe by source id
 *  - rss_fetch   — run a fetch cycle (all sources, or one)
 *  - rss_digest  — generate and return the Markdown digest
 *
 * Each tool's canonical value mirrors its output schema; `render` projects
 * the value into the model-facing content blocks.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

import { RssService, RssServiceError } from './service.js'
import type { DigestLanguage, LogSink, SummaryMode } from './types.js'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

const sourceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    enabled: { type: 'boolean' },
    addedAt: { type: 'string' },
  },
  additionalProperties: false,
} as const

// ---------------------------------------------------------------- rss_list

export function rssListTool(service: RssService) {
  return defineTool({
    name: 'rss_list',
    description: 'List all subscribed RSS/Atom feeds with their id, url, title, and enabled state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          sources: { type: 'array', items: sourceSchema },
        },
        additionalProperties: false,
      },
      render: (_args, value) => renderList(value.sources ?? [], value.count ?? 0),
    },
    async execute() {
      const sources = service.listSources()
      return { ok: true, count: sources.length, sources }
    },
  })
}

function renderList(
  sources: Array<{ id?: string; title?: string; url?: string; enabled?: boolean }>,
  count: number,
): ContentBlock[] {
  if (count === 0) {
    return text('No subscriptions yet. Use rss_add with a feed URL.')
  }
  const lines = sources.map((source) => {
    const label = source.title === undefined || source.title === '' ? '(untitled)' : source.title
    const state = source.enabled === true ? 'on' : 'off'
    return `- ${source.id ?? '?'} [${state}] ${label}\n  ${source.url ?? '?'}`
  })
  return text(`Subscriptions (${count}):\n\n${lines.join('\n')}`)
}

// --------------------------------------------------------------- rss_add

export function rssAddTool(service: RssService) {
  return defineTool({
    name: 'rss_add',
    description: 'Subscribe to an RSS/Atom feed URL. Returns the new source (id, url, title).',
    parameters: {
      url: { type: 'string', required: true, description: 'The feed URL to subscribe to (http/https).' },
      title: { type: 'string', description: 'Optional human-readable label for the source.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          source: sourceSchema,
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          return text(`Failed to add feed: ${value.error ?? 'unknown error'}`)
        }
        const s = value.source
        return text(`Subscribed. id=${s?.id}\nurl=${s?.url}${s?.title !== undefined && s?.title !== '' ? `\ntitle=${s?.title}` : ''}`)
      },
    },
    async execute(args) {
      try {
        const source = await service.addSource({ url: args.url, title: args.title })
        return { ok: true, source }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  })
}

// ------------------------------------------------------------- rss_remove

export function rssRemoveTool(service: RssService) {
  return defineTool({
    name: 'rss_remove',
    description: 'Unsubscribe from a feed by its source id (see rss_list).',
    parameters: {
      id: { type: 'string', required: true, description: 'The source id to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.ok !== true) return text(`Failed to remove ${value.id}: ${value.error ?? 'unknown error'}`)
        return text(`Removed source ${value.id}.`)
      },
    },
    async execute(args) {
      try {
        const removed = await service.removeSource(args.id)
        return removed
          ? { ok: true, id: args.id }
          : { ok: false, id: args.id, error: `unknown source id ${args.id}` }
      } catch (error) {
        return { ok: false, id: args.id, error: errorMessage(error) }
      }
    },
  })
}

// -------------------------------------------------------------- rss_fetch

const fetchResultSchema = {
  type: 'object',
  properties: {
    sourceId: { type: 'string' },
    sourceUrl: { type: 'string' },
    fetched: { type: 'integer' },
    added: { type: 'integer' },
    duplicated: { type: 'integer' },
    error: { type: 'string' },
  },
  additionalProperties: false,
} as const

export function rssFetchTool(service: RssService, log: LogSink) {
  return defineTool({
    name: 'rss_fetch',
    description: 'Fetch subscribed feeds now: poll every enabled source (or one source by id) and store new items. '
      + 'Deduplication happens automatically.',
    parameters: {
      id: { type: 'string', description: 'Fetch only this source id. Omitted or "all": fetch every enabled source.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          message: { type: 'string' },
          added: { type: 'integer' },
          duplicated: { type: 'integer' },
          results: { type: 'array', items: fetchResultSchema },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.ok !== true) return text(`Fetch failed: ${value.error ?? 'unknown error'}`)
        return text(value.message ?? 'fetch done')
      },
    },
    async execute(args) {
      try {
        if (args.id !== undefined && args.id !== '' && args.id !== 'all') {
          const result = await service.fetchOne(args.id)
          // Omit `error` when absent: the harness validates successful tool
          // values as lossless JSON, and an own `undefined` property fails.
          return {
            ok: result.error === undefined,
            ...(result.error !== undefined ? { error: result.error } : {}),
            message: singleMessage(result),
            added: result.added,
            duplicated: result.duplicated,
            results: [result],
          }
        }
        const cycle = await service.fetchCycle()
        return {
          ok: true,
          message: cycleMessage(cycle.totalAdded, cycle.totalFetched, cycle.errors),
          added: cycle.totalAdded,
          duplicated: cycle.sources.reduce((sum, r) => sum + r.duplicated, 0),
          results: cycle.sources,
        }
      } catch (error) {
        log.error('rss_fetch failed', error)
        return { ok: false, error: errorMessage(error), message: 'fetch failed', added: 0, duplicated: 0, results: [] }
      }
    },
  })
}

function singleMessage(result: { fetched: number; added: number; duplicated: number }): string {
  return `source fetched: ${result.fetched} items, added ${result.added}, skipped ${result.duplicated} duplicates`
}

function cycleMessage(added: number, fetched: number, errors: number): string {
  return `fetch cycle done: fetched ${fetched} items total, added ${added} new, ${errors} source errors`
}

// ------------------------------------------------------------- rss_digest

export function rssDigestTool(service: RssService, log: LogSink) {
  return defineTool({
    name: 'rss_digest',
    description: 'Generate the RSS digest now: summarize undigested stored items (LLM when enabled, extractive fallback) '
      + 'and return the complete Markdown briefing.',
    parameters: {
      language: {
        type: 'string',
        enum: ['zh', 'en'],
        description: 'Summary language. Default: the configured language.',
      },
      mode: {
        type: 'string',
        enum: ['batch', 'single'],
        description: 'Summarize all items in one call (batch) or per item (single). Default: configured mode.',
      },
      maxItems: { type: 'integer', description: 'Maximum items to include. Default: configured value.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          itemCount: { type: 'integer' },
          summarySource: { type: 'string' },
          date: { type: 'string' },
          language: { type: 'string' },
          markdown: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.ok !== true) return text(`Digest failed: ${value.error ?? 'unknown error'}`)
        return text(value.markdown ?? '(empty digest)')
      },
    },
    async execute(args) {
      try {
        const overrides: {
          language?: DigestLanguage
          mode?: SummaryMode
          maxItems?: number
        } = {}
        if (args.language !== undefined) overrides.language = args.language
        if (args.mode !== undefined) overrides.mode = args.mode
        if (args.maxItems !== undefined) overrides.maxItems = args.maxItems
        const document = await service.digest(overrides)
        return {
          ok: true,
          itemCount: document.itemCount,
          summarySource: document.summarySource,
          date: document.date,
          language: document.language,
          markdown: document.markdown,
        }
      } catch (error) {
        log.error('rss_digest failed', error)
        return { ok: false, error: errorMessage(error) }
      }
    },
  })
}

// ---------------------------------------------------------------- wiring

/**
 * Register all rss-* tools. Returns a disposer that unregisters them (the
 * registry also disposes them with the owning fiber).
 */
export function registerTools(ctx: Context, service: RssService, log: LogSink): () => void {
  const disposers: Array<() => void> = [
    ctx.tools.register(rssListTool(service)),
    ctx.tools.register(rssAddTool(service)),
    ctx.tools.register(rssRemoveTool(service)),
    ctx.tools.register(rssFetchTool(service, log)),
    ctx.tools.register(rssDigestTool(service, log)),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof RssServiceError) return error.message
  return error instanceof Error ? error.message : String(error)
}