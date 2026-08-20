import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFetcher } from '../lib/fetcher.js'
import type { FetchedDocument, FetchFailure } from '../lib/types.js'

function response(body: string, status = 200, contentType = 'application/xml'): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  })
}

test('fetches a document and returns the body', async () => {
  const fetchDoc = createFetcher({ fetchImpl: async () => response('<rss/>', 200) })
  const result = await fetchDoc('https://example.com/feed')
  assert.deepEqual((result as FetchedDocument).status, 200)
  assert.equal((result as FetchedDocument).body, '<rss/>')
})

test('maps non-2xx responses to failures', async () => {
  const fetchDoc = createFetcher({ fetchImpl: async () => response('nope', 404) })
  const result = await fetchDoc('https://example.com/feed') as FetchFailure
  assert.match(result.error, /404/)
})

test('aborts on timeout and reports a failure', async () => {
  const fetchDoc = createFetcher({
    timeoutMs: 40,
    retries: 0,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
  })
  const result = await fetchDoc('https://example.com/feed') as FetchFailure
  assert.equal(result.status, 0)
  assert.ok(result.error!.length > 0)
})

test('enforces the response size limit', async () => {
  const fetchDoc = createFetcher({
    sizeLimitBytes: 64,
    retries: 0,
    fetchImpl: async () => response('x'.repeat(10_000), 200),
  })
  const result = await fetchDoc('https://example.com/big') as FetchFailure
  assert.match(result.error!, /larger than 64 bytes/)
})

test('does not retry a permanently oversized response', async () => {
  let calls = 0
  const fetchDoc = createFetcher({
    sizeLimitBytes: 64,
    retries: 3,
    fetchImpl: async () => {
      calls += 1
      return response('x'.repeat(10_000), 200)
    },
  })
  const result = await fetchDoc('https://example.com/big') as FetchFailure
  assert.equal(calls, 1)
  assert.match(result.error!, /larger than 64 bytes/)
})

test('decodes multi-byte characters split across stream chunks correctly', async () => {
  // A 3-byte CJK character straddling two 59-byte chunks must not corrupt.
  const body = `<?xml version="1.0"?><rss><channel><title>${'汉'.repeat(60)}</title></channel></rss>`
  const boundary = 59
  const bytes = new TextEncoder().encode(body)
  const first = bytes.subarray(0, boundary)
  const second = bytes.subarray(boundary)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first)
      controller.enqueue(second)
      controller.close()
    },
  })
  const fetchDoc = createFetcher({
    retries: 0,
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    }),
  })
  const result = await fetchDoc('https://example.com/feed') as FetchedDocument
  assert.ok(!result.body.includes('\ufffd'), `corrupted text: ${result.body}`)
  assert.ok(result.body.includes('汉'.repeat(60)))
})

test('honors caller abort signals without retrying', async () => {
  let calls = 0
  const fetchDoc = createFetcher({
    retries: 2,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      calls += 1
      init?.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
  })
  const controller = new AbortController()
  const promise = fetchDoc('https://example.com/feed', controller.signal)
  controller.abort()
  const result = await promise as FetchFailure
  assert.ok(result.error !== undefined)
  assert.equal(result.retryable, false)
  assert.equal(calls, 1)
})

test('retries transient 5xx failures', async () => {
  let calls = 0
  const fetchDoc = createFetcher({
    retries: 2,
    fetchImpl: async () => {
      calls += 1
      return calls < 3 ? response('busy', 503) : response('<rss/>', 200)
    },
  })
  const result = await fetchDoc('https://example.com/feed') as FetchedDocument
  assert.equal(result.status, 200)
  assert.equal(calls, 3)
})

test('does not retry permanent 4xx failures', async () => {
  let calls = 0
  const fetchDoc = createFetcher({
    retries: 3,
    fetchImpl: async () => {
      calls += 1
      return response('forbidden', 403)
    },
  })
  const result = await fetchDoc('https://example.com/feed') as FetchFailure
  assert.equal(calls, 1)
  assert.match(result.error!, /403/)
})

test('exhausts retries and surfaces the last failure', async () => {
  let calls = 0
  const fetchDoc = createFetcher({
    retries: 2,
    fetchImpl: async () => {
      calls += 1
      return response('down', 500)
    },
  })
  const result = await fetchDoc('https://example.com/feed') as FetchFailure
  assert.equal(calls, 3)
  assert.match(result.error!, /500/)
})