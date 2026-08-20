import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DshLlmClient, resolveDshRoute } from '../lib/dsh-llm.js'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'

function chunks(text: string, reason: 'stop' | 'error' = 'stop'): StreamChunk[] {
  const out: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
  ]
  if (reason === 'error') {
    out.push({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } },
    })
  } else {
    out.push({ type: 'finish', reason: { kind: 'stop' } })
  }
  return out
}

function fakeLlm(overrides: Partial<Pick<LlmRuntime, 'listProviders' | 'listModels' | 'stream'>> = {}): LlmRuntime {
  const stream = overrides.stream ?? (async function* () {
    for (const chunk of chunks('Hello summary')) yield chunk
  })
  return {
    listProviders: overrides.listProviders ?? (() => [{ id: 'deepseek-official', name: 'DeepSeek' }]),
    listModels: overrides.listModels ?? (async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'flash' }]),
    stream,
  } as unknown as LlmRuntime
}

const log = { info() {}, warn() {}, error() {} }

test('resolveDshRoute honors configured provider/model', async () => {
  const llm = fakeLlm()
  const route = await resolveDshRoute(llm, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('resolveDshRoute falls back to the first registered provider and model', async () => {
  const llm = fakeLlm()
  const route = await resolveDshRoute(llm, { provider: '', model: '' })
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('resolveDshRoute fails loudly without providers', async () => {
  const llm = fakeLlm({ listProviders: () => [] })
  await assert.rejects(() => resolveDshRoute(llm, { provider: '', model: '' }), /no LLM provider/)
})

test('DshLlmClient accumulates text deltas and trims', async () => {
  const client = new DshLlmClient(fakeLlm(), { provider: '', model: '' }, log)
  const text = await client.generateText({ system: 's', prompt: 'p' })
  assert.equal(text, 'Hello summary')
})

test('DshLlmClient surfaces terminal stream failures', async () => {
  const stream = async function* () {
    for (const chunk of chunks('partial', 'error')) yield chunk
  }
  const client = new DshLlmClient(fakeLlm({ stream }), { provider: 'deepseek-official', model: 'm' }, log)
  await assert.rejects(() => client.generateText({ system: 's', prompt: 'p' }), /LLM call failed/)
})

test('DshLlmClient rejects empty completions', async () => {
  const stream = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const client = new DshLlmClient(fakeLlm({ stream }), { provider: 'deepseek-official', model: 'm' }, log)
  await assert.rejects(() => client.generateText({ system: 's', prompt: 'p' }), /empty completion/)
})