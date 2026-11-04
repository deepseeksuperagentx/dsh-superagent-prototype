/** The webhook Source: event files into Triggers, the inbox round, callback replies, its part of the Policy, and its loop. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { apply, pollFailure, pollInbox, sendWebhook, webhookKind, webhookTrigger, type WebhookConfig, type WebhookEvent }
  from '../src/sources/webhook.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'

const roots: string[] = []
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'webhook-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals() })

/** One event, as a sender would write it; `fields` override the machine-event defaults. */
const event = (id: string, fields: Partial<WebhookEvent> = {}): WebhookEvent => ({
  id, conversation: 'ops', text: `Site ${id} needs a fix`, at: '2026-11-04T00:00:00Z', sender: { id: 'probe-bot', bot: true }, meta: {}, ...fields,
})
/** Drops one event into the inbox the way a sender must: written elsewhere, then renamed into `pending`. */
function emit(root: string, name: string, value: unknown): void {
  const waiting = join(root, 'pending')
  mkdirSync(waiting, { recursive: true })
  const temp = join(root, `${name}.part`)
  writeFileSync(temp, typeof value === 'string' ? value : JSON.stringify(value))
  renameSync(temp, join(waiting, `${name}.json`))
}
const names = (directory: string): string[] => existsSync(directory) ? readdirSync(directory).sort() : []

