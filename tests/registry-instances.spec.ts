import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SettingsSchema, SourceInstanceSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'

/** A kind that reads `interval` from its own instance configuration, so tests can tell one instance's config from another's. */
const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: ['probe'],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
  scope: (_input, config) => ({ listened: true, observed: config.interval > 5 }),
  channel: {
    allowed: (address, config) => address.interval === String(config.interval),
    send: async (_host, message) => { sent.push(message.id); return 'sent' },
    link: (address, _links) => ({ url: `https://probe/${address.room}`, label: { zh: '探针', en: 'Probe' } }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.id),
    read: async (_commands, trigger, part, cursor, config) => ({
      messages: [{ id: 'm1', from: 'u', at: '1', text: '' }], body: { trigger: trigger.id, part, cursor: cursor ?? 'first', interval: config.interval },
    }),
  },
  find: () => ({ threads: ['probe:1'], terms: ['probe-term'] }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的账号', en: 'Accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
    explicit: { zh: '', en: '' },
  },
  environment: {
    variables: [{ key: 'PROBE_INTERVAL', description: { zh: '间隔', en: 'Interval' } }],
    values: ({ config }) => ({ PROBE_INTERVAL: String(config.interval) }),
  },
}
/** Another kind, mounted as its own default instance only, to show attach is about instances rather than a second kind. */
const lane: SourceKind<Record<string, never>> = {
  kind: 'lane', title: { zh: '车道', en: 'Lane' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({}).strict(), fields: [],
}
let sent: string[] = []
const trigger = (source: string) => ({ id: `t-${source}`, source, threads: [{ source, id: '1' }], actor: { source, id: 'alice' },
  human: true, at: '', text: 'hi', meta: { id: 'm1' }, channel: { source, thread: `${source}:1`, address: { room: 'r', interval: '5' } } })
const message = (source: string): OutboundMessage => ({ id: `out-${source}`, channel: { source, thread: `${source}:1`, address: { room: 'r' } },
  text: 'hi', kind: 'reply' })
const commands = {} as Commands

/** Settings holding an explicitly configured second instance (`probe-a`, kind `probe`) and an uninstalled instance (`retired`). */
const settings = (extra: Record<string, unknown> = {}) => SettingsSchema.parse({
  sources: {
    'probe-a': { kind: 'probe', enabled: true, config: { interval: 9 } },
    ...extra,
  },
})

describe('Source registry instances', () => {
  it('mounts a second instance of one registered kind and lists it with its stored config beside the kind\'s default instance', () => {
    const registry = new SourceRegistry(() => settings({ retired: { enabled: true, config: { x: 1 } } }))
    registry.register(probe); registry.register(lane)
    registry.attach('probe-a', 'probe')
    // The default instance keeps the kind ID and its schema defaults; the attached one takes `settings.sources[id]`.
    expect(registry.instances()).toEqual([
      { id: 'lane', kind: 'lane', enabled: true, config: {}, installed: true },
      { id: 'probe', kind: 'probe', enabled: true, config: { interval: 5 }, installed: true },
      { id: 'probe-a', kind: 'probe', enabled: true, config: { interval: 9 }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
    ])
    expect(registry.instance('probe-a')).toEqual({ id: 'probe-a', kind: 'probe', enabled: true, config: { interval: 9 } })
    expect(registry.instance('retired')).toBeUndefined()
  })
  it('keeps a stored instance whose kind is not installed uninstalled, and disables an attached instance whose stored config fails its kind schema', () => {
    const registry = new SourceRegistry(() => settings({ 'probe-a': { kind: 'probe', enabled: true, config: { interval: 0 } } }))
    registry.register(probe)
    registry.attach('probe-a', 'probe')
    expect(registry.instances().find(instance => instance.id === 'probe-a'))
      .toEqual({ id: 'probe-a', kind: 'probe', enabled: false, config: { interval: 5 }, installed: true })
    // A configured ID whose kind is missing stays listed with its stored config, whatever `kind` it names.
    const stored = new SourceRegistry(() => SettingsSchema.parse({ sources: { future: { kind: 'github', config: { repository: 'a/b' } } } }))
    expect(stored.instances()).toEqual([{ id: 'future', kind: 'github', enabled: true, config: { repository: 'a/b' }, installed: false }])
  })
  it('attaches only to a registered kind, refuses a second attach of the same ID, and allows the default instance (an ID equal to its kind name)', () => {
    const registry = new SourceRegistry(() => SettingsSchema.parse({}))
    expect(() => registry.attach('github', 'github')).toThrow('Source kind not installed: github')
    registry.register(probe)
    expect(() => registry.attach('probe-a', 'missing')).toThrow('Source kind not installed: missing')
    registry.attach('probe-a', 'probe')
    expect(() => registry.attach('probe-a', 'probe')).toThrow('Source instance already attached: probe-a')
    // The default instance is an instance whose ID is its kind's name; attach accepts it like any other.
    expect(() => registry.attach('probe', 'probe')).not.toThrow()
    expect(registry.instanceKindName('probe')).toBe('probe')
    expect(registry.instanceKindName('probe-a')).toBe('probe')
    expect(registry.instanceKindName('missing')).toBeUndefined()
  })
  it('unmounts an instance with the attach disposer, after which its stored configuration is uninstalled again', () => {
    const registry = new SourceRegistry(() => settings())
    registry.register(probe); registry.register(lane)
    const detach = registry.attach('probe-a', 'probe')
    expect(registry.instance('probe-a')).toBeDefined()
    detach()
    expect(registry.instanceKindName('probe-a')).toBeUndefined()
    expect(registry.instance('probe-a')).toBeUndefined()
    expect(registry.instances().find(instance => instance.id === 'probe-a')).toEqual({ id: 'probe-a', kind: 'probe', enabled: true, config: { interval: 9 }, installed: false })
    // Disposing twice is harmless, and re-attaching the same ID works again.
    detach()
    registry.attach('probe-a', 'probe')
    expect(registry.instance('probe-a')).toEqual({ id: 'probe-a', kind: 'probe', enabled: true, config: { interval: 9 } })
  })
  it('resolves every Trigger, Channel, Thread and Scope of an instance ID through the kind that runs it, with that instance\'s config', async () => {
    const registry = new SourceRegistry(() => settings())
    registry.register(probe); registry.register(lane)
    registry.attach('probe-a', 'probe')
    expect(registry.kind('probe')).toBe(probe)
    expect(registry.kind('probe-a')).toBe(probe)
    expect(registry.kind('watch-only')).toBeUndefined()
    sent = []
    expect(await registry.send(message('probe-a'), commands)).toBe('sent')
    expect(sent).toEqual(['out-probe-a'])
    expect(await registry.send(message('uninstalled'), commands)).toBe('waiting')
    expect(registry.link(message('probe-a').channel, {})).toEqual({ url: 'https://probe/r', label: { zh: '探针', en: 'Probe' } })
    // Channel allowance reads the instance configuration: the default instance's interval 5 does not allow room interval 9.
    expect(registry.channelAllowed({ source: 'probe-a', address: { room: 'r', interval: '9' } })).toBe(true)
    expect(registry.channelAllowed({ source: 'probe', address: { room: 'r', interval: '9' } })).toBe(false)
    // Scope and thread context likewise see the instance's own configuration.
    expect(registry.scope({ source: 'probe-a', meta: {} })).toEqual({ listened: true, observed: true })
    expect(registry.scope({ source: 'probe', meta: {} })).toEqual({ listened: true, observed: false })
    expect(registry.scope({ source: 'unknown', meta: {} })).toEqual({ listened: true, observed: false })
    expect(await registry.threadContext(trigger('probe-a'))!.read(commands, 'thread', undefined)).toMatchObject({ body: { interval: 9 } })
    expect(await registry.threadContext(trigger('probe'))!.read(commands, 'thread', undefined)).toMatchObject({ body: { interval: 5 } })
    // Search covers each kind mounted under any instance, once per kind.
    expect(registry.find('anything')).toEqual({ threads: ['probe:1'], terms: ['probe-term'] })
  })
  it('validates a submitted instance with its kind\'s schema and refuses unknown IDs', () => {
    const registry = new SourceRegistry(() => settings())
    registry.register(probe)
    registry.attach('probe-a', 'probe')
    expect(registry.validate('probe-a', { enabled: true, config: {} })).toEqual({ enabled: true, config: { interval: 5 } })
    expect(registry.validate('probe-a', { enabled: true, config: { interval: 9 } })).toEqual({ enabled: true, config: { interval: 9 } })
    expect(() => registry.validate('probe-a', { enabled: true, config: { interval: 0 } })).toThrow()
    // An ID whose kind is not installed is refused, whatever `settings.sources` stores for it.
    expect(() => registry.validate('retired', { enabled: true, config: {} })).toThrow('Source kind not installed: retired')
  })
  it('validates each instance\'s Policy part with the kind that runs it, and keeps parts of uninstalled instances as stored', () => {
    const registry = new SourceRegistry(() => SettingsSchema.parse({ policy: { sources: { 'probe-a': { allowed: [{ id: 'alice' }] } } } }))
    registry.register(probe)
    registry.attach('probe-a', 'probe')
    expect(registry.validatePolicy({ 'probe-a': { allowed: [{ id: 'alice' }] }, retired: { allowed: [], x: 1 } }))
      .toEqual({ 'probe-a': { allowed: [{ id: 'alice' }], admission: {} }, retired: { allowed: [], x: 1 } })
    expect(() => registry.validatePolicy({ 'probe-a': { allowed: [{ id: 'not a name' }] } })).toThrow()
    expect(registry.policyPart('probe-a')).toEqual({ allowed: [{ id: 'alice' }], admission: {} })
    expect(registry.policyPart('retired')).toBeUndefined()
  })
  it('declares environment variables per instance, with the instance ID as owner, and returns one environment per enabled instance', () => {
    const registry = new SourceRegistry(() => settings({ 'probe-b': { kind: 'probe', enabled: false, config: { interval: 7 } } }))
    registry.register(probe); registry.register(lane)
    registry.attach('probe-a', 'probe'); registry.attach('probe-b', 'probe')
    // `kind` on a declaration is the instance ID (the grouping key the panel and worker environment use).
    expect(registry.declarations().map(declaration => declaration.kind)).toEqual(['probe', 'probe-a', 'probe-b'])
    expect(registry.environments().map(entry => [entry.instance, entry.kind.kind, entry.config.interval]))
      .toEqual([['probe', 'probe', 5], ['probe-a', 'probe', 9]])
    // The values of an environment are computed from that instance's own config.
    expect(registry.environments()[1]!.environment.values({ deployment: undefined as never, config: { interval: 9 } }))
      .toEqual({ PROBE_INTERVAL: '9' })
    // lane declares no environment, so only probe instances appear.
    expect(registry.declarations().every(declaration => declaration.variables[0]!.key === 'PROBE_INTERVAL')).toBe(true)
  })
  it('gives a mounted second instance its own health entry named by the instance ID, released on unmount', () => {
    const board = new HealthBoard()
    const registry = new SourceRegistry(() => settings(), board)
    registry.register(probe)
    registry.attach('probe-a', 'probe')
    // The default instance reports on the kind's entry; another instance claims its own, so both report separately.
    expect(board.all).toMatchObject({ probe: { state: 'starting' }, 'probe-a': { state: 'starting' } })
    const entries = registry.healthEntries(['probe', 'probe-a'])
    expect([...entries.keys()]).toEqual(['probe', 'probe-a'])
    entries.get('probe-a')!.set({ state: 'ready', detail: 'second instance' })
    expect(board.all['probe-a']).toEqual({ state: 'ready', detail: 'second instance' })
    // Attaching the default instance itself (ID equal to the kind name) claims nothing extra.
    const detach = registry.attach('probe', 'probe')
    detach()
    expect(board.all.probe).toEqual({ state: 'starting', detail: '' })
    expect(registry.healthEntries(['probe-a']).size).toBe(1)
    registry.attach('probe', 'probe')()
  })
  it('parses stored pre-multi-instance configs without `kind`, and stores a multi-instance entry with it', () => {
    // Old settings: an instance whose ID is its kind; no migration needed.
    expect(SourceInstanceSchema.parse({ enabled: false, config: { interval: 9 } })).toEqual({ enabled: false, config: { interval: 9 } })
    expect(SourceInstanceSchema.parse({ config: {} })).toEqual({ enabled: true, config: {} })
    const legacy = SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: 'acme/widgets' } }, retired: { config: { x: 1 } } } })
    expect(legacy.sources).toEqual({ github: { enabled: true, config: { repository: 'acme/widgets' } }, retired: { enabled: true, config: { x: 1 } } })
    // New settings name the implementation once the instance ID differs from it.
    const multi = SettingsSchema.parse({ sources: { 'github-sites': { kind: 'github', enabled: true, config: { repository: 'acme/site' } } } })
    expect(multi.sources['github-sites']).toEqual({ kind: 'github', enabled: true, config: { repository: 'acme/site' } })
    // `strict()`: no other keys, and the kind name follows the instance ID format.
    expect(() => SourceInstanceSchema.parse({ installed: true })).toThrow()
    expect(() => SettingsSchema.parse({ sources: { 'github-sites': { kind: 'GitHub', config: {} } } })).toThrow()
  })
})
