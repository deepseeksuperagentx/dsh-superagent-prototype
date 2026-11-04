/**
 * Webhook source kind: takes in machine events a sender drops into a local inbox directory, and answers an event's
 * callback URL. It reads no CLI and needs no account, so the events of a machine (a nightly check, a site probe, a
 * dashboard) reach the same gate as a person's GitHub or Feishu message.
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { isoTime, key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export const SOURCE = 'webhook'
/**
 * One event, as its sender writes it. `sender.id` is the identity the Policy lists; a sender that leaves `bot` true can
 * at most become an inferred candidate, and one that omits `sender` has no identity and uses the unlisted cell of its
 * conversation's admission row.
 */
export const EventSchema = z.object({
  id: z.string().trim().min(1).max(120),
  conversation: z.string().trim().min(1).max(60),
  /** The event that opened this conversation thread; the event itself when omitted, which keeps one event its own thread. */
  thread: z.string().trim().min(1).max(120).optional(),
  sender: z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional(),
    bot: z.boolean().default(true) }).strict().optional(),
  /** Only a relay of a message that really addressed the agent sets this; a machine never earns an explicit request. */
  addressed: z.enum(['mention', 'direct']).optional(),
  text: z.string().trim().min(1).max(20_000),
  at: z.string().trim().min(1).max(40),
  url: z.string().trim().max(500).optional(),
  /** Where replies go. An event without one can never receive one, so `send` answers `gone` and the message is dropped. */
  callback: z.string().trim().url().max(500).optional(),
  /** Passed through to the Trigger's `meta.event`; it cannot set a field this Source owns. */
  meta: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
}).strict()
export type WebhookEvent = z.infer<typeof EventSchema>

const ConversationSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), listen: z.enum(['mentions', 'all']) }).strict()
const WebhookConfigSchema = z.object({
  inbox: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty to read nothing')
    .default(''),
  conversations: z.array(ConversationSchema)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate conversation ids').default([]),
  pollSeconds: z.number().int().min(5).max(3600).default(15),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>

/** Senders write events to `pending`; each file this Source takes in moves to `seen`, or to `bad` when it cannot be read. */
const PENDING = 'pending', SEEN = 'seen', BAD = 'bad'
/** Receipts kept after a round, newest first, so the inbox holds an audit trail without growing without bound. */
const SEEN_KEPT = 200, BAD_KEPT = 50

/** One of the inbox's own directories: `pending`, `seen` or `bad`. */
const part = (root: string, name: string): string => join(root, name)
const eventFile = (root: string, name: string, event: string): string => join(root, name, event)
/** Parses one event file; undefined when it is missing, is not JSON, or is not an event. */
function readEvent(file: string): WebhookEvent | undefined {
  try {
    const parsed = EventSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')) as unknown)
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}
/** Moves one consumed event to a receipt directory, creating it, and keeps only the newest `kept` receipts. */
function receipt(root: string, event: string, target: string, kept: number): void {
  const to = part(root, target)
  mkdirSync(to, { recursive: true })
  renameSync(eventFile(root, PENDING, event), join(to, event))
  const receipts = readdirSync(to).filter(name => name.endsWith('.json')).sort()
  for (const old of receipts.slice(0, Math.max(0, receipts.length - kept))) {
    try { rmSync(join(to, old), { force: true }) } catch { /* A receipt another round removed is nothing to report. */ }
  }
}

/** The Trigger of one event. Its id carries the conversation, so two senders may reuse an event id without colliding. */
export function webhookTrigger(event: WebhookEvent): Trigger {
  const sender = event.sender ?? { id: '', name: undefined, bot: true }
  const root = event.thread ?? event.id
  const thread = `${event.conversation}:${root}`
  return {
    id: key(SOURCE, event.conversation, event.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: sender.id },
    human: sender.bot === false,
    ...(event.addressed ? { addressed: event.addressed } : {}),
    at: isoTime(event.at),
    text: event.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { conversation: event.conversation, event: event.id,
      ...(sender.id ? { sender: sender.id } : {}), ...(event.callback ? { callback: event.callback } : {}),
      ...(event.url ? { url: event.url } : {}) } },
    ...(event.url ? { url: event.url } : {}),
    meta: { conversation: event.conversation, eventId: event.id, root, event: event.meta ?? {} },
  }
}

/**
 * Posts a reply to the event's callback. The body carries `message.id` as the idempotency key, so a retry after a failed
 * answer must not post the reply twice on the sender's side.
 */
export async function sendWebhook(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { callback, conversation, event } = message.channel.address
  if (!callback) return 'gone'
  if (!conversation || !event) throw new Error('Missing webhook reply target')
  const answer = await fetch(callback, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: message.id, conversation, event, kind: message.kind,
      ...(message.ticketId ? { ticket: message.ticketId } : {}), text: message.text }) })
  // 410 says the target closed for good; any other failed answer may succeed on a later retry.
  if (answer.status === 410) return 'gone'
  if (!answer.ok) throw new Error(`The webhook callback answered ${answer.status}`)
  return 'sent'
}

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: SOURCE,
  title: { zh: 'Webhook 事件', en: 'Webhook events' },
  description: { zh: '读取事件目录里下列对话送来的事件；回复发到事件带的回调地址。', en: 'Reads the events these conversations send from the inbox directory, and replies to the callback each event carries.' },
  schema: WebhookConfigSchema,
  fields: [
    { key: 'inbox', type: 'text', label: { zh: '事件目录', en: 'Inbox directory' },
      hint: { zh: '绝对路径。发送方把一条事件写成一个 JSON 文件：先写别处，再改名放进这个目录的 pending/；本来源读完后移到 seen/，读不出的移到 bad/。留空表示什么都不读。',
        en: 'An absolute path. A sender writes each event as one JSON file elsewhere and renames it into this directory\'s pending/; this Source moves each event it reads to seen/, and one it cannot read to bad/. Empty reads nothing.' } },
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' },
      hint: { zh: '“仅 @”只接收事件里 addressed 写了 mention 或 direct 的那些；“全部事件”都接收，评估可以从中推断工作。谁的事件能成为工单看策略里的准入。',
        en: '"@ only" takes events whose addressed field says mention or direct; "All" takes the rest, from which Eval may infer work. Which senders\' events can become Tickets is the Policy\'s admission.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z][a-z0-9_-]{0,39}' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部事件', en: 'All' } }] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '读取间隔 / 秒', en: 'Reading interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20,
      label: { zh: '连续失败几次后报告异常', en: 'Failed rounds before reporting an error' },
      hint: { zh: '单次读不出会在下一轮自动重试，不必报告。', en: 'A single failed round is retried on the next one and need not be reported.' } },
  ],
  health: [SOURCE],
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
  // A reply goes only to a conversation this Source still receives, and only where the event left a callback.
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 事件 ${address.conversation ?? ''}/${address.event ?? ''}`, en: `Webhook event ${address.conversation ?? ''}/${address.event ?? ''}` } }),
  },
  // An event names the one it answers, so the root's Trigger is derivable without reading anything.
  repliesTo: trigger => typeof trigger.meta.root === 'string' && typeof trigger.meta.eventId === 'string'
    && trigger.meta.root !== trigger.meta.eventId ? key(SOURCE, String(trigger.meta.conversation), trigger.meta.root) : undefined,
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(listed => new Set(listed.map(entry => entry.id.toLowerCase())).size === listed.length, 'Duplicate sender ids').default([]),
      bots: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' },
        hint: { zh: '只有事件把 addressed 写成 mention 或 direct 时，名单里的发送者才是明确的请求；机器事件通常不写，所以最多成为推断的候选。',
          en: 'A sender on this list makes an explicit request only when the event says addressed is mention or direct. Machine events usually say nothing, so they are inferred candidates at most.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '事件可以成为候选的机器发送者', en: 'Machine senders whose events may become candidates' },
        hint: { zh: '名单里的机器发送者在接收的对话里的事件成为推断的候选，交给评估。它们不能发起明确的请求，也不能停止工单；其他机器的事件不接收。',
          en: 'An event of a sender on this list, in a conversation the Source receives, becomes an inferred candidate for an assessment. Such an event never makes an explicit request or stops a ticket; other machines\' events are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单里的发送者在事件里把 addressed 写成 mention 或 direct。', en: 'A sender on the list sends an event whose addressed field says mention or direct.' },
    rows(stored) {
      const config = WebhookConfigSchema.partial().parse(stored)
      return (config.conversations ?? []).map(conversation => {
        const all = conversation.listen === 'all'
        return { id: conversation.id, label: conversation.id,
          note: all ? { zh: '全部事件', en: 'All' } : { zh: '仅 @', en: '@ only' },
          cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
      })
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: { zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空', en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } },
      { key: 'DSH_SUPERAGENT_WEBHOOK_EVENT', description: { zh: '接下工单的事件 id，由发送方起名；工单不是从这个来源来的时为空', en: 'id of the event that started the ticket, named by its sender; empty when the ticket did not start on this Source' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversation ?? '') : '',
      DSH_SUPERAGENT_WEBHOOK_EVENT: trigger?.source === SOURCE ? String(trigger.meta.eventId ?? '') : '',
    }),
  },
  facts: (): Record<string, Localized | string> => ({}),
}

/** Reads what waits in the inbox, takes in each event, then moves it out of `pending`; an aborted round keeps its unread files. */
export async function pollInbox(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const root = ctx.config<WebhookConfig>(SOURCE)?.inbox ?? ''
  const waiting = root && existsSync(part(root, PENDING))
    ? readdirSync(part(root, PENDING)).filter(name => name.endsWith('.json')).sort() : []
  let read = 0
  let unreadable = 0
  for (const name of waiting) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const event = readEvent(eventFile(root, PENDING, name))
    if (!event) { unreadable++; receipt(root, name, BAD, BAD_KEPT); continue }
    const trigger = webhookTrigger(event)
    await ctx.receive(trigger)
    read++
    const facts = { conversation: { label: { zh: '对话', en: 'Conversation' }, value: event.conversation },
      ...(event.sender?.id ? { sender: { label: { zh: '发送者', en: 'Sender' }, value: event.sender.name || event.sender.id } } : {}) }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { ...(event.url ? { url: event.url } : {}), facts })
    receipt(root, name, SEEN, SEEN_KEPT)
  }
  return { read, unreadable }
}
/** Returns an error health once `failures` rounds fail in a row, so one bad read stays quiet and retries next round. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>(SOURCE)
    if (!config || !config.inbox) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollInbox(ctx, signal)
        failures = 0
        // An event needs no account, so it is stored while setup still waits for one; only its assessment waits for the restart that ends setup.
        const waiting = ctx.configured() ? '' : '; assessment waits for the deployment check'
        ctx.report(SOURCE, { state: 'ready', detail: `${read} events, ${unreadable} unreadable${waiting}`, at })
      } catch (error) {
        failures += 1
        const failed = pollFailure(failures, config.failuresBeforeError, error)
        if (!signal.aborted && failed) ctx.report(SOURCE, failed)
      }
    }
    await delay((config?.pollSeconds ?? 15) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
