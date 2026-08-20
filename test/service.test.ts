import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RssService, RssServiceError } from '../lib/service.js'
import { Store } from '../lib/store.js'
import type { LlmClient } from '../lib/summarizer.js'
import type { FetchedDocument, FetchFailure } from '../lib/types.js'

const NOW = '2026-08-17T02:00:00Z'

function rss(title: string, items: Array<{ title: string; link: string }>): string {
  const body = items.map((item, index) => `
    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <guid>g-${index}</guid>
      <pubDate>${new Date(Date.UTC(2026, 7, 16 - index, 9)).toUTCString()}</pubDate>
      <description>body of ${item.title}</description>
    </item>`).join('')
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${body}</channel></rss>`
}

const FEEDS: Record<string, string> = {
  'https://example.com/a.xml': rss('Feed A', [
    { title: 'Apple launches new MacBook Pro model', link: 'https://example.com/a/1' },
    { title: 'Apple launches new MacBook Pro', link: 'https://example.com/a/2' },
    { title: 'Quantum computing breakthrough', link: 'https://example.com/a/3' },
  ]),
  'https://example.com/b.xml': rss('Feed B', [
    { title: 'A totally different headline', link: 'https://example.com/b/1' },
  ]),
}

class FakeLlm implements LlmClient {
  calls = 0
  async generateText(): Promise<string> {
    this.calls += 1
    return '这是模型生成的摘要。'
  }
}

async function makeService(overrides: { llm?: FakeLlm; threshold?: number; timezone?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rss-svc-'))
  const store = new Store({ path: join(dir, 'store.json') })
  await store.load()
  const fetcher = async (url: string): Promise<FetchedDocument | FetchFailure> => {
    const body = FEEDS[url]
    if (body === undefined) return { url, status: 404, error: 'HTTP 404 Not Found' }
    return { url, status: 200, body }
  }
  const service = new RssService({
    store,
    log: { info() {}, warn() {}, error() {} },
    fetcher,
    dedupe: { threshold: overrides.threshold ?? 0.9, compareContent: false },
    llmClient: overrides.llm,
    digestPolicy: { timezone: overrides.timezone ?? 'UTC' },
    now: () => new Date(NOW),
  })
  return { service, store, dir }
}

test('addSource validates URLs and refuses duplicates', async () => {
  const { service, dir } = await makeService()
  const source = await service.addSource({ url: 'https://example.com/a.xml', title: 'A' })
  assert.match(source.id, /^src-/)
  assert.equal(source.url, 'https://example.com/a.xml')
  assert.equal(source.title, 'A')
  assert.equal(source.enabled, true)
  await assert.rejects(() => service.addSource({ url: 'https://example.com/a.xml' }), RssServiceError)
  await assert.rejects(() => service.addSource({ url: 'ftp://example.com/x' }), RssServiceError)
  await assert.rejects(() => service.addSource({ url: 'not a url' }), RssServiceError)
  await rm(dir, { recursive: true, force: true })
})

test('fetchCycle ingests, dedupes exactly and fuzzily, and reports per-source results', async () => {
  const { service, dir } = await makeService({ threshold: 0.8 })
  await service.addSource({ url: 'https://example.com/a.xml' })
  await service.addSource({ url: 'https://example.com/b.xml' })
  const cycle = await service.fetchCycle()
  assert.equal(cycle.sources.length, 2)
  const a = cycle.sources.find((r) => r.sourceUrl.endsWith('/a.xml'))!
  assert.equal(a.fetched, 3)
  assert.equal(a.added, 2) // third item fuzzy-duplicates the second
  assert.equal(a.duplicated, 1)
  const b = cycle.sources.find((r) => r.sourceUrl.endsWith('/b.xml'))!
  assert.equal(b.added, 1)
  assert.equal(cycle.totalAdded, 3)
  assert.equal(cycle.errors, 0)
  assert.equal(service.store.items.length, 3)
  assert.equal(service.store.meta.lastFetchAt, '2026-08-17T02:00:00.000Z')
  await rm(dir, { recursive: true, force: true })
})

test('a second fetchCycle duplicates everything', async () => {
  const { service, dir } = await makeService()
  await service.addSource({ url: 'https://example.com/a.xml' })
  await service.fetchCycle()
  const again = await service.fetchCycle()
  assert.equal(again.totalAdded, 0)
  assert.ok(again.sources.every((r) => r.duplicated >= r.fetched))
  await rm(dir, { recursive: true, force: true })
})

test('fetch errors are reported without aborting the cycle', async () => {
  const { service, dir } = await makeService()
  await service.addSource({ url: 'https://example.com/a.xml' })
  await service.addSource({ url: 'https://example.com/missing.xml' })
  const cycle = await service.fetchCycle()
  assert.equal(cycle.errors, 1)
  const missing = cycle.sources.find((r) => r.sourceUrl.includes('missing'))!
  assert.match(missing.error!, /404/)
  assert.equal(service.store.items.length, 3)
  await rm(dir, { recursive: true, force: true })
})

test('disabled sources are skipped by fetchCycle but fetchOne still works', async () => {
  const { service, dir } = await makeService()
  const source = await service.addSource({ url: 'https://example.com/b.xml' })
  await service.setSourceEnabled(source.id, false)
  const cycle = await service.fetchCycle()
  assert.equal(cycle.sources.length, 0)
  const one = await service.fetchOne(source.id)
  assert.equal(one.added, 1)
  await rm(dir, { recursive: true, force: true })
})

test('digest summarizes undigested items via the model and marks them', async () => {
  const llm = new FakeLlm()
  const { service, dir } = await makeService({ llm })
  await service.addSource({ url: 'https://example.com/a.xml' })
  await service.addSource({ url: 'https://example.com/b.xml' })
  await service.fetchCycle()

  const document = await service.digest()
  assert.equal(document.itemCount, 4)
  assert.equal(document.summarySource, 'llm')
  assert.equal(llm.calls, 1)
  assert.ok(document.markdown.includes('这是模型生成的摘要。'))
  assert.ok(document.markdown.includes('Apple launches new MacBook Pro model'))
  assert.equal(service.store.meta.lastDigestDay, '2026-08-17')

  const second = await service.digest()
  assert.equal(second.itemCount, 0)
  assert.equal(second.summarySource, 'extractive')
  await rm(dir, { recursive: true, force: true })
})

test('digest degrades to extractive without a model client', async () => {
  const { service, dir } = await makeService()
  await service.addSource({ url: 'https://example.com/b.xml' })
  await service.fetchCycle()
  const document = await service.digest()
  assert.equal(document.summarySource, 'extractive')
  assert.ok(document.markdown.includes('A totally different headline'))
  await rm(dir, { recursive: true, force: true })
})

test('digest honors language, mode, and maxItems overrides', async () => {
  const { service, dir } = await makeService()
  await service.addSource({ url: 'https://example.com/a.xml' })
  await service.fetchCycle()
  const document = await service.digest({ language: 'en', mode: 'single', maxItems: 2 })
  assert.equal(document.language, 'en')
  assert.equal(document.summaryMode, 'single')
  assert.equal(document.itemCount, 2)
  assert.ok(document.markdown.startsWith('# RSS Daily Digest'))
  await rm(dir, { recursive: true, force: true })
})

test('removeSource drops the source and all its items', async () => {
  const { service, dir } = await makeService()
  const source = await service.addSource({ url: 'https://example.com/a.xml' })
  await service.fetchCycle()
  assert.equal(service.store.items.length, 3)
  await service.removeSource(source.id)
  assert.equal(service.store.sources.length, 0)
  assert.equal(service.store.items.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test('status reports store health', async () => {
  const { service, dir } = await makeService()
  await service.addSource({ url: 'https://example.com/a.xml' })
  await service.fetchCycle()
  const status = service.status()
  assert.equal(status.sources, 1)
  assert.equal(status.enabledSources, 1)
  assert.equal(status.items, 3)
  assert.equal(status.undigested, 3)
  await rm(dir, { recursive: true, force: true })
})