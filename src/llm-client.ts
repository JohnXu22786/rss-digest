/**
 * OpenAI-compatible REST chat-completions client used by the CLI.
 *
 * DeepSeek and most compatible gateways expose the standard
 * `/chat/completions` shape, so the CLI can call a model directly without a
 * running harness. The dsh runtime path uses a different adapter
 * (`ctx.llm`); this module is deliberately standalone.
 */

import type { LlmTextRequest, LlmClient } from './summarizer.js'
import { RssServiceError } from './service.js'

export interface OpenAiRestClientOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 60_000

export class OpenAiRestLlmClient implements LlmClient {
  readonly baseUrl: string
  readonly model: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAiRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    if (this.baseUrl === '') throw new RssServiceError('LLM base URL must not be empty')
    this.apiKey = options.apiKey
    if (this.apiKey === '') throw new RssServiceError('LLM API key is required (DEEPSEEK_API_KEY or --llm-key)')
    this.model = options.model
    if (this.model === '') throw new RssServiceError('LLM model must not be empty')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  async generateText(request: LlmTextRequest): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const combined = request.signal === undefined
      ? { signal: controller.signal, dispose(): void {} }
      : combineSignals(controller.signal, request.signal)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          stream: false,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
        signal: combined.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new RssServiceError(`LLM HTTP ${response.status}: ${detail.slice(0, 300)}`)
      }
      const payload = (await response.json()) as Record<string, unknown>
      const content = readChatContent(payload)
      if (content === '') throw new RssServiceError('LLM returned an empty completion')
      return content
    } finally {
      clearTimeout(timer)
      combined.dispose()
    }
  }
}

/** Combine two abort signals so either can cancel the request. */
function combineSignals(left: AbortSignal, right: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (left.aborted || right.aborted) {
    return { signal: AbortSignal.abort(), dispose(): void {} }
  }
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  left.addEventListener('abort', onAbort, { once: true })
  right.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      left.removeEventListener('abort', onAbort)
      right.removeEventListener('abort', onAbort)
    },
  }
}

function readChatContent(payload: Record<string, unknown>): string {
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0] as Record<string, unknown>
  const message = first.message as Record<string, unknown> | undefined
  if (typeof message?.content === 'string') return message.content.trim()
  const text = first.text
  if (typeof text === 'string') return text.trim()
  return ''
}