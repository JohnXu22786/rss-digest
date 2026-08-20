import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** Spawn the CLI asynchronously so in-process HTTP servers stay responsive. */
function cli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'lib', 'cli.js'), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }))
  })
}

const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>CLI Test Feed</title>
    <item>
      <title>CLI headline one</title>
      <link>https://example.com/1</link>
      <pubDate>Mon, 17 Aug 2026 08:00:00 GMT</pubDate>
      <description>first body</description>
    </item>
    <item>
      <title>CLI headline two</title>
      <link>https://example.com/2</link>
      <pubDate>Mon, 17 Aug 2026 09:00:00 GMT</pubDate>
      <description>second body</description>
    </item>
  </channel>
</rss>`

function startServer(): Promise<{ port: number; llmCalls: () => number; close: () => Promise<void> }> {
  let llmCount = 0
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat/completions') {
      llmCount += 1
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const payload = JSON.parse(body) as { messages: Array<{ role: string }> }
        assert.ok(payload.messages.some((m) => m.role === 'system'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Server-generated summary.' } }] }))
      })
      return
    }
    if (req.method === 'GET' && req.url === '/feed.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      res.end(FEED_XML)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        llmCalls: () => llmCount,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

test('cli end-to-end: add, fetch, list, digest (extractive), status, remove', async () => {
  const server = await startServer()
  const dir = await mkdtemp(join(tmpdir(), 'rss-cli-'))
  const db = join(dir, 'store.json')
  const feedUrl = `http://127.0.0.1:${server.port}/feed.xml`

  const added = await cli(dir, ['add', feedUrl, '--title', 'Test', '--db', db])
  assert.equal(added.code, 0, added.stderr)
  const sourceId = /added (\S+)/.exec(added.stdout)?.[1]
  assert.ok(sourceId, added.stdout)

  const fetched = await cli(dir, ['fetch', '--db', db])
  assert.equal(fetched.code, 0, fetched.stderr)
  assert.match(fetched.stdout, /cycle done: 2 new items, 0 errors/)

  const listed = await cli(dir, ['list', '--db', db])
  assert.ok(listed.stdout.includes(feedUrl))
  assert.ok(listed.stdout.includes('Test'))

  const digestOut = join(dir, 'digest.md')
  const digested = await cli(dir, ['digest', '--lang', 'en', '--no-llm', '--out', digestOut, '--db', db])
  assert.equal(digested.code, 0, digested.stderr)
  assert.ok(digested.stdout.includes('# RSS Daily Digest'))
  assert.ok(digested.stdout.includes('CLI headline one'))
  const file = await readFile(digestOut, 'utf8')
  assert.ok(file.includes('CLI headline two'))

  const status = await cli(dir, ['status', '--db', db])
  assert.match(status.stdout, /sources:\s+1/)
  assert.match(status.stdout, /undigested:\s+0/)

  const removed = await cli(dir, ['remove', sourceId!, '--db', db])
  assert.equal(removed.code, 0, removed.stderr)
  const after = await cli(dir, ['list', '--db', db])
  assert.ok(after.stdout.includes('no subscriptions'))

  await rm(dir, { recursive: true, force: true })
  await server.close()
})

test('cli digest uses the LLM endpoint when configured', async () => {
  const server = await startServer()
  const dir = await mkdtemp(join(tmpdir(), 'rss-cli-'))
  const db = join(dir, 'store.json')
  const base = `http://127.0.0.1:${server.port}`
  const feedUrl = `${base}/feed.xml`

  await cli(dir, ['add', feedUrl, '--db', db])
  const fetched = await cli(dir, ['fetch', '--db', db])
  assert.equal(fetched.code, 0, fetched.stderr)
  const digested = await cli(dir, [
    'digest', '--lang', 'en', '--llm-base', base, '--llm-key', 'sk-test', '--llm-model', 'm1', '--db', db,
  ])
  assert.equal(digested.code, 0, digested.stderr)
  assert.ok(digested.stdout.includes('Server-generated summary.'), `digest stdout: ${digested.stdout}`)
  assert.ok(server.llmCalls() >= 1)

  await rm(dir, { recursive: true, force: true })
  await server.close()
})

test('cli reports errors and unknown commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rss-cli-'))
  const unknown = await cli(dir, ['frobnicate'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /unknown command/)
  const badAdd = await cli(dir, ['add', 'ftp://x.example/feed'])
  assert.equal(badAdd.code, 1)
  assert.match(badAdd.stderr, /only http/)
  const missing = await cli(dir, ['remove', 'src-nope'])
  assert.equal(missing.code, 1)
  await rm(dir, { recursive: true, force: true })
})