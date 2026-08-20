#!/usr/bin/env node
/**
 * Standalone command-line interface for the rss-digest core.
 *
 * Works without a running harness: the same {@link RssService} powers the dsh
 * plugin and this CLI. Model summarization needs an OpenAI-compatible chat-
 * completions endpoint (the DeepSeek API by default); without one, digests
 * fall back to extractive summaries — exactly like the plugin.
 *
 *   dsh-rss-digest list|status|add <url>|remove <id>|enable <id>|disable <id>|fetch [<id>]|digest
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { createFetcher } from './fetcher.js'
import { OpenAiRestLlmClient } from './llm-client.js'
import { resolveDataPath } from './paths.js'
import { RssService, RssServiceError } from './service.js'
import { Store } from './store.js'
import type { DigestLanguage, LogSink, SummaryMode } from './types.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { name: string; version: string }

const HELP = `dsh-rss-digest v${pkg.version} — RSS aggregation, summarization, and daily digests.

Usage:
  dsh-rss-digest <command> [args] [flags]

Commands:
  list                    Show all subscriptions (--items to include recent items)
  status                  Show store statistics
  add <url>               Subscribe to an RSS/Atom feed URL
  remove <id>             Unsubscribe by source id
  enable <id>             Enable polling for a source
  disable <id>            Disable polling for a source
  fetch [<id>]            Fetch one source, or all enabled sources
  digest                  Generate the Markdown digest for undigested items
  help                    Show this help

Flags:
  --db <path>             Store file path (default: $DSH_HOME/data/rss-digest or ./.dsh-rss-digest)
  --quiet                 Only print errors
  --out <path>            (digest) also write the Markdown document to a file
  --lang <zh|en>          (digest) summary language (default: zh)
  --mode <batch|single>   (digest) summarization mode (default: batch)
  --max-items <n>         (digest) maximum items (default: 20)
  --max-length <n>        (digest) summary character cap (default: 800)
  --no-llm                (digest) force extractive summaries
  --llm-base <url>        OpenAI-compatible endpoint root (default: https://api.deepseek.com)
  --llm-key <key>         API key (default: $DEEPSEEK_API_KEY)
  --llm-model <name>      Model id (default: deepseek-chat)
  --timezone <tz>         IANA timezone for digest day keys (default: host local)
  --version               Print the version
`

interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Map<string, string | true>
}

/** Flags that never consume a following value. */
const BOOLEAN_FLAGS = new Set(['quiet', 'items', 'no-llm', 'h', 'help', 'version'])

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  let command = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (eq !== -1) {
        flags.set(name, arg.slice(eq + 1))
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true)
      } else {
        const next = argv[index + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(name, next)
          index += 1
        } else {
          flags.set(name, true)
        }
      }
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      flags.set(arg.slice(1), true)
    } else if (command === '') {
      command = arg
    } else {
      positionals.push(arg)
    }
  }
  return { command, positionals, flags }
}

function flagString(flags: Map<string, string | true>, name: string, fallback: string): string {
  const value = flags.get(name)
  return typeof value === 'string' ? value : fallback
}

