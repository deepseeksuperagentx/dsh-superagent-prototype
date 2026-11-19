/** Two GitHub Source instances: their Triggers, Threads, health, read positions, environments, and plugin mounting. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { apply, githubKind, pollRound, type GithubConfig } from '../src/sources/github.ts'
import { setupChanged } from '../src/app/setup.ts'
import { sourceContext, type SourceHost } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const LAB = 'acme/lab'
const SITES = 'acme/sites'
let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'github-instance-'))
  store = new Store(join(directory, 'db.sqlite'))
})
afterEach(() => {
  vi.restoreAllMocks()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

/** Settings with the default instance (`github`, watching the lab) and a second instance (`github-sites`, watching the site sources). */
const settingsOf = () => SettingsSchema.parse({
  sources: {
    github: { enabled: true, config: { repository: LAB, cli: 'gh' } },
    'github-sites': { kind: 'github', enabled: true, config: { repository: SITES, cli: 'gh' } },
  },
  policy: { sources: { github: { allowed: [{ id: 'alice' }] }, 'github-sites': { allowed: [{ id: 'alice' }] } } },
})

/** A runtime-like host wrapping a real store and registry, with stand-in commands and an Engine receiving nothing. */
function hostOf(configured: () => boolean = () => true) {
  store.saveSettings(settingsOf())
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment({ repository: LAB })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  // A stand-in Engine: it records the Trigger's Threads as the real one does when it stores a Trigger.
  const receive = vi.fn(async (trigger: Trigger) => {
    for (const ref of trigger.threads) {
      const thread = `${ref.source}:${ref.id}`
      if (!store.threads.get(thread)) store.threads.save({ key: thread, ref, createdAt: trigger.at, subscriptions: [], correlated: [], pending: [], meta: {} })
    }
    return 'stored' as const
  })
  const deps: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() } as never,
    outbox: { send: vi.fn() } as never, commands, sources, deployment, ready: Promise.resolve(), configured, receive }
  const host = { ...deps, sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) }
  sources.register(githubKind)
  sources.attach('github', 'github'); sources.attach('github-sites', 'github')
  return { host: host as unknown as SourceHost, board, sources, commands, receive }
}

/** An Issue of `repository` as GitHub returns it, opened by alice with a mention of the agent. */
const issue = (repository: string, number: number) => ({ id: 1000 + number, number, title: 'Login fails', body: '@agent-bot please fix',
  state: 'open', created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/${repository}/issues/${number}`,
  user: { login: 'alice', type: 'User' } })
/** One notification per poll, in the repository each instance's commands address. */
const stubReads = () => vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
  const path = args[1] ?? ''
  const repository = path.includes(`repos/${SITES}/`) ? SITES : LAB
  if (path.includes('/notifications')) {
    const notification = { id: `n-${repository}`, updated_at: '2026-09-09T00:00:00Z', reason: 'mention',
      repository: { full_name: repository },
      subject: { url: `https://api.github.com/repos/${repository}/issues/12`, type: 'Issue', title: 'Login fails' } }
    return `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`
  }
  if (/\/issues\/12\/comments/.test(path)) return JSON.stringify([])
  if (/\/issues\/12$/.test(path)) return JSON.stringify(issue(repository, 12))
  return JSON.stringify([])
})

