#!/usr/bin/env node
/**
 * Give the in-flight board-bridge Triggers the reply callback they were never written with.
 *
 * `scripts/webhook-receipt.mjs` is the local callback every event of this machine posts its replies to, and
 * `scripts/superagent-event.mjs` / `~/my_dsh/scripts/bridge-ticket.mjs` put that URL on the events they send. An event
 * that settled before the bridge put a callback on it cannot receive a reply: the webhook Source answers `gone` and the
 * outbox records it as `dropped` (`channelGone`) instead of delivering it to the receipt ledger. That is history for an
 * ended ticket, but a ticket still running will report later and its result would be dropped the same way.
 *
 * This program is that one-time repair: for every open ticket whose origin is a board-bridge Trigger whose channel carries
 * no callback, it writes the callback from `webhook-reply.json` into that Trigger's channel, and records what it changed in
 * a journal so `--undo` restores the exact earlier address. The engine reads each Trigger from SQLite on use, so the next
 * reply to those tickets goes through the receipt receiver without an engine restart.
 *
 *   node scripts/webhook-callback-repair.mjs [--data-root <path>] [--db <orchestrator.sqlite>] [--config <webhook-reply.json>]
 *                                            [--apply] [--undo] [--json]
 *
 * Default: dry-run — it prints what it would change and writes nothing. `--apply` writes the repair and the journal; `--undo`
 * removes the callback from exactly the Triggers the journal lists (a callback someone else put there is left alone).
 * The engine keeps its own tables; this program touches only `trigger` and only that one field, one transaction per run.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// `node:sqlite` prints an experimental warning on first use, which would bury this program's own report in a log.
process.removeAllListeners('warning')
process.on('warning', (warning) => { if (!/SQLite/.test(String(warning?.message))) console.error(String(warning?.message)) })

const usage = `Usage: webhook-callback-repair.mjs [--data-root <path>] [--db <sqlite>] [--config <webhook-reply.json>]
         [--apply | --undo] [--json]
  Defaults: --data-root ~/my_dsh_data, --db <data-root>/state/superagent/orchestrator.sqlite,
  --config <data-root>/state/superagent/webhook-reply.json, journal <data-root>/state/superagent/webhook-callback-repair.json.
  Exit codes: 0 the repair is (or already was) in place · 1 the inputs are wrong · 2 a write failed.`
const fail = (message) => { console.error(`${message}\n${usage}`); process.exit(1) }

const argv = process.argv.slice(2)
/** The option's next word, or undefined when the option is absent. */
const value = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv.at(at + 1) }
const OPTIONS = ['--data-root', '--db', '--config']
const FLAGS = ['--apply', '--undo', '--json', '--help']
for (const arg of argv) if (arg.startsWith('--') && !OPTIONS.includes(arg) && !FLAGS.includes(arg)) fail(`Unknown option: ${arg}`)
if (argv.includes('--help')) { console.log(usage); process.exit(0) }
const applyMode = argv.includes('--apply')
const undoMode = argv.includes('--undo')
if (applyMode && undoMode) fail('--apply 与 --undo 不能同时给')
const dryRun = !applyMode && !undoMode
const jsonMode = argv.includes('--json')

/** `~/x` and `~` are spelled out; an absolute path is taken as it stands. */
const expand = (path) => path === '~' ? homedir() : path?.startsWith('~/') ? join(homedir(), path.slice(2)) : path
const dataRoot = expand(value('--data-root')) ?? join(homedir(), 'my_dsh_data')
const dbFile = expand(value('--db')) ?? join(dataRoot, 'state/superagent/orchestrator.sqlite')
const configFile = expand(value('--config')) ?? join(dataRoot, 'state/superagent/webhook-reply.json')
const journalFile = join(dirname(dbFile), 'webhook-callback-repair.json')
if (!existsSync(dbFile)) fail(`No orchestrator database at ${dbFile}`)
if (!existsSync(configFile)) fail(`No reply config at ${configFile}: nothing to write into the Triggers`)

let config
try { config = JSON.parse(readFileSync(configFile, 'utf8')) } catch (error) { fail(`${configFile} is not JSON: ${error}`) }
const callback = typeof config?.url === 'string' && config.url ? config.url : undefined
if (!callback) fail(`${configFile} has no url: name the receiver's callback first`)
try { new URL(callback) } catch { fail(`${configFile} url is not a URL: ${callback}`) }