function flagNumber(flags: Map<string, string | true>, name: string, fallback: number): number {
  const value = flags.get(name)
  if (typeof value !== 'string') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function makeLog(quiet: boolean): LogSink {
  return {
    info: (message) => { if (!quiet) process.stderr.write(`[rss-digest] ${message}\n`) },
    warn: (message) => process.stderr.write(`[rss-digest] warning: ${message}\n`),
    error: (message, error) => {
      const detail = error instanceof Error ? `: ${error.message}` : ''
      process.stderr.write(`[rss-digest] error: ${message}${detail}\n`)
    },
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.flags.has('version')) {
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  if (args.command === '' || args.command === 'help' || args.flags.has('h') || args.flags.has('help')) {
    const explicit = args.command === 'help' || args.flags.has('h') || args.flags.has('help')
    ;(explicit ? process.stdout : process.stderr).write(HELP)
    return explicit ? 0 : 1
  }

  const quiet = args.flags.has('quiet')
  const log = makeLog(quiet)
  const dbPath = flagString(args.flags, 'db', resolveDataPath(''))
  const store = new Store({ path: dbPath, log })
  await store.load()
  const service = new RssService({
    store,
    log,
    fetcher: createFetcher(),
    digestPolicy: {
      language: (flagString(args.flags, 'lang', 'zh') === 'en' ? 'en' : 'zh') as DigestLanguage,
      mode: (flagString(args.flags, 'mode', 'batch') === 'single' ? 'single' : 'batch') as SummaryMode,
      maxLength: flagNumber(args.flags, 'max-length', 800),
      maxItems: flagNumber(args.flags, 'max-items', 20),
      timezone: flagString(args.flags, 'timezone', ''),
      includeItemLinks: true,
      summaryEnabled: !args.flags.has('no-llm'),
    },
    llmClient: buildLlmClient(args.flags),
  })

  switch (args.command) {
    case 'list':
      return cmdList(service, args)
    case 'status':
      return cmdStatus(service)
    case 'add':
      return cmdAdd(service, args.positionals[0], flagString(args.flags, 'title', ''))
    case 'remove':
      return cmdRemove(service, args.positionals[0])
    case 'enable':
    case 'disable':
      return cmdEnable(service, args.positionals[0], args.command === 'enable')
    case 'fetch':
      return cmdFetch(service, args.positionals[0])
    case 'digest':
      return cmdDigest(service, args)
    default:
      process.stderr.write(`unknown command: ${args.command}\n\n${HELP}`)
      return 1
  }
}

function buildLlmClient(flags: Map<string, string | true>) {
  if (flags.has('no-llm')) return undefined
  const key = flagString(flags, 'llm-key', process.env.DEEPSEEK_API_KEY ?? '')
  try {
    return new OpenAiRestLlmClient({
      baseUrl: flagString(flags, 'llm-base', 'https://api.deepseek.com'),
      apiKey: key,
      model: flagString(flags, 'llm-model', 'deepseek-chat'),
    })
  } catch (error) {
    // Missing key: degrade to extractive summaries instead of failing.
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[rss-digest] LLM summarization disabled (${reason}); using extractive fallback\n`)
    return undefined
  }
}

function cmdList(service: RssService, args: ParsedArgs): number {
  const sources = service.listSources()
  const showItems = args.flags.has('items')
  if (sources.length === 0) {
    process.stdout.write('no subscriptions\n')
    return 0
  }
  for (const source of sources) {
    process.stdout.write(
      `${source.id}\t${source.enabled ? 'on' : 'off'}\t${source.title === '' ? '(untitled)' : source.title}\t${source.url}\n`,
    )
  }
  if (showItems) {
    process.stdout.write('\nrecent items:\n')
    for (const item of service.recentItems(20)) {
      process.stdout.write(`- [${item.fetchedAt.slice(0, 10)}] ${item.title} ${item.link}\n`)
    }
  }
  return 0
}

function cmdStatus(service: RssService): number {
  const status = service.status()
  process.stdout.write([
    `sources:        ${status.sources} (${status.enabledSources} enabled)`,
    `items stored:   ${status.items}`,
    `undigested:     ${status.undigested}`,
    `last fetch:     ${status.lastFetchAt === '' ? '—' : status.lastFetchAt}`,
    `last digest:    ${status.lastDigestAt === '' ? '—' : `${status.lastDigestAt} (day ${status.lastDigestDay})`}`,
  ].join('\n') + '\n')
  return 0
}

async function cmdAdd(service: RssService, url: string | undefined, title: string): Promise<number> {
  if (url === undefined) {
    process.stderr.write('usage: dsh-rss-digest add <url>\n')
    return 1
  }
  try {
    const source = await service.addSource({ url, title })
    process.stdout.write(`added ${source.id}\t${source.url}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`error: ${errorMessage(error)}\n`)
    return 1
  }
}

async function cmdRemove(service: RssService, id: string | undefined): Promise<number> {
  if (id === undefined) {
    process.stderr.write('usage: dsh-rss-digest remove <id>\n')
    return 1
  }
  const ok = await service.removeSource(id)
  if (!ok) {
    process.stderr.write(`error: unknown source id ${id}\n`)
    return 1
  }
  process.stdout.write(`removed ${id}\n`)
  return 0
}

async function cmdEnable(service: RssService, id: string | undefined, enabled: boolean): Promise<number> {
  if (id === undefined) {
    process.stderr.write('usage: dsh-rss-digest enable|disable <id>\n')
    return 1
  }
  const ok = await service.setSourceEnabled(id, enabled)
  if (!ok) {
    process.stderr.write(`error: unknown source id ${id}\n`)
    return 1
  }
  process.stdout.write(`${enabled ? 'enabled' : 'disabled'} ${id}\n`)
  return 0
}

async function cmdFetch(service: RssService, id: string | undefined): Promise<number> {
  if (id === undefined || id === 'all') {
    const cycle = await service.fetchCycle()
    for (const source of cycle.sources) {
      process.stdout.write(
        `${source.sourceId}: fetched ${source.fetched}, added ${source.added}, duplicated ${source.duplicated}${source.error !== undefined ? ` (${source.error})` : ''}\n`,
      )
    }
    process.stdout.write(`cycle done: ${cycle.totalAdded} new items, ${cycle.errors} errors\n`)
    return cycle.errors > 0 ? 2 : 0
  }
  const result = await service.fetchOne(id)
  process.stdout.write(
    `${result.sourceId}: fetched ${result.fetched}, added ${result.added}, duplicated ${result.duplicated}${result.error !== undefined ? ` (${result.error})` : ''}\n`,
  )
  return result.error === undefined ? 0 : 2
}

async function cmdDigest(service: RssService, args: ParsedArgs): Promise<number> {
  const flags = args.flags
  const document = await service.digest({
    language: (flagString(flags, 'lang', 'zh') === 'en' ? 'en' : 'zh') as DigestLanguage,
    mode: (flagString(flags, 'mode', 'batch') === 'single' ? 'single' : 'batch') as SummaryMode,
    maxItems: flagNumber(flags, 'max-items', 20),
  })
  process.stdout.write(document.markdown)
  if (!document.markdown.endsWith('\n')) process.stdout.write('\n')
  const out = flagString(flags, 'out', '')
  if (out !== '') {
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, `${document.markdown}\n`, 'utf8')
    process.stdout.write(`\nwrote ${out}\n`)
  }
  return 0
}

function errorMessage(error: unknown): string {
  if (error instanceof RssServiceError) return error.message
  return error instanceof Error ? error.message : String(error)
}

const code = await main(process.argv.slice(2))
process.exitCode = code