it('polls two instances apart: each Trigger, Thread, actor and channel names its own instance, with each instance\'s own read position and health', async () => {
  const h = hostOf()
  // Each instance has been observing for a day, so the Issue opened since its cursor brings its body.
  store.set('github-since:github', '2026-09-08T00:00:00.000Z')
  store.set('github-since:github-sites', '2026-09-08T00:00:00.000Z')
  stubReads()
  await pollRound(sourceContext(h.host, githubKind, 'github'), undefined, 'github')
  await pollRound(sourceContext(h.host, githubKind, 'github-sites'), undefined, 'github-sites')
  const [lab, sites] = h.receive.mock.calls.map(([trigger]) => trigger as Trigger)
  // The same Issue number in two repositories makes two Triggers, one per instance; the default instance keeps the old IDs.
  expect(lab).toMatchObject({ id: key('github-issue', '12'), source: 'github', threads: [{ source: 'github', id: '12' }],
    actor: { source: 'github', id: 'alice' }, channel: { source: 'github', thread: 'github:12', address: { number: '12' } } })
  expect(sites).toMatchObject({ id: key('github-issue', 'github-sites', '12'), source: 'github-sites',
    threads: [{ source: 'github-sites', id: '12' }], actor: { source: 'github-sites', id: 'alice' },
    channel: { source: 'github-sites', thread: 'github-sites:12', address: { number: '12', repository: SITES } } })
  expect(h.receive.mock.calls.map(([trigger]) => trigger.source)).toEqual(['github', 'github-sites'])
  expect(h.sources.kind('github')).toBe(githubKind)
  expect(h.sources.kind('github-sites')).toBe(githubKind)
  // Each instance names its own Thread: the same number in two repositories stays apart.
  expect(h.sources.instances().map(instance => instance.id)).toEqual(['github', 'github-sites'])
  expect(store.threads.get('github:12')?.ref).toEqual({ source: 'github', id: '12' })
  expect(store.threads.get('github-sites:12')?.ref).toEqual({ source: 'github-sites', id: '12' })
  // Two health entries: the default instance keeps the kind's `github`, the second claims its own ID.
  expect(h.board.all.github).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s' })
  expect(h.board.all['github-sites']).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s' })
  expect(Object.keys(h.board.all).sort()).toEqual(['github', 'github-sites'])
  // Read positions are per instance and the legacy single-instance keys stay untouched.
  expect(store.get('github-since')).toBeUndefined()
  expect(store.get('github-since:github')).toEqual(expect.any(String))
  expect(store.get('github-since:github-sites')).toEqual(expect.any(String))
  expect(store.get('github-cursor:github:12')).toEqual(expect.any(String))
  expect(store.get('github-cursor:github-sites:12')).toEqual(expect.any(String))
})

it('copies the single-instance read position into the default instance when its first round starts, and keeps the legacy key', async () => {
  const h = hostOf()
  store.set('github-since', '2026-09-08T00:00:00.000Z')
  stubReads()
  await pollRound(sourceContext(h.host, githubKind, 'github'), undefined, 'github')
  // The round read from the legacy cursor, then advanced the default instance's own copy.
  expect(h.receive).toHaveBeenCalledTimes(1)
  expect(store.get('github-since')).toBe('2026-09-08T00:00:00.000Z')
  expect(Date.parse(String(store.get('github-since:github')))).toBeGreaterThan(Date.parse('2026-09-08T00:00:00.000Z'))
  // The second instance has no legacy position: it starts reading when it is switched on.
  expect(store.get('github-since:github-sites')).toBeUndefined()
})

