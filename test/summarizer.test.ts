import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractiveSummary, summarize, truncateText, type SummarizableItem } from '../lib/summarizer.js'
import type { LlmClient } from '../lib/summarizer.js'

const items: SummarizableItem[] = [
  {
    title: 'First',
    link: 'https://example.com/1',
    summary: 'The first item body text that is long enough to matter.',
    content: '',
    sourceTitle: 'Feed A',
    publishedAt: '2026-08-17T01:00:00Z',
  },
  {
    title: 'Second',
    link: 'https://example.com/2',
    summary: 'Second item body.',
    content: '',
    sourceTitle: 'Feed B',
    publishedAt: '2026-08-16T01:00:00Z',
  },
]

test('extractive summary lists items with titles and links', () => {
  const out = extractiveSummary(items, 'zh', 500)
  assert.ok(out.includes('1. First'))
  assert.ok(out.includes('2. Second'))
  assert.ok(out.includes('https://example.com/1'))
  assert.ok(out.length <= 500)
})

test('extractive summary handles empty input gracefully', () => {
  assert.ok(extractiveSummary([], 'zh', 100) !== '')
})

test('truncateText bounds the output and appends an ellipsis', () => {
  const out = truncateText('abcdefghij', 5)
  assert.equal(out, 'abcd…')
  assert.equal(truncateText('short', 100), 'short')
})

test('truncateText never emits lone surrogates', () => {
  const out = truncateText('a😀b', 3)
  assert.ok(!/[\uD800-\uDFFF]/.test(out))
  assert.equal(out, 'a…')
})

test('summarize uses the model and hard-caps the result', async () => {
  const client: LlmClient = {
    async generateText() {
      return 'A generated summary.'.repeat(200)
    },
  }
  const result = await summarize({ items, language: 'en', mode: 'batch', maxLength: 120, maxTokens: 256 }, client, true)
  assert.equal(result.source, 'llm')
  assert.ok(result.text.length <= 120)
})

test('summarize degrades to extractive on model failure', async () => {
  const client: LlmClient = {
    async generateText() {
      throw new Error('network down')
    },
  }
  const result = await summarize({ items, language: 'zh', mode: 'batch', maxLength: 200, maxTokens: 64 }, client, true)
  assert.equal(result.source, 'extractive')
  assert.match(result.error!, /network down/)
  assert.ok(result.text.includes('First'))
})

test('summarize degrades on empty model output', async () => {
  const client: LlmClient = {
    async generateText() {
      return '   '
    },
  }
  const result = await summarize({ items, language: 'en', mode: 'single', maxLength: 400 }, client, true)
  assert.equal(result.source, 'extractive')
})

test('summarize skips the model when disabled or clientless', async () => {
  let called = false
  const client: LlmClient = {
    async generateText() {
      called = true
      return 'x'
    },
  }
  const result = await summarize({ items, language: 'en', mode: 'batch', maxLength: 300 }, client, false)
  assert.equal(result.source, 'extractive')
  assert.equal(called, false)
  const clientless = await summarize({ items, language: 'en', mode: 'batch', maxLength: 300 }, undefined, true)
  assert.equal(clientless.source, 'extractive')
})

test('single and batch modes produce structurally different prompts', async () => {
  const { buildPrompt } = await import('../lib/summarizer.js')
  const batch = buildPrompt({ items, language: 'zh', mode: 'batch', maxLength: 400 })
  const single = buildPrompt({ items, language: 'zh', mode: 'single', maxLength: 400 })
  assert.ok(batch.prompt.includes('整体摘要'))
  assert.ok(single.prompt.includes('逐条总结'))
  assert.ok(batch.prompt.includes('「First」'))
  assert.ok(batch.prompt.includes('Feed A'))
})