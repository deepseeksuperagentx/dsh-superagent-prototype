#!/usr/bin/env node
/**
 * Send a person's answer back to the engine, so a ticket waiting for that person resumes (流 B 的回程).
 *
 * The engine only accepts a person's message as a new Trigger on the thread it came from; its panel has no write
 * endpoint for answers (`GET tickets/:id` and `POST tickets/:id/retry|stop` are all it has). The webhook Source is the
 * one channel where a person can be the sender: an event with `sender.bot = false` and `addressed: 'direct'` becomes a
 * human Trigger, and the engine stops withholding automatic inputs for a ticket once such a message arrives
 * (`waitsForPerson` in src/core/model.ts).
 *
 * The event is written the way every sender must write it: a temporary file in the inbox, renamed into `pending/`, so
 * the Source never reads half an event. `thread` points at the event that started the ticket, which puts the answer on
 * that ticket's own thread.
 *
 * This answer is itself a webhook event, so the engine answers it on its own thread — but only if the event carries a
 * `callback`. It does not have to be spelled out: like `scripts/superagent-event.mjs`, the event takes the URL from the
 * one config file the local receiver reads, `<data-root>/state/superagent/webhook-reply.json`
 * (`{ "url": "http://127.0.0.1:3083/receipt" }`). `--callback <URL>` overrides it, `--no-callback` leaves it off, and
 * when the file is missing the event is written exactly as before: no callback.
 *
 *   scripts/superagent-reply.mjs --ticket <32 位工单号> --text "<拍板结论>"
 *   scripts/superagent-reply.mjs --ticket <32 位工单号> --status
 *
 * The ticket's own row is the only thing read: `channels[].address` carries the conversation and the event id, so the
 * `trigger` table is never touched. A ticket that came from GitHub has no event id and keeps its own channel (answer
 * there instead).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const usage = `Usage: superagent-reply.mjs --ticket <32 位工单号> --text "<拍板结论>"
  [--status] [--data-root <path>] [--db <orchestrator.sqlite>] [--inbox <webhook inbox>]
  [--sender <id>] [--name <名字>] [--conversation <id>]
  [--callback <URL replies POST to> | --no-callback] [--reply-config <webhook-reply.json>]
  Default: --reply-config <data-root>/state/superagent/webhook-reply.json --data-root ~/my_dsh_data.`
const fail = (message) => { console.error(`${message}\n${usage}`); process.exit(1) }

const argv = process.argv.slice(2)
const value = (name) => {
  const at = argv.indexOf(name)
  return at < 0 ? undefined : argv.at(at + 1)
}
const has = (name) => argv.includes(name)

const ticketId = value('--ticket')
if (!ticketId) fail('Give --ticket <32 位工单号>')
const dataRoot = value('--data-root') ?? join(homedir(), 'my_dsh_data')
const dbPath = value('--db') ?? join(dataRoot, 'state', 'superagent', 'orchestrator.sqlite')
const inbox = value('--inbox') ?? join(dataRoot, 'state', 'superagent', 'webhook-inbox')
const sender = value('--sender') ?? 'someonehereany'
const senderName = value('--name') ?? '三鑫'
const text = value('--text')

const configFile = value('--reply-config') ?? join(dataRoot, 'state', 'superagent', 'webhook-reply.json')
/** The one callback every event of this machine gets, so a person's answer can be answered in turn. */
function configuredCallback() {
  if (!existsSync(configFile)) return undefined
  let config
  try { config = JSON.parse(readFileSync(configFile, 'utf8')) } catch (error) { fail(`${configFile} is not JSON: ${error}`) }
  return typeof config?.url === 'string' && config.url ? config.url : undefined
}
const configured = configuredCallback()
/** `--no-callback` is the escape hatch for a one-way event; otherwise the explicit URL wins, then the config file. */
const callback = has('--no-callback') ? undefined : value('--callback') ?? configured
if (callback) {
  try { new URL(callback) } catch { fail(`--callback is not a URL: ${callback}`) }
}

if (!existsSync(dbPath)) fail(`No orchestrator database at ${dbPath}`)
const db = new DatabaseSync(dbPath, { readOnly: true })
const row = db.prepare('SELECT value FROM ticket WHERE id = ?').get(ticketId)
db.close()
if (!row) fail(`No ticket ${ticketId}`)

const ticket = JSON.parse(String(row.value))
const report = ticket.assignments?.findLast((item) => item.report)?.report ?? null
const humanInputAfterReport = (input) => input?.kind === 'trigger' && input?.human && !input?.context && input?.at > (report?.at ?? '')
/** The engine's own rule: a blocked or failed report with no person answering after it means the ticket waits. */
const waitsForPerson = Boolean(report && ['blocked', 'failed'].includes(report.state) && !(ticket.inputs ?? []).some(humanInputAfterReport))
const channel = (ticket.channels ?? []).find((item) => item?.source === 'webhook')

if (has('--status')) {
  console.log(JSON.stringify({
    ticket: ticket.id,
    title: ticket.title,
    ended: ticket.ended ?? null,
    attention: ticket.attention ?? null,
    latestReport: report ? { state: report.state, at: report.at, summary: report.summary } : null,
    waitsForPerson,
    channel: channel ? { conversation: channel.address?.conversation, event: channel.address?.event } : null,
    callback: callback ?? null,
    replyConfig: existsSync(configFile) ? configFile : null
  }, undefined, 2))
  process.exit(0)
}

if (!text) fail('Give --text "<拍板结论>"')
if (!channel) {
  fail(`Ticket ${ticketId} did not start on the webhook source; answer it on its own channel (${(ticket.channels ?? []).map((item) => item.source).join(', ') || 'none'})`)
}
const conversation = value('--conversation') ?? channel.address?.conversation
const originEvent = channel.address?.event
if (!conversation || !originEvent) fail(`Ticket ${ticketId} carries no webhook conversation/event to answer on`)

/** The same answer twice is the same event, so a rerun cannot push a second Trigger at the ticket. */
const digest = createHash('sha1').update(text).digest('hex').slice(0, 8)
const eventId = `reply-${ticketId.slice(0, 12)}-${digest}`
const event = {
  id: eventId,
  conversation,
  thread: originEvent,
  sender: { id: sender, name: senderName, bot: false },
  addressed: 'direct',
  ...(callback ? { callback } : {}),
  text,
  at: new Date().toISOString()
}

const seen = join(inbox, 'seen', `${eventId}.json`)
if (existsSync(seen)) {
  console.log(JSON.stringify({ ok: true, skipped: 'ALREADY_SENT', event: eventId, ticket: ticketId }, undefined, 2))
  process.exit(0)
}
const pending = join(inbox, 'pending', `${eventId}.json`)
if (existsSync(pending)) {
  console.log(JSON.stringify({ ok: true, skipped: 'ALREADY_PENDING', event: eventId, ticket: ticketId }, undefined, 2))
  process.exit(0)
}

mkdirSync(join(inbox, 'pending'), { recursive: true })
writeFileSync(`${pending}.part`, `${JSON.stringify(event, undefined, 2)}\n`, 'utf8')
renameSync(`${pending}.part`, pending)
console.log(JSON.stringify({
  ok: true,
  event: eventId,
  ticket: ticketId,
  conversation,
  thread: originEvent,
  callback: callback ?? null,
  file: pending,
  waitsForPersonBefore: waitsForPerson
}, undefined, 2))
