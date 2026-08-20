/**
 * Periodic scheduling for fetch cycles and daily digests, built on the
 * harness timer seam (`ctx.timeout` / `ctx.interval`, injected via `'timer'`).
 *
 * Note on dsh's job model: `ctx.jobs` is the registry for long-running task
 * *executions* (bash/subagent jobs), not a cron scheduler — the framework's
 * scheduling seam is the timer service. Fetch cycles and digests are short
 * process-local tasks, so they schedule through the timer.
 *
 * The daily digest re-arms itself after every run by recomputing the next
 * wall-clock occurrence (`nextZonedOccurrence`), so it stays anchored to the
 * configured HH:MM across restarts, drift, and DST transitions.
 */

import type { Context } from '@deepseek-ai/cordis'

import type { DigestSectionConfig, FetchSectionConfig } from './config.js'
import { nextZonedOccurrence } from './time.js'
import type { FetchCycleResult, LogSink } from './types.js'

export interface SchedulerOptions {
  fetch: FetchSectionConfig
  digest: DigestSectionConfig
  runFetchCycle: (signal?: AbortSignal) => Promise<FetchCycleResult>
  runDailyDigest: () => Promise<void>
  log: LogSink
}

const STARTUP_FETCH_DELAY_MS = 10_000

/** Arm all periodic tasks; returns a disposer that stops them. */
export function startScheduler(ctx: Context, options: SchedulerOptions): () => void {
  const disposers: Array<() => void> = []
  // The one pending daily timer; replaced on every re-arm. The callback form
  // of ctx.timeout disposes its own effect when it fires, so a stale
  // reference is an idempotent no-op.
  let nextTimer: (() => void) | undefined

  if (options.fetch.enabled && options.fetch.intervalMinutes >= 5) {
    let fetchRunning = false
    const cycle = (): void => {
      if (fetchRunning) return
      fetchRunning = true
      void options
        .runFetchCycle()
        .catch((error) => options.log.error('scheduled fetch cycle failed', error))
        .finally(() => {
          fetchRunning = false
        })
    }
    if (options.fetch.onStartup) {
      disposers.push(ctx.timeout(cycle, STARTUP_FETCH_DELAY_MS))
    }
    disposers.push(ctx.interval(cycle, options.fetch.intervalMinutes * 60_000))
  }

  if (options.digest.enabled) {
    let digestRunning = false

    const fire = (): void => {
      if (digestRunning) return
      digestRunning = true
      void options
        .runDailyDigest()
        .catch((error) => options.log.error('scheduled digest failed', error))
        .finally(() => {
          digestRunning = false
          armNext()
        })
    }

    // Re-anchor to the next wall-clock occurrence of the configured time.
    const armNext = (): void => {
      try {
        const { secondsUntil } = nextZonedOccurrence(options.digest.time, options.digest.timezone, new Date())
        nextTimer = ctx.timeout(fire, secondsUntil * 1000)
      } catch (error) {
        options.log.error(`digest scheduler not armed (invalid digest.time/timezone): ${String(error)}`)
      }
    }

    armNext()
  }

  return () => {
    for (const dispose of disposers) dispose()
    nextTimer?.()
  }
}