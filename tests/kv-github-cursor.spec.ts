/** Per-instance GitHub read positions: their key names, and the one-time copy of the single-instance cursors. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV, migrateLegacyGithubCursors, type CursorRecords, type Family, type Key } from '../src/kv.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kv-github-'))
  store = new Store(join(directory, 'db.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

/** The Source's KV access, as `SourceContext.state` gives it: removing by `undefined` and listing a family by prefix. */
const records = (): CursorRecords => ({
  get: <V>(key: Key<V>) => store.get(key),
  set: <V>(key: Key<V>, value: V | undefined) => { if (value === undefined) store.delete(key); else store.set(key, value) },
  keys: <V>(family: Family<V, never>) => store.keys(family),
})

it('spells each instance\'s read positions with its instance ID, beside the legacy single-instance keys', () => {
  const instance = 'github-sites'
  expect(KV.github.sinceByInstance(instance)).toBe('github-since:github-sites')
  expect(KV.github.retriesByInstance(instance)).toBe('github-retry:github-sites')
  expect(KV.github.cursorByInstance(instance, 12)).toBe('github-cursor:github-sites:12')
  expect(KV.github.streamByInstance(instance, 'issues')).toBe('github-stream:github-sites:issues')
  expect(KV.github.branchCiByInstance(instance)).toBe('github-branch-ci:github-sites')
  expect(KV.github.ciByInstance(instance, 9)).toBe('github-ci:github-sites:9')
  // The default instance keeps the kind's name, and its keys are still distinct from the legacy ones the pre-instance Source wrote.
  expect(KV.github.sinceByInstance('github')).toBe('github-since:github')
  expect(KV.github.cursorByInstance('github', 12)).toBe('github-cursor:github:12')
  expect(KV.github.since).toBe('github-since')
  expect(KV.github.cursor(12)).toBe('github-cursor:12')
  // The one-time migration marker is per instance as well.
  expect(KV.github.migrated(instance)).toBe('github-migrated:github-sites')
})

it('copies every legacy read position into the default instance\'s keys once, leaving the legacy keys as they were', () => {
  store.set(KV.github.since, '2026-09-08T00:00:00.000Z')
  store.set(KV.github.retries, { 12: { since: '2026-09-07T00:00:00.000Z', pr: false, attempts: 1 } })
  store.set(KV.github.branchCi, { branch: 'main', failures: ['lint'], revision: 3 })
  store.set(KV.github.cursor(12), '2026-09-06T00:00:00.000Z')
  store.set(KV.github.stream('issues'), { since: '2026-09-05T00:00:00.000Z', started: { issues: '2026-09-05T00:00:00.000Z' }, etag: '"same"' })
  store.set(KV.github.ci(9), { fingerprint: 'fp', revision: 2 })
  migrateLegacyGithubCursors(records(), 'github')
  expect(store.get(KV.github.sinceByInstance('github'))).toBe('2026-09-08T00:00:00.000Z')
  expect(store.get(KV.github.retriesByInstance('github'))).toEqual({ 12: { since: '2026-09-07T00:00:00.000Z', pr: false, attempts: 1 } })
  expect(store.get(KV.github.branchCiByInstance('github'))).toEqual({ branch: 'main', failures: ['lint'], revision: 3 })
  expect(store.get(KV.github.cursorByInstance('github', 12))).toBe('2026-09-06T00:00:00.000Z')
  expect(store.get(KV.github.streamByInstance('github', 'issues'))
    ?.since).toBe('2026-09-05T00:00:00.000Z')
  expect(store.get(KV.github.streamByInstance('github', 'issues'))?.etag).toBe('"same"')
  expect(store.get(KV.github.ciByInstance('github', 9))).toEqual({ fingerprint: 'fp', revision: 2 })
  // The upgrade keeps the old records: a rollback reads them, and the migration never deletes what it copied.
  expect(store.get(KV.github.since)).toBe('2026-09-08T00:00:00.000Z')
  expect(store.get(KV.github.cursor(12))).toBe('2026-09-06T00:00:00.000Z')
  expect(store.get(KV.github.stream('issues'))?.etag).toBe('"same"')
  expect(store.get(KV.github.branchCi)).toEqual({ branch: 'main', failures: ['lint'], revision: 3 })
})

it('copies nothing over a read position the instance has already moved, and never mistakes an instance key for a legacy one', () => {
  store.set(KV.github.since, '2026-09-10T00:00:00.000Z')
  store.set(KV.github.sinceByInstance('github'), '2026-09-09T00:00:00.000Z')
  store.set(KV.github.cursorByInstance('github', 12), '2026-09-09T00:00:00.000Z')
  migrateLegacyGithubCursors(records(), 'github')
  // The instance's own position wins, so an upgraded installation does not replay a round it already read.
  expect(store.get(KV.github.sinceByInstance('github'))).toBe('2026-09-09T00:00:00.000Z')
  // The instance cursor has two name parts after its prefix, so it is not read as a legacy `github-cursor:<number>` key.
  expect(store.get(KV.github.cursorByInstance('github', 12))).toBe('2026-09-09T00:00:00.000Z')
  expect(store.get(KV.github.cursor(12))).toBeUndefined()
  // A second run of the same migration changes nothing.
  migrateLegacyGithubCursors(records(), 'github')
  expect(store.get(KV.github.sinceByInstance('github'))).toBe('2026-09-09T00:00:00.000Z')
})

it('migrates once: a stream cursor deleted when its observation is switched off is not seeded from the legacy key again', () => {
  store.set(KV.github.stream('issues'), { since: '2026-09-05T00:00:00.000Z', started: { issues: '2026-09-05T00:00:00.000Z' } })
  migrateLegacyGithubCursors(records(), 'github')
  expect(store.get(KV.github.migrated('github'))).toBe(1)
  expect(store.get(KV.github.streamByInstance('github', 'issues'))?.since).toBe('2026-09-05T00:00:00.000Z')
  // Switching the observation off deletes the instance's stream cursor (as `pollRepository` does), and the legacy key stays.
  records().set(KV.github.streamByInstance('github', 'issues'), undefined)
  migrateLegacyGithubCursors(records(), 'github')
  // The marker keeps the old baseline from coming back, so switching it on again starts from the switch-on time instead of
  // scanning (and re-triggering) the upgraded installation's 14-day horizon.
  expect(store.get(KV.github.streamByInstance('github', 'issues'))).toBeUndefined()
  expect(store.get(KV.github.migrated('github'))).toBe(1)
})

it('leaves the legacy positions to the default instance, so another instance starts reading from when it is mounted', () => {
  store.set(KV.github.since, '2026-09-08T00:00:00.000Z')
  store.set(KV.github.cursor(12), '2026-09-06T00:00:00.000Z')
  store.set(KV.github.stream('issues'), { since: '2026-09-05T00:00:00.000Z', started: { issues: '2026-09-05T00:00:00.000Z' } })
  migrateLegacyGithubCursors(records(), 'github-sites')
  expect(store.get(KV.github.sinceByInstance('github-sites'))).toBeUndefined()
  expect(store.get(KV.github.cursorByInstance('github-sites', 12))).toBeUndefined()
  expect(store.get(KV.github.streamByInstance('github-sites', 'issues'))).toBeUndefined()
  // The single-instance Source's records stay untouched for the default instance's own migration.
  expect(store.get(KV.github.since)).toBe('2026-09-08T00:00:00.000Z')
  expect(store.get(KV.github.cursor(12))).toBe('2026-09-06T00:00:00.000Z')
})
