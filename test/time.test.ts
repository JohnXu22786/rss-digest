import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextZonedOccurrence, parseClockTime, zonedDayKey } from '../lib/time.js'

test('zonedDayKey maps an instant into the target zone day', () => {
  assert.equal(zonedDayKey(new Date('2026-08-17T18:30:00Z'), 'Asia/Shanghai'), '2026-08-18')
  assert.equal(zonedDayKey(new Date('2026-08-17T02:00:00Z'), 'UTC'), '2026-08-17')
})

test('parseClockTime accepts and rejects clock strings', () => {
  assert.deepEqual(parseClockTime('8:00'), { hour: 8, minute: 0 })
  assert.deepEqual(parseClockTime('23:59'), { hour: 23, minute: 59 })
  assert.equal(parseClockTime('24:00'), undefined)
  assert.equal(parseClockTime('12:60'), undefined)
  assert.equal(parseClockTime('noon'), undefined)
})

test('nextZonedOccurrence returns today when the time is still ahead', () => {
  const result = nextZonedOccurrence('08:00', 'Asia/Shanghai', new Date('2026-08-16T20:00:00Z'))
  assert.equal(result.next.toISOString(), '2026-08-17T00:00:00.000Z')
})

test('nextZonedOccurrence rolls to tomorrow once today passed', () => {
  const result = nextZonedOccurrence('08:00', 'Asia/Shanghai', new Date('2026-08-17T02:00:00Z'))
  assert.equal(result.next.toISOString(), '2026-08-18T00:00:00.000Z')
})

test('nextZonedOccurrence handles the UTC zone deterministically', () => {
  const past = nextZonedOccurrence('09:30', 'UTC', new Date('2026-08-17T12:00:00Z'))
  assert.equal(past.next.toISOString(), '2026-08-18T09:30:00.000Z')
  const ahead = nextZonedOccurrence('09:30', 'UTC', new Date('2026-08-17T08:00:00Z'))
  assert.equal(ahead.next.toISOString(), '2026-08-17T09:30:00.000Z')
})

test('nextZonedOccurrence lands on the target second, keeping only the sub-second remainder', () => {
  const near = nextZonedOccurrence('08:00', 'UTC', new Date('2026-08-17T07:59:59.500Z'))
  assert.equal(near.next.toISOString(), '2026-08-17T08:00:00.500Z')
  const withSeconds = nextZonedOccurrence('08:00', 'UTC', new Date('2026-08-17T07:59:10.250Z'))
  assert.equal(withSeconds.next.toISOString(), '2026-08-17T08:00:00.250Z')
  // Repeated re-arms (scheduler pattern) never accumulate drift.
  const first = nextZonedOccurrence('08:00', 'UTC', new Date('2026-08-17T07:00:00.000Z'))
  const second = nextZonedOccurrence('08:00', 'UTC', first.next)
  assert.equal(second.next.toISOString(), '2026-08-18T08:00:00.000Z')
})

test('nextZonedOccurrence rejects malformed clock strings', () => {
  assert.throws(() => nextZonedOccurrence('oops', 'UTC', new Date()), RangeError)
})

test("the empty timezone means host-local time, not UTC", () => {
  // On hosts whose local zone differs from UTC the '' and 'UTC' schedules
  // must differ; on UTC hosts they coincide, so only assert the difference
  // where it is meaningful.
  const localOffsetMinutes = new Date().getTimezoneOffset()
  const local = nextZonedOccurrence('08:00', '', new Date('2026-08-17T02:00:00Z'))
  const utc = nextZonedOccurrence('08:00', 'UTC', new Date('2026-08-17T02:00:00Z'))
  if (localOffsetMinutes !== 0) {
    assert.notEqual(local.next.toISOString(), utc.next.toISOString())
  }
})