#!/usr/bin/env node
/**
 * Emit one event to the webhook Source's inbox, the way any sender must write it: to a temporary file in the inbox
 * itself, then renamed into `pending/` so the Source never reads a half-written event. It doubles as the smoke test of
 * the Source, being the only program here that speaks the sender's side of the contract.
 *
 *   scripts/superagent-event.mjs --inbox /path/to/inbox --conversation ops --text 'Nightly check found 3 broken pages'
 *
 * The Source moves each event it reads to `<inbox>/seen/`, or to `<inbox>/bad/` when it cannot read it, so a sender can
 * tell an event that was taken in from one that was rejected without asking the engine.
 *
 * An event carries the `callback` the engine posts its replies to; an event without one can never receive a reply (the
 * Source answers `gone` and the message is dropped). No sender should have to spell that URL out, so the event takes it
 * from the one config file the local receiver reads, `webhook-reply.json` in the profile's state directory
 * (`{ "url": "http://127.0.0.1:3083/receipt" }`). An explicit `--callback <URL>` wins over it, `--no-callback` leaves it
 * off on purpose, and when that file is missing the event is written exactly as before: no callback.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
// 归属判定的唯一实现（与 scripts/inbox-guard.mjs 共用，口径见文件头注释）。
import { ownedBySuperagent } from './origin-ownership.mjs'

const usage = `Usage: superagent-event.mjs --inbox <absolute directory> --conversation <id> --text <event>
  [--stdin to read the event instead of --text] [--id <event id>] [--thread <event this one answers>] [--at <timestamp>]
  [--sender <id>] [--name <display name>] [--human] [--addressed mention|direct]
  [--url <link to the event>] [--callback <URL replies POST to> | --no-callback]
  [--reply-config <webhook-reply.json>] [--data-root <path>] [--meta key=value ...]
  [--origin-kind human|chat-session|worker] [--origin-session <session id>]
  Default: --reply-config <data-root>/state/superagent/webhook-reply.json --data-root ~/my_dsh_data.

递归派单禁令（2026-11-08 三鑫定）：会话可以给 superagent 派单（含代发），但 superagent 自己的
agent（worker / executor）不得给 superagent 派单。本脚本在发送侧先拦：--origin-kind worker 直接拒发，
--origin-session 命中 orchestrator.sqlite 里 ticket/thread 的会话也拒发。事件把来源写进 meta.origin，
并在 <data-root>/state/superagent/event-audit.jsonl 留一行审计（人签 / 会话代发分开计数）。`
const fail = (message) => { console.error(`${message}\n${usage}`); process.exit(1) }

const argv = process.argv.slice(2)
/** The option's next word, or undefined when the option is absent; the fields are those `EventSchema` accepts. */
const value = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv.at(at + 1) }
const inbox = value('--inbox')
const conversation = value('--conversation')
const text = argv.includes('--stdin') ? readFileSync(0, 'utf8').trim() : value('--text')
const sender = value('--sender')
if (!inbox?.startsWith('/')) fail('Missing --inbox: an absolute directory')
if (!conversation) fail('Missing --conversation')
if (!text) fail('Missing --text (or --stdin to read the event from standard input)')

const dataRoot = value('--data-root') ?? join(homedir(), 'my_dsh_data')
/** 递归派单禁令：来源三档。会话派单允许，superagent 自己的 agent 派单必须拒发。 */
const ORIGIN_KINDS = ['human', 'chat-session', 'worker']
const originKind = value('--origin-kind') ?? 'human'
const originSession = value('--origin-session')
if (!ORIGIN_KINDS.includes(originKind)) fail(`--origin-kind 只能是 ${ORIGIN_KINDS.join(' / ')}（实际 ${originKind}）`)
if (originKind === 'worker') {
  fail('拒发：superagent 的 agent（worker / executor）不得给 superagent 派单（防递归）。请在自己工单里报告，或把结论交回人/会话。')
}
if (originKind === 'chat-session' && !originSession) fail('--origin-kind chat-session 必须带 --origin-session <会话 id>（留痕用）')
if (originSession && ownedBySuperagent(originSession, dataRoot)) {
  fail(`拒发：--origin-session ${originSession} 是 superagent 自己管的会话（ticket/thread 里查得到），不得再给 superagent 派单（防递归）。`)
}

const configFile = value('--reply-config') ?? join(dataRoot, 'state', 'superagent', 'webhook-reply.json')
/** The one callback every event of this machine gets, so the sender never has to spell it out. */
function configuredCallback() {
  if (!existsSync(configFile)) return undefined
  let config
  try { config = JSON.parse(readFileSync(configFile, 'utf8')) } catch (error) { fail(`${configFile} is not JSON: ${error}`) }
  return typeof config?.url === 'string' && config.url ? config.url : undefined
}
/** `--no-callback` is the escape hatch for an event that must stay one-way; otherwise the explicit URL wins, then the file. */
const callback = argv.includes('--no-callback') ? undefined : value('--callback') ?? configuredCallback()
if (callback) {
  try { new URL(callback) } catch { fail(`--callback is not a URL: ${callback}`) }
}

/** Each `--meta key=value` becomes one entry of `event.meta`, which the Source keeps apart from its own fields. */
const pairs = argv.flatMap((arg, at) => arg === '--meta' ? [argv.at(at + 1) ?? ''] : []).filter(pair => pair.includes('='))
const extraMeta = pairs.length ? Object.fromEntries(pairs.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])) : {}
const event = {
  id: value('--id') ?? randomUUID(), conversation, text,
  at: value('--at') ?? new Date().toISOString(),
  ...(value('--thread') ? { thread: value('--thread') } : {}),
  ...(sender ? { sender: { id: sender, bot: !argv.includes('--human'), ...(value('--name') ? { name: value('--name') } : {}) } } : {}),
  ...(value('--addressed') ? { addressed: value('--addressed') } : {}),
  ...(value('--url') ? { url: value('--url') } : {}),
  ...(callback ? { callback } : {}),
  // 来源写进 meta（谁派的单：human / chat-session / worker；代发的是哪个会话；什么时候）。
  // 注意引擎的 EventSchema 把 meta 限制成「字符串(≤500)/数字/布尔」的扁平 record，
  // 不能塞嵌套对象，所以用 origin.kind / origin.session / origin.signedAt 三个扁平键。
  meta: {
    ...extraMeta,
    'origin.kind': originKind,
    ...(originSession ? { 'origin.session': originSession } : {}),
    'origin.signedAt': new Date().toISOString(),
  },
}
mkdirSync(join(inbox, 'pending'), { recursive: true })
const file = join(inbox, 'pending', `${event.id}.json`)
if (existsSync(file)) fail(`The event ${event.id} is already in the inbox`)
// A rename is atomic within a directory, so the Source sees either nothing or the whole event.
writeFileSync(`${file}.part`, `${JSON.stringify(event, undefined, 2)}\n`)
renameSync(`${file}.part`, file)
// 审计：人签 / 会话代发分开留痕，用于「多少活是人起的、多少是会话起的」。
const auditFile = join(dataRoot, 'state', 'superagent', 'event-audit.jsonl')
mkdirSync(join(dataRoot, 'state', 'superagent'), { recursive: true })
appendFileSync(auditFile, `${JSON.stringify({ at: event.at, id: event.id, conversation, originKind, ...(originSession ? { originSession } : {}), sender: sender ?? null, humanFlag: argv.includes('--human'), addressed: value('--addressed') ?? null, chars: text.length })}\n`)
console.log(file)
