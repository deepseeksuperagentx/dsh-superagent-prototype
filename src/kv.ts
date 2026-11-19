/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

/** The instance ID of the GitHub kind's default instance, whose Thread keys, read cursors and health name predate instances. */
const DEFAULT_GITHUB_INSTANCE = 'github'
/** State of one GitHub read stream: where it read from, when each kind of item was switched on, and the ETag of an unchanged list. */
interface GithubStream { since: string; started: Record<string, string>; etag?: string }
/** Default-branch CI observation: the branch, the failing checks last reported, and the revision counter of reported changes. */
interface GithubBranchCi { branch?: string; failures?: string[]; revision: number }
/** One pull request's CI checks: a fingerprint of the last observed run set and the revision counter of reported changes. */
interface GithubCi { fingerprint: string; revision: number }

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id'), supersededMasterIds: record<string[]>('superseded-master-ids') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: per-instance read positions. Each mounted instance (one configuration, such as `github` or `github-sites`)
   * reads and writes the `ByInstance` families, so two instances of one kind never read each other's cursors: the notification
   * cursor and pending retries, the per-Issue/PR read cursor shared by notification and polled reads, the per-stream cursor with
   * its start times by kind and ETag, default-branch CI, and the per-PR CI fingerprint and revision (`revision` counts reported
   * CI changes so each produces a distinct Trigger ID).
   * The unprefixed keys are those the single-instance Source wrote before instances existed; `migrateLegacyGithubCursors` copies
   * them into the default instance's keys once and keeps them.
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<GithubStream, [stream: string]>('github-stream:'),
    branchCi: record<GithubBranchCi>('github-branch-ci'),
    ci: family<GithubCi, [number: number]>('github-ci:'),
    sinceByInstance: family<string, [instance: string]>('github-since:'),
    retriesByInstance: family<Record<string, Retry>, [instance: string]>('github-retry:'),
    cursorByInstance: family<string, [instance: string, number: number]>('github-cursor:'),
    streamByInstance: family<GithubStream, [instance: string, stream: string]>('github-stream:'),
    branchCiByInstance: family<GithubBranchCi, [instance: string]>('github-branch-ci:'),
    ciByInstance: family<GithubCi, [instance: string, number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}

/** The KV reads `migrateLegacyGithubCursors` makes: typed records, typed writes (removal by `undefined`), and prefix listing. */
export interface CursorRecords {
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V | undefined): void
  keys<V>(family: Family<V, never>): Key<V>[]
}
/**
 * Copies the read positions the single-instance GitHub Source left under the legacy keys into the default instance's keys.
 * Each copy happens only while the instance's own key is still absent, so upgraded installations neither replay history nor
 * read a cursor this instance has since moved; the legacy keys stay as they were, for a rollback and for reference.
 * Another instance has no legacy position: its read starts when it is mounted, as a Source newly switched on does.
 * @param state - the GitHub Source's KV access, such as `SourceContext.state`
 * @param instance - the instance ID whose polling round is starting
 */
export function migrateLegacyGithubCursors(state: CursorRecords, instance: string): void {
  if (instance !== DEFAULT_GITHUB_INSTANCE) return
  const copy = <V>(legacy: Key<V>, current: Key<V>): void => {
    const value = state.get(legacy)
    if (value !== undefined && state.get(current) === undefined) state.set(current, value)
  }
  const list = (prefix: string): string[] => state.keys({ prefix } as Family<never, never>)
  const suffix = (prefix: string, name: string): string => name.slice(prefix.length)
  copy(KV.github.since, KV.github.sinceByInstance(instance))
  copy(KV.github.retries, KV.github.retriesByInstance(instance))
  copy(KV.github.branchCi, KV.github.branchCiByInstance(instance))
  // Legacy family names carry one part after their prefix; an instance key inserts the instance ID, so it has another colon.
  for (const name of list(KV.github.cursor.prefix)) {
    const number = suffix(KV.github.cursor.prefix, name)
    if (!/^\d+$/.test(number)) continue
    copy(name as Key<string>, KV.github.cursorByInstance(instance, Number(number)))
  }
  for (const name of list(KV.github.stream.prefix)) {
    const stream = suffix(KV.github.stream.prefix, name)
    if (stream.includes(':')) continue
    copy(name as Key<GithubStream>, KV.github.streamByInstance(instance, stream))
  }
  for (const name of list(KV.github.ci.prefix)) {
    const number = suffix(KV.github.ci.prefix, name)
    if (!/^\d+$/.test(number)) continue
    copy(name as Key<GithubCi>, KV.github.ciByInstance(instance, Number(number)))
  }
}
