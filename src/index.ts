/**
 * dsh-rss-digest bundle entry.
 *
 * Exports the Cordis plugin contract consumed by the dsh loader:
 *  - `name`   display metadata
 *  - `inject` required services (timer, tools, llm — all part of dsh-base)
 *  - `Config` validated Standard-Schema configuration
 *  - `apply(ctx, config)` the plugin body
 *
 * The patch row in `cordis.patch.yml` names this package; the loader resolves
 * this module and applies it with the row's `config` (merged with defaults).
 */

import '@deepseek-ai/cordis-plugin-timer'

import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import Config from './config.js'
import type { Config as ConfigType } from './config.js'
import { DshLlmClient } from './dsh-llm.js'
import { deliverDigest } from './delivery.js'
import { createFetcher } from './fetcher.js'
import { resolveDataPath } from './paths.js'
import { redactUrl, RssService, RssServiceError } from './service.js'
import { startScheduler } from './scheduler.js'
import { Store } from './store.js'
import { registerTools } from './tools.js'
import type { LogSink } from './types.js'

export const name = 'rss-digest'

export const inject = ['timer', 'tools', 'llm']

export function apply(ctx: Context, config: ConfigType): void {
  const named = ctx.logger('rss-digest')
  const log: LogSink = {
    info: (message) => named.info(message),
    warn: (message) => named.warn(message),
    error: (message, error) => {
      if (error === undefined) named.error(message)
      else named.error(`${message}: ${String(error)}`)
    },
  }

  const dataPath = resolveDataPath(config.dataPath)
  const store = new Store({ path: dataPath, maxItems: config.fetch.maxStoredItems, log })
  const service = new RssService({
    store,
    log,
    fetcher: createFetcher({
      timeoutMs: config.fetch.requestTimeoutMs,
      sizeLimitBytes: config.fetch.sizeLimitBytes,
      retries: config.fetch.retries,
    }),
    dedupe: { threshold: config.dedupe.threshold, compareContent: config.dedupe.compareContent },
    maxItemsPerSource: config.fetch.maxItemsPerSource,
    storeContentChars: config.fetch.storeContentChars,
    llmClient: config.summary.enabled
      ? new DshLlmClient(ctx.llm, { provider: config.summary.provider, model: config.summary.model }, log)
      : undefined,
    digestPolicy: {
      language: config.summary.language,
      mode: config.summary.mode,
      summaryEnabled: config.summary.enabled,
      maxLength: config.summary.maxLength,
      maxTokens: config.summary.maxTokens,
      maxItems: config.digest.maxItems,
      timezone: config.digest.timezone,
      includeItemLinks: config.digest.includeItemLinks,
    },
  })

  log.info(`rss-digest ready; store=${dataPath}`)

  // Bootstrap: load the persisted store first — the scheduler and the tools
  // must never observe (or persist over) the pristine empty state — then seed
  // `sources` declared in configuration. All of this happens after apply()
  // returns so the fiber is never blocked on I/O; failures are logged rather
  // than thrown. Cordis fibers propagate their async context through promise
  // chains, so registrations made here still belong to this plugin fiber.
  void store
    .load()
    .then(async () => {
      registerTools(ctx, service, log)
      startScheduler(ctx, {
        fetch: config.fetch,
        digest: config.digest,
        runFetchCycle: (signal) => service.fetchCycle(signal),
        runDailyDigest: async () => {
          const document = await service.digest()
          const result = await deliverDigest({
            ctx,
            markdown: document.markdown,
            day: document.date,
            itemCount: document.itemCount,
            target: config.digest.deliverTo,
            digestsDir: join(dirname(dataPath), 'digests'),
            log,
          })
          log.info(
            `daily digest pushed: ${document.itemCount} items, ${result.agentsDelivered} agent(s), file=${result.fileWritten}`,
          )
        },
        log,
      })
      for (const input of config.sources) {
        try {
          const source = await service.addSource({ url: input.url, title: input.title })
          if (input.enabled === false) {
            await service.setSourceEnabled(source.id, false)
          }
        } catch (error) {
          if (error instanceof RssServiceError && error.message.startsWith('already subscribed')) continue
          log.warn(`configured source "${redactUrl(input.url)}" not loaded: ${String(error)}`)
        }
      }
    })
    .catch((error) => log.error('startup bootstrap failed', error))
}

export { Config }
export default { name, inject, Config, apply }