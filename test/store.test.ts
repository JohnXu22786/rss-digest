import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeStoreData, Store, undigestedItems } from '../lib/store.js'
import type { FeedItem } from '../lib/types.js'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rss-store-'))
}

function sampleItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'src-1:item1',
    sourceId: 'src-1',
    title: 'headline',
    link: 'https://example.com/1',
    summary: '',
    content: '',
    publishedAt: '',
    fetchedAt: '2026-08-17T08:00:00.000Z',
    hash: 'abc',
    digestedDay: '',
    ...overrides,
  }
}

test('store saves and reloads sources and items', async () => {
  const dir = await tempDir()
  const path = join(dir, 'store.json')
  const store = new Store({ path })
  await store.load()
  store.addSource({ id: 'src-1', url: 'https://example.com/feed', title: 'Example', enabled: true, addedAt: '2026-08-17T00:00:00Z' })
  store.addItems([sampleItem()])
  await store.save()

  const next = new Store({ path })
  await next.load()
  assert.equal(next.sources.length, 1)
  assert.equal(next.sources[0]!.url, 'https://example.com/feed')
  assert.equal(next.items.length, 1)
  assert.equal(next.items[0]!.title, 'headline')
  await rm(dir, { recursive: true, force: true })
})

test('store quarantines corrupt files by moving them aside', async () => {
  const dir = await tempDir()
  const path = join(dir, 'store.json')
  await writeFile(path, '{ not json !!!', 'utf8')
  const store = new Store({ path })
  await store.load()
  assert.equal(store.sources.length, 0)
  // The corrupt original was MOVED aside; a fresh store can be saved in its place.
  const leftovers = (await readdir(dir)).filter((name) => name.startsWith('store.json.corrupt-'))
  assert.equal(leftovers.length, 1)
  assert.equal((await readFile(path, 'utf8').catch(() => '')).length, 0)
  await store.save()
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.schema, 1)
  // A second load does not re-quarantine (the original is gone now).
  await store.load()
  const again = (await readdir(dir)).filter((name) => name.startsWith('store.json.corrupt-'))
  assert.equal(again.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('store rejects files written by a newer schema (no downgrade)', async () => {
  const dir = await tempDir()
  const path = join(dir, 'store.json')
  await writeFile(path, JSON.stringify({ schema: 99, sources: [], items: [] }), 'utf8')
  const store = new Store({ path })
  await store.load()
  assert.equal(store.sources.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test('normalizeStoreData fills defaults and tolerates garbage', () => {
  assert.deepEqual(normalizeStoreData({ schema: 1, sources: [], items: [] })!.meta, {
    lastFetchAt: '',
    lastDigestAt: '',
    lastDigestDay: '',
  })
  assert.deepEqual(normalizeStoreData(null), null)
  assert.deepEqual(normalizeStoreData('nope'), null)
  // Element-level garbage is dropped, not propagated.
  const partial = normalizeStoreData({ schema: 1, sources: [{ x: 1 }], items: ['no'] })
  assert.equal(partial!.sources.length, 0)
  assert.equal(partial!.items.length, 0)
  // Valid elements are kept and missing fields are defaulted.
  const valid = normalizeStoreData({
    schema: 1,
    sources: [{ url: 'https://a' }],
    items: [{ id: 'i1', fetchedAt: '2026-08-17T00:00:00.000Z' }],
  })
  assert.equal(valid!.sources.length, 1)
  assert.equal(valid!.sources[0]!.title, '')
  assert.equal(valid!.sources[0]!.enabled, true)
  assert.equal(valid!.items[0]!.hash, '')
  assert.equal(valid!.items[0]!.digestedDay, '')
})

test('removeSource drops the source and its items', async () => {
  const dir = await tempDir()
  const path = join(dir, 'store.json')
  const store = new Store({ path })
  store.addSource({ id: 'src-1', url: 'https://a', title: '', enabled: true, addedAt: '' })
  store.addItems([sampleItem(), sampleItem({ id: 'src-2:other', sourceId: 'src-2' })])
  assert.equal(store.removeSource('src-1'), true)
  assert.deepEqual(store.items.map((i) => i.sourceId), ['src-2'])
  assert.equal(store.removeSource('missing'), false)
  await rm(dir, { recursive: true, force: true })
})

test('markDigested and undigestedItems cooperate on day keys', () => {
  const store = new Store({ path: join(tmpdir(), 'nope.json') })
  const a = sampleItem({ id: 'a', fetchedAt: '2026-08-17T02:00:00.000Z' })
  const b = sampleItem({ id: 'b', fetchedAt: '2026-08-17T01:00:00.000Z' })
  store.addItems([a, b])
  store.markDigested(['a'], '2026-08-17')
  const picked = undigestedItems(store.items, '2026-08-17', 10)
  assert.deepEqual(picked.map((item) => item.id), ['b'])
  assert.equal(store.countUndigested('2026-08-17'), 1)
  assert.equal(store.countUndigested('2026-08-18'), 2)
})

test('retention cap prunes the oldest items on save', async () => {
  const dir = await tempDir()
  const store = new Store({ path: join(dir, 'store.json'), maxItems: 3 })
  for (let index = 0; index < 5; index += 1) {
    store.addItems([sampleItem({
      id: `item-${index}`,
      fetchedAt: `2026-08-17T0${index}:00:00.000Z`,
    })])
  }
  await store.save()
  assert.equal(store.items.length, 3)
  assert.equal(store.items[0]!.id, 'item-2')
  await rm(dir, { recursive: true, force: true })
})