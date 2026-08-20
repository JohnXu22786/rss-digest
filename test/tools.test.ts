import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rssFetchTool, rssListTool } from '../lib/tools.js'
import { RssService } from '../lib/service.js'
import { Store } from '../lib/store.js'

const log = { info() {}, warn() {}, error() {} }

async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), 'rss-tools-'))
  const store = new Store({ path: join(dir, 'store.json') })
  await store.load()
  const fetcher = async (url: string) => {
    if (url.endsWith('/feed.xml')) {
      return {
        url,
        status: 200,
        body: `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>`
          + `<item><title>One</title><link>https://example.com/1</link></item></channel></rss>`,
      }
    }
    return { url, status: 404, error: 'HTTP 404 Not Found' }
  }
  const service = new RssService({ store, log, fetcher, now: () => new Date('2026-08-17T02:00:00Z') })
  return { service, dir }
}

test('rss_fetch single-source success carries no undefined-valued keys (lossless JSON)', async () => {
  const { service, dir } = await makeService()
  const source = await service.addSource({ url: 'https://example.com/feed.xml' })
  const tool = rssFetchTool(service, log)
  const result = await tool.execute({ id: source.id }, {} as never)
  assert.equal((result as { ok: boolean }).ok, true)
  // The harness snapshots successful tool values as lossless JSON; an own
  // property holding `undefined` would fail that snapshot.
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    assert.notEqual(value, undefined, `key ${key} must not be undefined`)
  }
  await rm(dir, { recursive: true, force: true })
})

test('rss_fetch single-source failure carries an error and ok=false', async () => {
  const { service, dir } = await makeService()
  await service.addSource({ url: 'https://example.com/feed.xml' })
  const tool = rssFetchTool(service, log)
  const result = await tool.execute({ id: 'src-missing' }, {} as never) as { ok: boolean; error?: string }
  assert.equal(result.ok, false)
  assert.ok(result.error !== undefined)
  await rm(dir, { recursive: true, force: true })
})

test('rss_list output is lossless JSON and counts sources', async () => {
  const { service, dir } = await makeService()
  await service.addSource({ url: 'https://example.com/feed.xml', title: 'T' })
  const tool = rssListTool(service)
  const result = await tool.execute({}, {} as never) as { ok: boolean; count: number; sources: unknown[] }
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.sources.length, 1)
  await rm(dir, { recursive: true, force: true })
})