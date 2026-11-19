/** Two GitHub Source instances: their Triggers, Threads, health, read positions, environments, and plugin mounting. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { key, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { instanceRepository } from '../src/app/runtime.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { apply, githubKind, pollRound, type GithubConfig } from '../src/sources/github.ts'
import { observePull, pullEndNotices } from '../src/sources/github-pull.ts'
import { pullTrigger } from '../src/sources/github-trigger.ts'
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
  const bindThread = vi.fn(), threadClosed = vi.fn()
  const deps: SourceContextDeps = { store, engine: { bindThread, threadClosed } as never,
    outbox: { send: vi.fn() } as never, commands, sources, deployment, ready: Promise.resolve(), configured, receive }
  const host = { ...deps, sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) }
  sources.register(githubKind)
  sources.attach('github', 'github'); sources.attach('github-sites', 'github')
  return { host: host as unknown as SourceHost, board, sources, commands, receive, bindThread, threadClosed, deployment, store }
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

/** A live ticket whose originating Trigger is `trigger`, as the Engine stores it after accepting one. */
const ticketOf = (id: string, trigger: Trigger, execution: string): Ticket => ({ id, title: 'Fix the margin', decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: trigger.source, id: 'alice' }, scope: '' },
  channels: trigger.channel ? [trigger.channel] : [], assignments: [{ id: 'a1', state: 'running', createdAt: '' }], inputs: [], undelivered: [],
  execution: { name: execution, directory: `/w/${execution}`, assignment: '' }, origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
  createdAt: '', updatedAt: '' })

/** The Executor tools' host: the real store, the registry's own instance lookup, and a stand-in engine recording each report. */
const executorHostOf = (h: ReturnType<typeof hostOf>): ExecutorToolsHost => ({
  engine: { report: vi.fn((id: string) => h.store.tickets.get(id)!), reply: vi.fn(), markUnrelated: vi.fn(), handback: vi.fn(), followForContext: vi.fn() },
  store: h.store,
  sessions: { relay: vi.fn(), notify: vi.fn() },
  resources: {} as never,
  github: h.host.context({ kind: 'github', health: ['github'] }),
  sourceInstance: (id: string) => { const instance = h.sources.instance(id); return instance ? { kind: instance.kind, config: instance.config } : undefined },
  sendReplies: vi.fn(async () => {}),
} as unknown as ExecutorToolsHost)

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
  // The default instance's repository is the deployment's, which setup canonicalized from its configuration: a stale stored
  // name (a former repository name, or one with different case) does not reach the worker's environment.
  expect(values({ deployment: { ...deployment, repository: 'acme/canonical' }, config: labConfig, instance: 'github',
    trigger: { ...sitesTrigger, source: 'github', threads: [{ source: 'github', id: '12' }] } }))
    .toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/canonical', DSH_SUPERAGENT_GITHUB_NUMBER: '12' })
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

it('finds a Thread by the instance whose repository a URL names, while the default instance is not crossed to the second', () => {
  const h = hostOf()
  // A URL resolves to the instance watching that repository: the second instance's Thread is searchable, the default one is not returned for it.
  expect(h.sources.find(`https://github.com/${SITES}/pull/12`)).toEqual({ threads: ['github-sites:12'], terms: [] })
  expect(h.sources.find(`https://github.com/${LAB}/issues/7`)).toEqual({ threads: ['github:7'], terms: [] })
  // A bare number is ambiguous across repositories, so each instance answers with its own Thread.
  expect(h.sources.find('#12')).toEqual({ threads: ['github:12', 'github-sites:12'], terms: [] })
  // A repository no instance watches names nothing rather than the default instance's Thread.
  expect(h.sources.find('https://github.com/acme/other/pull/3')).toEqual({ threads: [], terms: [] })
})

it('reads and claims a second instance\'s PR in its own repository, while the default instance keeps the deployment repository', async () => {
  const h = hostOf()
  const sitesTrigger = pullTrigger({ number: 12, title: 'Fix the margin', body: '@agent-bot fix', user: { login: 'alice', type: 'User' },
    created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/${SITES}/pull/12` }, 'agent-bot', 'github-sites')
  const labTrigger = pullTrigger({ number: 9, title: 'Fix the title', body: '@agent-bot fix', user: { login: 'alice', type: 'User' },
    created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/${LAB}/pull/9` }, 'agent-bot')
  h.store.triggers.save(sitesTrigger); h.store.triggers.save(labTrigger)
  h.store.tickets.save(ticketOf('site-ticket', sitesTrigger, 'fix-12'))
  h.store.tickets.save(ticketOf('lab-ticket', labTrigger, 'fix-9'))
  const pull = (repository: string, number: number) => JSON.stringify({ state: 'open', html_url: `https://github.com/${repository}/pull/${number}`,
    user: { login: 'agent-bot' }, head: { sha: 'abc', ref: `agent/fix-${number}`, repo: { full_name: repository } } })
  const read: string[] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const path = args[1] ?? ''
    read.push(path)
    return /\/pulls\/12$/.test(path) ? pull(SITES, 12) : pull(LAB, 9)
  })
  const host = executorHostOf(h)
  const report = async (ticketId: string, number: number) => {
    const ticket = h.store.tickets.get(ticketId)!
    const tool = executorTools(host, ticket).find(item => item.name === 'orchestrator_report')!
    return tool.execute({ state: 'progress', summary: 'PR opened', pr_number: number }, new AbortController().signal)
  }
  // The second instance's PR is read from its own repository and bound to its own Thread.
  await report('site-ticket', 12)
  expect(read).toContain(`repos/${SITES}/pulls/12`)
  expect(read).not.toContain(`repos/${LAB}/pulls/12`)
  expect(h.bindThread).toHaveBeenCalledWith('site-ticket', { source: 'github-sites', id: '12' }, true)
  // A Ticket of the default instance keeps reading and binding the deployment repository exactly as before.
  await report('lab-ticket', 9)
  expect(read).toContain(`repos/${LAB}/pulls/9`)
  expect(h.bindThread).toHaveBeenCalledWith('lab-ticket', { source: 'github', id: '9' }, true)
})