function host(overrides: Partial<SourceContextDeps> = {}, config: Partial<WebhookConfig> = {}, fresh = false) {
  const root = tempRoot()
  const store = new Store(join(tempRoot(), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    eval: { mode: 'observe' },
    sources: { webhook: { enabled: true, config: { inbox: root, pollSeconds: 5,
      conversations: [{ id: 'ops', listen: 'all' }, { id: 'quiet', listen: 'mentions' }], ...config } } },
    policy: { sources: { webhook: { allowed: [{ id: 'sanxin', name: 'Sanxin' }], bots: [{ id: 'probe-bot' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  // `fresh` leaves the kind uninstalled, so what the test then sees is the plugin entry's own registration.
  if (!fresh) sources.register(webhookKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  // The Sources' functions take the context; the plugin entries take the host, which builds each kind's context.
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ...value, root, store, engine, commands, receive, assessor, executor, health: board.all,
    ctx: sourceContextOf(parts, webhookKind) }
}

describe('webhook source', () => {
  it('maps an event to one Trigger whose id carries its conversation', () => {
    const trigger = webhookTrigger(event('e1'))
    expect(trigger).toMatchObject({ id: key('webhook', 'ops', 'e1'), source: 'webhook',
      threads: [{ source: 'webhook', id: 'ops:e1' }], actor: { source: 'webhook', id: 'probe-bot' }, human: false,
      at: '2026-11-04T00:00:00.000Z', text: 'Site e1 needs a fix',
      channel: { source: 'webhook', thread: 'webhook:ops:e1', address: { conversation: 'ops', event: 'e1', sender: 'probe-bot' } },
      meta: { conversation: 'ops', eventId: 'e1', root: 'e1', event: {} } })
    expect(trigger).not.toHaveProperty('addressed')
    // A reply names the event that opened its thread, and a person's addressed event is explicit-strength material.
    const reply = webhookTrigger(event('e2', { thread: 'e1', addressed: 'mention', sender: { id: 'sanxin', bot: false } }))
    expect(reply.threads[0]!.id).toBe('ops:e1')
    expect(reply.human).toBe(true)
    expect(reply.addressed).toBe('mention')
    expect(webhookKind.repliesTo!(reply)).toBe(key('webhook', 'ops', 'e1'))
    expect(webhookKind.repliesTo!(trigger)).toBeUndefined()
  })
  it('keeps sender-supplied metadata from naming the scope this Source owns', () => {
    const trigger = webhookTrigger(event('e3', { meta: { conversation: 'whoever', listen: 'all' } }))
    expect(trigger.meta.conversation).toBe('ops')
    expect(trigger.meta.event).toEqual({ conversation: 'whoever', listen: 'all' })
  })
  it('takes in what the inbox holds, files each event, and refuses to read one twice', async () => {
    const h = host()
    emit(h.root, 'a', event('e1'))
    emit(h.root, 'b', { id: 'broken' })
    emit(h.root, 'c', event('e2', { conversation: 'elsewhere' }))
    expect(await pollInbox(h.ctx, new AbortController().signal)).toEqual({ read: 2, unreadable: 1 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    // An event of a conversation the Source does not receive is stored as filtered, so the panel can explain it.
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    expect(names(join(h.root, 'pending'))).toEqual([])
    expect(names(join(h.root, 'seen'))).toEqual(['a.json', 'c.json'])
    expect(names(join(h.root, 'bad'))).toEqual(['b.json'])
    expect(h.store.triggers.disposition(key('webhook', 'elsewhere', 'e2'))?.filtered?.code).toBe('conversation_not_listed')
    expect(h.store.triggers.get(key('webhook', 'ops', 'e1'))?.text).toBe('Site e1 needs a fix')
    // The Thread shows where the event came from, and the URL it carried.
    emit(h.root, 'd', event('e4', { url: 'https://status.example.test/e4' }))
    await pollInbox(h.ctx, new AbortController().signal)
    expect(h.store.threads.get('webhook:ops:e4')?.meta).toMatchObject({ url: 'https://status.example.test/e4',
      facts: { conversation: { value: 'ops' }, sender: { value: 'probe-bot' } } })
  })
  it('keeps the events a stop cut short in pending, so the next round reads them', async () => {
    const h = host()
    emit(h.root, 'a', event('e1'))
    emit(h.root, 'b', event('e2'))
    const controller = new AbortController()
    controller.abort()
    await expect(pollInbox(h.ctx, controller.signal)).rejects.toThrow('stopped during the read')
    expect(names(join(h.root, 'pending'))).toEqual(['a.json', 'b.json'])
    expect(names(join(h.root, 'seen'))).toEqual([])
  })
  it('admits a listed machine sender as an inferred candidate under observe, and refuses one off the list', async () => {
    const h = host()
    emit(h.root, 'a', event('e1'))
    emit(h.root, 'b', event('e9', { sender: { id: 'stranger-bot', bot: true } }))
    await pollInbox(h.ctx, new AbortController().signal)
    expect(h.engine.candidate(key('webhook', 'ops', 'e1'))?.strength).toBe('inferred')
    // A sender off every list never reaches an assessment: its Thread records why it was ignored instead.
    const refused = h.store.decisions.byThread('webhook:ops:e9')
    expect(refused.at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'not_human', triggerId: key('webhook', 'ops', 'e9') }] })
    expect(h.executor.start).not.toHaveBeenCalled()
  })
  it('takes an addressed event of a mentions-only conversation, and drops the rest there', async () => {
    const h = host()
    emit(h.root, 'a', event('e1', { conversation: 'quiet', addressed: 'mention' }))
    emit(h.root, 'b', event('e2', { conversation: 'quiet' }))
    await pollInbox(h.ctx, new AbortController().signal)
    expect(h.engine.candidate(key('webhook', 'quiet', 'e1'))?.strength).toBe('inferred')
    // An unaddressed event of a mentions-only conversation is still read, but the gate ignores it before any assessment.
    const refused = h.store.decisions.byThread('webhook:quiet:e2')
    expect(refused.at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'not_human', triggerId: key('webhook', 'quiet', 'e2') }] })
  })
  it('posts a reply to the callback once, and calls only a closed target gone', async () => {
    const h = host()
    const message = { id: 'm-1', channel: { source: 'webhook', thread: 'webhook:ops:e1',
      address: { conversation: 'ops', event: 'e1', callback: 'https://hooks.example.test/dsh' } }, text: 'Done', kind: 'reply' as const }
    const post = vi.fn(async (_url?: string | URL, _init?: { body?: string }) => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', post)
    expect(await sendWebhook({ commands: h.commands }, message)).toBe('sent')
    expect(post.mock.calls[0]![0]).toBe('https://hooks.example.test/dsh')
    expect(post.mock.calls[0]![1]!.body).toContain('"key":"m-1"')
    // A second delivery of the same message id keeps the same key, so the sender can deduplicate it.
    await sendWebhook({ commands: h.commands }, message)
    expect(post).toHaveBeenCalledTimes(2)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 410 })))
    expect(await sendWebhook({ commands: h.commands }, message)).toBe('gone')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    await expect(sendWebhook({ commands: h.commands }, message)).rejects.toThrow('answered 500')
    // An event that carried no callback can never receive a reply, so its message is dropped rather than retried.
    expect(await sendWebhook({ commands: h.commands }, { ...message, channel: { ...message.channel,
      address: { conversation: 'ops', event: 'e1' } } })).toBe('gone')
  })
  it('refuses a reply whose address lost its conversation, and links an event by its own name', () => {
    const config = webhookKind.schema.parse({ conversations: [{ id: 'ops', listen: 'all' }] })
    expect(webhookKind.channel!.allowed!({ conversation: 'ops' }, config)).toBe(true)
    expect(webhookKind.channel!.allowed!({ conversation: 'closed' }, config)).toBe(false)
    expect(webhookKind.channel!.link({ conversation: 'ops', event: 'e1', url: 'https://status.example.test/e1' }, {}))
      .toEqual({ url: 'https://status.example.test/e1', label: { zh: 'Webhook 事件 ops/e1', en: 'Webhook event ops/e1' } })
  })
  it('answers the admission table from the conversations it receives', () => {
    const rows = webhookKind.policy!.rows!({ conversations: [{ id: 'ops', listen: 'all' }, { id: 'quiet', listen: 'mentions' }] })
    expect(rows).toEqual([
      { id: 'ops', label: 'ops', note: { zh: '全部事件', en: 'All' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } },
      { id: 'quiet', label: 'quiet', note: { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ])
    expect(webhookKind.policy!.schema.parse({ allowed: [{ id: 'probe-bot' }] }).allowed).toEqual([{ id: 'probe-bot' }])
    expect(() => webhookKind.policy!.schema.parse({ allowed: [{ id: 'a' }, { id: 'A' }] })).toThrow('Duplicate sender ids')
  })
  it('registers its kind, follows the switch and the inbox, and turns a failure that escapes the loop into health', async () => {
    const run = async (overrides: Partial<SourceContextDeps>, config: Partial<WebhookConfig> = {}) => {
      const value = host(overrides, config, true)
      const disposers: (() => unknown)[] = []
      apply({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      // Registration only claims the entry; wait for the Source's first report to replace the `starting` placeholder.
      await vi.waitFor(() => expect(value.health.webhook?.state ?? 'starting').not.toBe('starting'))
      // Snapshot the kind and its health before disposal unregisters the Source and clears its entries.
      const health = { ...value.health }
      const registered = value.sources.kind('webhook')
      for (const dispose of disposers) await dispose()
      return { ...value, health, registered }
    }
    const off = await run({}, { inbox: '' })
    expect(off.registered).toBe(webhookKind)
    expect(off.health.webhook).toMatchObject({ state: 'paused', code: 'sourceOff' })
    const before = await run({ configured: () => false })
    // Events need no account, so they are stored while setup waits; only their assessment waits for the restart.
    expect(before.health.webhook).toMatchObject({ state: 'ready', detail: '0 events, 0 unreadable; assessment waits for the deployment check' })
    const after = await run({ ready: Promise.reject(new Error('runtime died')) })
    expect(after.health.webhook).toEqual({ state: 'error', detail: 'Error: runtime died' })
  })
  it('reports an error only after the configured number of failed rounds', () => {
    expect(pollFailure(1, 3, new Error('disk busy'))).toBeUndefined()
    expect(pollFailure(3, 3, new Error('disk busy'))).toMatchObject({ state: 'error', code: 'pollFailures',
      values: { count: '3', error: 'Error: disk busy' } })
  })
  it('declares a configuration that receives nothing until an operator names an inbox and its conversations', () => {
    expect(webhookKind.schema.parse({})).toEqual({ inbox: '', conversations: [], pollSeconds: 15, failuresBeforeError: 3 })
    expect(webhookKind.schema.safeParse({ inbox: 'pending' }).success).toBe(false)
    expect(webhookKind.scope!({ meta: { conversation: 'ops' } }, webhookKind.schema.parse({}))).toEqual({ listened: false, reason: 'conversation_not_listed' })
    expect(webhookKind.environment!.values({ deployment: testDeployment(), config: webhookKind.schema.parse({}) }))
      .toEqual({ DSH_SUPERAGENT_WEBHOOK_CONVERSATION: '', DSH_SUPERAGENT_WEBHOOK_EVENT: '' })
    expect(webhookKind.environment!.values({ deployment: testDeployment(), config: webhookKind.schema.parse({}), trigger: webhookTrigger(event('e1')) }))
      .toEqual({ DSH_SUPERAGENT_WEBHOOK_CONVERSATION: 'ops', DSH_SUPERAGENT_WEBHOOK_EVENT: 'e1' })
  })
})
