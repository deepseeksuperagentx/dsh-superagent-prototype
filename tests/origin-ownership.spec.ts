/**
 * 回归用例：递归派单禁令（ADR-0012）的归属判定口径（2026-11-08 三鑫拍板口径 a）。
 *
 * 背景 bug：定时器每天用同一个 `origin.session` 代发事件；第一条定时事件建出的工单会把
 * `origin.session` 写进自己的 `mandate.basis.scope.event`。旧口径 `value like '%session%'` 把这处
 * 「派单来源」也算成归属，于是第二次代发被自己上一次留下的痕迹拒掉（自我冲突）。
 *
 * 新口径：只认「键名里带 session 的结构化字段」的引用，并排除派单来源子树 `mandate.basis.scope.event`；
 * 正文（report.summary / attention.question / inputs[].text / title …）里提到会话 id 不算归属 —— 否则任何一次
 * 报告里写一句 id 就会把长期定时器永久拒死。
 * 本用例同时锁「放行」与「仍然拒发」两个方向，防止把防递归门口开得过大。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SENDER = join(import.meta.dirname, '..', 'scripts', 'superagent-event.mjs')
const GUARD = join(import.meta.dirname, '..', 'scripts', 'inbox-guard.mjs')
const TIMER_ORIGIN = 'rollout-curve-thicken'

let root: string
let dataRoot: string
let inbox: string

/** Spawn one script under the same Node binary running the test and return its exit code and streams. */
function runScript(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Build a minimal orchestrator.sqlite in the temp data root with the ticket/thread rows the ownership query reads. */
function seedDatabase(rows: { tickets?: Record<string, unknown>[]; threads?: Record<string, unknown>[] } = {}) {
  const file = join(dataRoot, 'state', 'superagent', 'orchestrator.sqlite')
  mkdirSync(join(dataRoot, 'state', 'superagent'), { recursive: true })
  rmSync(file, { force: true })
  const literal = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'`
  const sql = [
    'create table ticket (id text primary key, value text not null);',
    'create table thread (key text primary key, value text not null);',
    ...(rows.tickets ?? []).map((value, index) => `insert into ticket (id, value) values ('ticket-${index}', ${literal(value)});`),
    ...(rows.threads ?? []).map((value, index) => `insert into thread (key, value) values ('thread-${index}', ${literal(value)});`),
  ].join('\n')
  const out = spawnSync('sqlite3', [file], { input: sql, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`sqlite3 seed failed: ${out.stderr}`)
}

/** A ticket as the engine stores one created by a forwarded chat-session event: the source session lives only in the dispatch scope. */
const ticketFromForwardedEvent = (session: string) => ({
  id: 'forwarded',
  title: 'curve 加厚 发布 Day 2',
  mandate: {
    strength: 'explicit',
    basis: {
      source: 'webhook',
      scope: {
        conversation: 'ops',
        eventId: 'day-2-event',
        event: { 'origin.kind': 'chat-session', 'origin.session': session, 'origin.signedAt': '2026-11-09T02:00:00.000Z' },
      },
    },
    actor: { source: 'webhook', id: 'someonehereany' },
    scope: 'curve 加厚 发布 Day 2',
  },
  assignments: [{ id: 'a1', state: 'running' }],
  channels: [{ source: 'webhook', thread: 'webhook:ops:day-2-event' }],
})

/** A ticket whose ownership data mentions a session outside the dispatch scope: this session really is superagent-managed. */
const ticketOwningSession = (session: string) => ({
  id: 'managed',
  title: 'managed session',
  mandate: { strength: 'explicit', basis: { source: 'webhook', scope: { conversation: 'ops', eventId: 'e1' } } },
  execution: { name: 'managed', session },
})

/** One pending event as the sender writes it (flat scalar meta, as the engine EventSchema requires). */
function writePendingEvent(id: string, session: string, kind = 'chat-session') {
  mkdirSync(join(inbox, 'pending'), { recursive: true })
  const event = {
    id,
    conversation: 'ops',
    text: 'daily curve thicken batch',
    at: '2026-11-09T02:00:00.000Z',
    meta: { 'origin.kind': kind, 'origin.session': session, 'origin.signedAt': '2026-11-09T02:00:00.000Z' },
  }
  const file = join(inbox, 'pending', `${id}.json`)
  writeFileSync(file, JSON.stringify(event, undefined, 2))
  return file
}

function senderArgs(originSession: string | undefined, extra: string[] = []) {
  const args = [
    '--inbox', inbox,
    '--conversation', 'ops',
    '--text', 'daily curve thicken batch',
    '--data-root', dataRoot,
    '--id', 'event-under-test',
    ...extra,
  ]
  if (originSession !== undefined) args.push('--origin-kind', 'chat-session', '--origin-session', originSession)
  return args
}

/** Files sitting in `<inbox>/pending`, sorted, so assertions do not depend on directory order. */
const pending = () => (existsSync(join(inbox, 'pending')) ? readdirSync(join(inbox, 'pending')).filter(name => name.endsWith('.json')).sort() : [])
const rejected = () => (existsSync(join(inbox, 'rejected')) ? readdirSync(join(inbox, 'rejected')).filter(name => name.endsWith('.json')).sort() : [])

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'origin ownership '))
  dataRoot = join(root, 'my_dsh_data')
  inbox = join(root, 'webhook-inbox')
  mkdirSync(inbox, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('superagent-event.mjs ownership', () => {
  it('放行：同一 origin.session 的第二次代发（来源只出现在 mandate.basis.scope.event 里）', () => {
    seedDatabase({ tickets: [ticketFromForwardedEvent(TIMER_ORIGIN)] })
    const result = runScript(SENDER, senderArgs(TIMER_ORIGIN))
    expect(result.code).toBe(0)
    expect(pending()).toEqual(['event-under-test.json'])
  })

  it('仍拒发：会话出现在派单来源之外的归属字段（execution.session）', () => {
    seedDatabase({ tickets: [ticketOwningSession(TIMER_ORIGIN)] })
    const result = runScript(SENDER, senderArgs(TIMER_ORIGIN))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('是 superagent 自己管的会话')
    expect(pending()).toEqual([])
  })

  it('仍拒发：会话出现在 thread', () => {
    seedDatabase({ threads: [{ key: 'webhook:ops:x', meta: { session: TIMER_ORIGIN } }] })
    const result = runScript(SENDER, senderArgs(TIMER_ORIGIN))
    expect(result.code).toBe(1)
    expect(pending()).toEqual([])
  })

  it('仍拒发：同一会话既在派单来源里、也在别的归属字段里', () => {
    seedDatabase({ tickets: [ticketFromForwardedEvent(TIMER_ORIGIN), ticketOwningSession(TIMER_ORIGIN)] })
    expect(runScript(SENDER, senderArgs(TIMER_ORIGIN)).code).toBe(1)
  })

  it('来源里是别的会话时不受影响（排除只作用于该子树，不是整表放过）', () => {
    seedDatabase({ tickets: [ticketFromForwardedEvent('some-other-session')] })
    expect(runScript(SENDER, senderArgs(TIMER_ORIGIN)).code).toBe(0)
  })

  it('放行：正文里提到会话 id 不算归属（report.summary / attention.question / inputs[].text / title）', () => {
    const noisy = {
      id: 'noisy',
      title: `发布说明：origin.session=${TIMER_ORIGIN} 的定时器`,
      mandate: { strength: 'explicit', basis: { source: 'webhook', scope: { conversation: 'ops', eventId: 'e1', event: { 'origin.session': TIMER_ORIGIN } } } },
      assignments: [{ id: 'a1', state: 'running', report: { state: 'ready', summary: `本次由 ${TIMER_ORIGIN} 代发` } }],
      attention: { id: 'x', question: `要不要继续用 ${TIMER_ORIGIN}？` },
      inputs: [{ id: 'i1', kind: 'note', text: `--origin-session ${TIMER_ORIGIN}` }],
    }
    seedDatabase({ tickets: [noisy] })
    expect(runScript(SENDER, senderArgs(TIMER_ORIGIN)).code).toBe(0)
  })

  it('放行：出现在键名不含 session 的普通字段里（notes）不算归属', () => {
    seedDatabase({ tickets: [{ id: 'notes', notes: `backed by ${TIMER_ORIGIN}` }] })
    expect(runScript(SENDER, senderArgs(TIMER_ORIGIN)).code).toBe(0)
  })

  it('仍拒发：键名带 session 的其他结构化字段（executorSession）', () => {
    seedDatabase({ tickets: [{ id: 'exec', execution: { executorSession: TIMER_ORIGIN } }] })
    expect(runScript(SENDER, senderArgs(TIMER_ORIGIN)).code).toBe(1)
  })

  it('未变：--origin-kind worker 依旧发送侧直接拒发', () => {
    seedDatabase()
    const result = runScript(SENDER, senderArgs(undefined, ['--origin-kind', 'worker']))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('不得给 superagent 派单')
  })
})

describe('inbox-guard.mjs ownership', () => {
  it('放行：第二次定时事件留在 pending（不被收件侧挪走）', () => {
    seedDatabase({ tickets: [ticketFromForwardedEvent(TIMER_ORIGIN)] })
    writePendingEvent('timer-day-3', TIMER_ORIGIN)
    const result = runScript(GUARD, ['--once', '--data-root', dataRoot, '--inbox', inbox])
    expect(result.code).toBe(0)
    expect(pending()).toEqual(['timer-day-3.json'])
    expect(rejected()).toEqual([])
  })

  it('放行：正文提到会话 id 的事件不被收件侧挪走', () => {
    seedDatabase({
      tickets: [{ id: 'noisy', assignments: [{ report: { summary: `${TIMER_ORIGIN} 代发` } }], attention: { question: TIMER_ORIGIN } }],
    })
    writePendingEvent('timer-noisy', TIMER_ORIGIN)
    runScript(GUARD, ['--once', '--data-root', dataRoot, '--inbox', inbox])
    expect(pending()).toEqual(['timer-noisy.json'])
    expect(rejected()).toEqual([])
  })

  it('仍拦：真正属于 superagent 的会话事件挪进 rejected/ 并写 reason', () => {
    seedDatabase({ tickets: [ticketOwningSession('session-managed-1')] })
    writePendingEvent('worker-ish', 'session-managed-1')
    const result = runScript(GUARD, ['--once', '--data-root', dataRoot, '--inbox', inbox])
    expect(result.code).toBe(0)
    expect(pending()).toEqual([])
    const moved = rejected()
    expect(moved).toHaveLength(1)
    expect(moved[0]).toContain('worker-ish')
    const reason = readFileSync(join(inbox, 'rejected', `${moved[0]}.reason.txt`), 'utf8')
    expect(reason).toContain('session-managed-1')
  })

  it('仍拦：worker 来源事件（未变）', () => {
    seedDatabase()
    writePendingEvent('worker-event', 'anything', 'worker')
    runScript(GUARD, ['--once', '--data-root', dataRoot, '--inbox', inbox])
    expect(pending()).toEqual([])
    expect(rejected()).toHaveLength(1)
  })
})