it('links a PR end notice to its own instance\'s repository, the default instance keeping the deployment repository', () => {
  const h = hostOf()
  const ended = (thread: string): Ticket => ({ id: 'ended', title: 'Fix the margin', decisionId: 'd-ended',
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }],
    assignments: [], inputs: [], undelivered: [], follows: [{ thread, own: true, closed: { at: '2026-09-09T00:00:00Z', outcome: 'merged' } }],
    ended: { at: '2026-09-09T00:00:00Z', by: 'executor', outcome: 'merged' }, origin: { triggerId: 'x', triggerIds: [] }, createdAt: '', updatedAt: '' })
  const linkOf = (thread: string) => pullEndNotices(ended(thread), '修一下', source => instanceRepository(h.sources, h.deployment, source))[0]!.text
  expect(linkOf('github-sites:12')).toContain(`https://github.com/${SITES}/pull/12`)
  // The default instance and a Source of another kind keep the deployment repository, even when the stored configuration
  // still names a former name or different case (the deployment is the canonical one setup resolved).
  expect(linkOf('github:12')).toContain(`https://github.com/${LAB}/pull/12`)
  expect(instanceRepository(h.sources, h.deployment, 'feishu')).toBe(LAB)
  expect(instanceRepository(h.sources, { ...h.deployment, repository: 'acme/canonical' }, 'github')).toBe('acme/canonical')
})

it('reads a second instance\'s Thread context in its own repository, while the default instance keeps the caller\'s repository', async () => {
  const h = hostOf()
  const triggerOf = (source: string) => pullTrigger({ number: 12, title: 'Fix the margin', body: '@agent-bot fix',
    user: { login: 'alice', type: 'User' }, created_at: '2026-09-09T00:00:00Z',
    html_url: `https://github.com/${source === 'github' ? LAB : SITES}/pull/12` }, 'agent-bot', source)
  const read: string[] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const path = args[1] ?? ''
    read.push(path)
    return /\/issues\/12$/.test(path) ? JSON.stringify({ id: 1200, number: 12, title: 'Fix the margin', state: 'open',
      created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/${SITES}/pull/12`, user: { login: 'alice' } }) : JSON.stringify([])
  })
  // The assessment's commands address the default deployment; the registry scopes them to the Trigger's instance.
  const commands = new Commands(() => h.deployment, {}, new AbortController().signal)
  await h.sources.threadContext(triggerOf('github-sites'))!.read(commands, 'thread', undefined)
  expect(read).toContain(`repos/${SITES}/issues/12`)
  expect(read.some(path => path.startsWith(`repos/${LAB}/`))).toBe(false)
  // The default instance keeps the caller's commands, so single-instance reads are unchanged.
  read.length = 0
  await h.sources.threadContext(triggerOf('github'))!.read(commands, 'thread', undefined)
  expect(read).toContain(`repos/${LAB}/issues/12`)
})

it('reports a PR close only to the Tickets following that instance\'s Thread, not another instance\'s same number', async () => {
  const h = hostOf()
  const request = pullTrigger({ number: 12, title: 'Fix the margin', body: '@agent-bot fix', user: { login: 'alice', type: 'User' },
    created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/${SITES}/pull/12` }, 'agent-bot', 'github-sites')
  h.store.triggers.save(request)
  h.store.tickets.save({ ...ticketOf('lab-ticket', request, 'fix-12'), follows: [{ thread: 'github:12', own: true }] })
  const pr = { number: 12, title: 'Fix the margin', state: 'closed', merged: true, merged_at: '2026-09-09T00:00:00Z',
    html_url: `https://github.com/${SITES}/pull/12`, user: { login: 'carol' }, head: { sha: 'abc', ref: 'fix', repo: { full_name: SITES } } }
  const context = h.host.context({ kind: 'github', health: ['github'] })
  await observePull(context, pr, 'github-sites')
  // The lab Ticket follows github:12, not github-sites:12: the second instance's same-number PR does not reach it.
  expect(h.threadClosed).not.toHaveBeenCalled()
  // A Ticket following the second instance's own Thread hears about its close.
  h.store.tickets.save({ ...ticketOf('site-ticket', request, 'fix-12'), follows: [{ thread: 'github-sites:12', own: true }] })
  await observePull(context, pr, 'github-sites')
  expect(h.threadClosed).toHaveBeenCalledWith({ source: 'github-sites', id: '12' }, 'merged', '2026-09-09T00:00:00Z')
})
