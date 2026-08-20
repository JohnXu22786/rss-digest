/**
 * Delivery of generated digests into dsh conversations.
 *
 * The harness has no broadcast API: a plugin speaks to live sessions by
 * queueing a user-role message on each agent (`Agent.followup`). The agent
 * service is a SOFT dependency (headless profiles may omit it), so it is
 * reached structurally instead of through `inject` and never breaks startup.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

import type { LogSink } from './types.js'

export type DeliverTarget = 'agents' | 'file' | 'both'

interface AgentLike {
  followup?(message: unknown): void
}

export interface DigestDeliveryOptions {
  ctx: Context
  markdown: string
  /** Digest day key used in the notice summary and file name. */
  day: string
  itemCount: number
  target: DeliverTarget
  /** Directory where per-day digest files are written. */
  digestsDir: string
  log: LogSink
}

export interface DigestDeliveryResult {
  agentsDelivered: number
  fileWritten: boolean
  filePath?: string
}

/** Deliver a digested Markdown document per the configured target. */
export async function deliverDigest(options: DigestDeliveryOptions): Promise<DigestDeliveryResult> {
  const result: DigestDeliveryResult = { agentsDelivered: 0, fileWritten: false }
  if (options.target !== 'file') {
    result.agentsDelivered = deliverToAgents(
      options.ctx,
      options.markdown,
      options.day,
      options.itemCount,
      options.log,
    )
  }
  if (options.target !== 'agents') {
    const filePath = join(options.digestsDir, `${options.day}.md`)
    try {
      await mkdir(options.digestsDir, { recursive: true })
      await writeFile(filePath, `${options.markdown}\n`, 'utf8')
      result.fileWritten = true
      result.filePath = filePath
    } catch (error) {
      options.log.warn(`failed to write digest file ${filePath}: ${messageOf(error)}`)
    }
  }
  return result
}

function deliverToAgents(
  ctx: Context,
  markdown: string,
  day: string,
  itemCount: number,
  log: LogSink,
): number {
  const registry = (ctx as unknown as { agents?: { list?(): unknown[] } }).agents
  if (registry === undefined || typeof registry.list !== 'function') {
    log.warn('agent service not mounted; digest delivered to file/log only')
    return 0
  }
  let agents: unknown[]
  try {
    agents = registry.list()
  } catch (error) {
    log.warn(`agent listing failed; digest delivered to file/log only: ${messageOf(error)}`)
    return 0
  }
  const message = createUserMessage({
    content: [{ type: 'text', text: markdown }],
    source: {
      kind: 'plugin',
      plugin: 'rss-digest',
      form: 'notice',
      summary: `${day} RSS digest · ${itemCount} items`,
    },
  })
  let delivered = 0
  for (const candidate of agents) {
    const agent = candidate as AgentLike
    if (agent === null || typeof agent !== 'object' || typeof agent.followup !== 'function') {
      continue
    }
    try {
      agent.followup(message)
      delivered += 1
    } catch (error) {
      log.warn(`failed to deliver digest to an agent: ${messageOf(error)}`)
    }
  }
  return delivered
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}