it('gives each instance an environment naming that instance\'s repository, and the Ticket\'s number only for its own Trigger', () => {
  const deployment = testDeployment({ repository: LAB })
  const values = githubKind.environment!.values
  const sitesConfig = githubKind.schema.parse({ repository: SITES, cli: '/bin/gh' }) as GithubConfig
  const labConfig = githubKind.schema.parse({ repository: LAB, cli: '/bin/gh' }) as GithubConfig
  const sitesTrigger = { id: 'ticket', source: 'github-sites', threads: [{ source: 'github-sites', id: '12' }],
    actor: { source: 'github-sites', id: 'alice' }, human: true, at: '', text: '', meta: { number: 12, isPr: true } } as Trigger
  expect(values({ deployment, config: sitesConfig, trigger: sitesTrigger, instance: 'github-sites' }))
    .toEqual({ DSH_SUPERAGENT_GITHUB_REPOSITORY: SITES, DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-bot',
      DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: '7+agent-bot@users.noreply.github.com', DSH_SUPERAGENT_GITHUB_NUMBER: '12',
      DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/12/head' })
  // The default instance's Trigger fills its own environment, and its repository comes from its configuration as well.
  expect(values({ deployment, config: labConfig, instance: 'github',
    trigger: { ...sitesTrigger, source: 'github', threads: [{ source: 'github', id: '12' }] } }))
    .toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: LAB, DSH_SUPERAGENT_GITHUB_NUMBER: '12' })
  // A message of another Source leaves the GitHub number empty.
  expect(values({ deployment, config: labConfig, instance: 'github',
    trigger: { ...sitesTrigger, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1' }] } }).DSH_SUPERAGENT_GITHUB_NUMBER).toBe('')
})

it('reads setup fields per instance of a kind, so a second GitHub instance takes part in setup and its account check', () => {
  const single = SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: LAB, cli: 'gh' } } } })
  expect(setupChanged(single, single)).toBe(false)
  // A second instance of the kind is setup-read: its repository and CLI are checked, and adding it re-runs setup.
  const sites = SettingsSchema.parse({ ...single, sources: { ...single.sources, 'github-sites': { kind: 'github', enabled: true, config: { repository: SITES, cli: 'gh' } } } })
  expect(setupChanged(single, sites)).toBe(true)
  // Unchanged configuration of the same instances changes nothing, and a polling setting is not setup-read.
  expect(setupChanged(sites, SettingsSchema.parse({ ...sites, sources: { ...sites.sources, 'github-sites': { ...sites.sources['github-sites']!, config: { ...sites.sources['github-sites']!.config, pollSeconds: 120 } } } }))).toBe(false)
  // A changed repository or CLI of either instance re-runs setup and restarts.
  expect(setupChanged(sites, SettingsSchema.parse({ ...sites, sources: { ...sites.sources, github: { enabled: true, config: { repository: 'acme/other', cli: 'gh' } } } }))).toBe(true)
  expect(setupChanged(sites, SettingsSchema.parse({ ...sites, sources: { ...sites.sources, 'github-sites': { kind: 'github', enabled: true, config: { repository: SITES, cli: '/opt/bin/gh' } } } }))).toBe(true)
  // A kind with no stored instance reads its default instance's defaults: enabling Feishu without a CLI changes nothing in setup.
  expect(setupChanged(single, SettingsSchema.parse({ ...single, sources: { ...single.sources, feishu: { enabled: true, config: { cli: '' } } } }))).toBe(false)
})

it('mounts a second instance although its kind is already registered, claims its own health entry, and releases both on disposal', async () => {
  store.saveSettings(settingsOf())
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment({ repository: LAB })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const deps: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() } as never,
    outbox: { send: vi.fn() } as never, commands, sources, deployment, ready: Promise.resolve(), configured: () => false,
    receive: vi.fn(async (_trigger: Trigger) => 'stored' as const) }
  const host = { ...deps, sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) } as unknown as SourceHost
  const disposers: (() => unknown)[] = []
  const mount = (config?: { instanceId?: string }) => apply({ orchestrator: host,
    effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never, config)
  mount({ instanceId: 'github' })
  expect(sources.kind('github')).toBe(githubKind)
  expect(sources.instanceKindName('github')).toBe('github')
  // A second entry of the plugin finds its kind registered; that must not fail the mount, and its instance still attaches.
  expect(() => mount({ instanceId: 'github-sites' })).not.toThrow()
  expect(sources.instanceKindName('github-sites')).toBe('github')
  // Each instance reports on its own entry, both waiting for setup.
  await vi.waitFor(() => expect(board.all['github-sites']).toMatchObject({ state: 'paused', code: 'setupPending' }))
  expect(board.all.github).toMatchObject({ state: 'paused', code: 'setupPending' })
  // Disposal aborts the loops, unmounts both instances, and releases the entries the kind and the second instance claimed.
  for (const dispose of disposers) await dispose()
  expect(sources.kind('github')).toBeUndefined()
  expect(sources.instanceKindName('github-sites')).toBeUndefined()
  expect(board.all).toEqual({})
})