const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout=5000')
const saveJournal = (value) => {
  const temp = `${journalFile}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  renameSync(temp, journalFile)
}
const readJournal = () => { try { return JSON.parse(readFileSync(journalFile, 'utf8')) } catch { return undefined } }

/** The board bridge is the sender whose events the bridge writes; the repair only touches those. */
const BOARD_BRIDGE = 'board-bridge'
/** One Trigger's channel has the callback when its address carries exactly the receiver's URL. */
const hasCallback = (trigger) => trigger?.channel?.address?.callback === callback
/** A ticket is open until it carries `ended`; only open tickets can still answer. */
const open = (ticket) => ticket && typeof ticket === 'object' && ticket.ended === undefined

/** Reads every Trigger, its sender and the open tickets that name it as origin. */
function survey() {
  const triggers = db.prepare('SELECT id, value FROM trigger').all().map((row) => ({ id: String(row.id), trigger: JSON.parse(String(row.value)) }))
  const tickets = db.prepare('SELECT value FROM ticket').all().map((row) => JSON.parse(String(row.value))).filter(open)
  const originIds = new Set(tickets.map((ticket) => ticket?.origin?.triggerId).filter(Boolean))
  const matching = triggers.filter(({ trigger }) => trigger?.source === 'webhook'
    && trigger?.channel?.address && trigger.channel.address.sender === BOARD_BRIDGE
    && !hasCallback(trigger) && originIds.has(trigger.id))
  const already = triggers.filter(({ trigger }) => trigger?.source === 'webhook'
    && trigger?.channel?.address?.sender === BOARD_BRIDGE && hasCallback(trigger) && originIds.has(trigger.id))
  return { triggers: triggers.length, openTickets: tickets.length, matching, already }
}

/** Writes the callback into each Trigger's channel, keeping every other field of the Trigger as it was. */
function applyRepair(matching) {
  const changed = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const { id, trigger } of matching) {
      const before = trigger.channel.address
      trigger.channel.address = { ...before, callback }
      db.prepare('UPDATE trigger SET value=? WHERE id=?').run(JSON.stringify(trigger), id)
      changed.push({ id, at: trigger.at, previous: before })
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
    throw error
  }
  const journal = readJournal() ?? { version: 1, at: new Date().toISOString(), url: callback, triggers: [] }
  const known = new Set(journal.triggers.map((entry) => entry.id))
  journal.url = callback
  journal.at = new Date().toISOString()
  for (const entry of changed) if (!known.has(entry.id)) journal.triggers.push(entry)
  saveJournal(journal)
  return changed
}

/** Removes the callback from exactly the Triggers the journal recorded, restoring their earlier address. */
function undoRepair() {
  const journal = readJournal()
  if (!journal) fail(`No repair journal at ${journalFile}: nothing recorded to undo`)
  const entries = new Map((journal.triggers ?? []).map((entry) => [entry.id, entry]))
  const restored = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const entry of entries.values()) {
      const row = db.prepare('SELECT value FROM trigger WHERE id=?').get(entry.id)
      if (!row) continue
      const trigger = JSON.parse(String(row.value))
      // Leave a callback that someone else wrote or that another repair wrote: only the journaled one is removed.
      if (trigger?.channel?.address?.callback !== journal.url) continue
      trigger.channel.address = entry.previous
      db.prepare('UPDATE trigger SET value=? WHERE id=?').run(JSON.stringify(trigger), entry.id)
      restored.push(entry.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
    throw error
  }
  for (const id of restored) entries.delete(id)
  saveJournal({ ...journal, at: new Date().toISOString(), triggers: [...entries.values()] })
  return restored
}

const result = { mode: applyMode ? 'apply' : undoMode ? 'undo' : 'dry-run', callback, db: dbFile, config: configFile, journal: journalFile }
let exitCode = 0
try {
  if (undoMode) {
    const before = survey()
    result.restored = undoRepair()
    result.before = { boardBridgeMatching: before.matching.length }
  } else {
    const before = survey()
    result.before = { triggers: before.triggers, openTickets: before.openTickets, boardBridgeMissingCallback: before.matching.length,
      boardBridgeWithCallback: before.already.length }
    result.matching = before.matching.map(({ id, trigger }) => ({ id, at: trigger.at,
      event: trigger.channel?.address?.event, conversation: trigger.channel?.address?.conversation }))
    if (applyMode && before.matching.length) result.updated = applyRepair(before.matching)
    const after = survey()
    result.after = { boardBridgeMissingCallback: after.matching.length, boardBridgeWithCallback: after.already.length }
  }
} catch (error) {
  result.error = String(error?.message ?? error)
  exitCode = 2
} finally {
  db.close()
}

if (jsonMode) console.log(JSON.stringify(result, undefined, 2))
else if (result.error) console.error(`REPAIR_FAILED · ${result.error}`)
else if (undoMode) console.log(`REPAIR_UNDONE · 还原 ${result.restored.length} 条 trigger · journal ${journalFile}`)
else {
  const before = result.before
  console.log(`REPAIR_${dryRun ? 'DRY_RUN' : 'OK'} · callback ${callback} · 开着的工单 ${before.openTickets} 条 · 桥 trigger 缺回调 ${before.boardBridgeMissingCallback} 条`)
  for (const item of result.matching ?? []) console.log(`  ${item.id} · ${item.conversation}/${item.event}`)
  if (!dryRun) console.log(`  写入 ${(result.updated ?? []).length} 条 · 复核后仍缺 ${result.after.boardBridgeMissingCallback} 条`)
}
process.exitCode = exitCode
