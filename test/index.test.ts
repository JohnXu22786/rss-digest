import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import Config, { type Config as ConfigType } from '../lib/config.js'
import { apply } from '../lib/index.js'
import { nextZonedOccurrence } from '../lib/time.js'
import type { Context } from '@deepseek-ai/cordis'

interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown }
  execute: (args: unknown) => Promise<unknown>
}

/** Minimal context double covering exactly what `apply` touches. */
function fakeContext(): { ctx: Context; tools: RegisteredTool[]; intervals: number[]; timeouts: number[] } {
  const tools: RegisteredTool[] = []
  const intervals: number[] = []
  const timeouts: number[] = []
  const logger = Object.assign(
    () => logger,
    { info() {}, warn() {}, error() {} },
  )
  const ctx = {
    logger: () => logger,
    tools: {
      register: (definition: RegisteredTool) => {
        tools.push(definition)
        return () => {}
      },
    },
    timeout: (_callback: () => void, delay: number) => {
      timeouts.push(delay)
      return () => {}
    },
    interval: (_callback: () => void, delay: number) => {
      intervals.push(delay)
      return () => {}
    },
  }
  return { ctx: ctx as unknown as Context, tools, intervals, timeouts }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('Config schema fills defaults and validates types', () => {
  const cfg = Config({}) as ConfigType
  assert.equal(cfg.fetch.intervalMinutes, 60)
  assert.equal(cfg.fetch.enabled, true)
  assert.equal(cfg.summary.language, 'zh')
  assert.equal(cfg.summary.mode, 'batch')
  assert.equal(cfg.digest.time, '08:00')
  assert.equal(cfg.digest.deliverTo, 'both')
  assert.equal(cfg.dedupe.threshold, 0.9)
  assert.equal(cfg.sources.length, 0)
  // Partial sections are merged over their defaults.
  const partial = Config({ fetch: { intervalMinutes: 30 } }) as ConfigType
  assert.equal(partial.fetch.intervalMinutes, 30)
  assert.equal(partial.fetch.enabled, true)
  // Type violations are rejected.
  assert.throws(() => Config({ fetch: { intervalMinutes: 'oops' } }))
  assert.throws(() => Config({ sources: [{ url: 42 }] }))
  // Range constraints are enforced.
  assert.throws(() => Config({ fetch: { intervalMinutes: 1 } }))
})

test('apply registers the five rss tools and arms the schedulers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rss-apply-'))
  const { ctx, tools, intervals, timeouts } = fakeContext()
  const config: ConfigType = {
    dataPath: join(dir, 'store.json'),
    sources: [{ url: 'https://example.com/a.xml', title: 'A' }],
    fetch: { enabled: true, intervalMinutes: 60, onStartup: true, requestTimeoutMs: 15_000, sizeLimitBytes: 1024, retries: 2, maxItemsPerSource: 50, storeContentChars: 4000, maxStoredItems: 100 },
    summary: { enabled: false, mode: 'batch', language: 'zh', maxLength: 800, maxTokens: 1024, provider: '', model: '' },
    dedupe: { threshold: 0.9, compareContent: false },
    digest: { enabled: true, time: '08:00', timezone: 'UTC', maxItems: 20, deliverTo: 'file', includeItemLinks: true },
  }
  // Expected first-fire delay, computed BEFORE apply() so the scheduler and
  // the assertion observe the same wall-clock minute.
  const expectedFirstFire = nextZonedOccurrence('08:00', 'UTC', new Date()).secondsUntil * 1000
  apply(ctx, config)
  await wait(50)

  assert.deepEqual(tools.map((tool) => tool.name), [
    'rss_list',
    'rss_add',
    'rss_remove',
    'rss_fetch',
    'rss_digest',
  ])
  for (const tool of tools) {
    assert.ok(tool.description.length > 0)
    assert.ok(typeof tool.execute === 'function')
    assert.ok(tool.output.schema !== undefined)
  }
  // fetch interval (60 min); the daily digest re-arms via timeouts, not a
  // 24h interval, so it stays anchored to the configured wall-clock time.
  assert.ok(intervals.some((ms) => ms === 60 * 60_000))
  // startup fetch + first digest fire
  assert.ok(timeouts.some((ms) => ms === 10_000))
  assert.ok(timeouts.some((ms) => Math.abs(ms - expectedFirstFire) < 1000), `timeouts: ${timeouts.join(', ')}`)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('apply seeds configured sources into the store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rss-apply-'))
  const { ctx } = fakeContext()
  const config: ConfigType = {
    dataPath: join(dir, 'store.json'),
    sources: [
      { url: 'https://example.com/a.xml', title: 'A' },
      { url: 'https://example.com/a.xml', title: 'A again' }, // duplicate URL: ignored
    ],
    fetch: { enabled: false, intervalMinutes: 60, onStartup: false, requestTimeoutMs: 15_000, sizeLimitBytes: 1024, retries: 2, maxItemsPerSource: 50, storeContentChars: 4000, maxStoredItems: 100 },
    summary: { enabled: false, mode: 'batch', language: 'zh', maxLength: 800, maxTokens: 1024, provider: '', model: '' },
    dedupe: { threshold: 0.9, compareContent: false },
    digest: { enabled: false, time: '08:00', timezone: '', maxItems: 20, deliverTo: 'file', includeItemLinks: true },
  }
  apply(ctx, config)
  await wait(100)

  const raw = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { sources: unknown[] }
  assert.equal(raw.sources.length, 1)
  assert.equal((raw.sources[0] as { url: string }).url, 'https://example.com/a.xml')
  await rm(dir, { recursive: true, force: true })
})