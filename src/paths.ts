/**
 * Data path resolution shared by the dsh plugin and the CLI.
 *
 * Precedence:
 *  1. explicit value (config.dataPath / --db)
 *  2. DSH_RSS_DIGEST_DATA
 *  3. $DSH_HOME/data/rss-digest/store.json when DSH_HOME is set
 *  4. <cwd>/.dsh-rss-digest/store.json
 */

import { join } from 'node:path'

export function resolveDataPath(explicit: string): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const direct = process.env.DSH_RSS_DIGEST_DATA
  if (direct !== undefined && direct !== '') return direct
  const home = process.env.DSH_HOME
  return home !== undefined && home !== ''
    ? join(home, 'data', 'rss-digest', 'store.json')
    : join(process.cwd(), '.dsh-rss-digest', 'store.json')
}