#!/usr/bin/env node
/**
 * Land every reply the engine sends to a webhook event on this machine, in one local file and on the workbench board.
 *
 * The webhook Source answers an event on the callback URL that event carried (src/sources/webhook.ts#sendWebhook); a machine
 * event used to have no callback at all, so its replies settled as `dropped` (`channelGone`) and nothing kept them. This
 * program is that callback: senders put its URL on each event (scripts/superagent-event.mjs and
 * scripts/superagent-reply.mjs read it from the same config file, `webhook-reply.json`), the engine POSTs each reply here,
 * and it is written as one JSONL line, then projected onto the board as one of its own rows.
 *
 *   node scripts/webhook-receipt.mjs [--data-root <path>] [--config <file>] [--file <jsonl>] [--map <json>]
 *                                    [--repo <workbench repo>] [--scene <id>] [--host <host>] [--port <port>]
 *                                    [--no-board] [--status] [--backfill]
 *
 * The body the engine posts is `{key, conversation, event, kind, ticket?, text}` (src/sources/webhook.ts), where `key` is
 * the outbox message id: the same reply posted twice is one line, one board row. The file is the record; the board row is
 * derived from it, so a board write that fails is retried by the daemon instead of telling the engine to send again.
 *
 * Board rows go through the workbench repo's single writer, `scripts/board.mjs#executeBoard`, as the scene's primary
 * harness panel — the same gate the ticket projector (scripts/project-board.mjs) writes through. One reply is one row,
 * labelled `回执 · …`, and is closed by the machine into 已完成 with the JSONL pointer as its evidence: a receipt is a
 * record, not work, so it never sits in 任务 waiting for a person. The projector's own ticket rows are untouched.
 *
 * Modes: no mode starts the receiver; `--status` prints what the ledger and the board map hold; `--backfill` imports the
 * webhook replies the outbox already dropped (`status: dropped`, `reason: channelGone`) into the same JSONL, with their
 * original drop time and without board rows (see below).
 */
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const usage = `Usage: webhook-receipt.mjs [--data-root <path>] [--config <webhook-reply.json>] [--file <receipts.jsonl>]
         [--map <board.json>] [--repo <workbench repo>] [--scene <sceneId>] [--db <orchestrator.sqlite>]
         [--host <host>] [--port <port>] [--no-board] [--status] [--backfill [--force]]
  Defaults: --data-root ~/my_dsh_data, --config <data-root>/state/superagent/webhook-reply.json (its "url" is the callback
  senders put on events, its "listen" the address to bind), --file <data-root>/state/superagent/receipts/receipts.jsonl,
  --map <data-root>/state/superagent/receipts/board.json, --repo ~/my_dsh, --scene superagent-ops.
  Exit codes: 0 fine · 1 the inputs are wrong · 2 a mode failed.`

const fail = (message) => { console.error(`${message}\n${usage}`); process.exit(1) }

const argv = process.argv.slice(2)
/** The option's next word, or undefined when the option is absent. */
const value = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv.at(at + 1) }
const has = (name) => argv.includes(name)
const OPTIONS = ['--data-root', '--config', '--file', '--map', '--repo', '--scene', '--db', '--host', '--port']
const FLAGS = ['--no-board', '--status', '--backfill', '--force', '--help']
for (const arg of argv) if (arg.startsWith('--') && !OPTIONS.includes(arg) && !FLAGS.includes(arg)) fail(`Unknown option: ${arg}`)
if (has('--help')) { console.log(usage); process.exit(0) }

/** `~/x` and `~` are spelled out; an absolute path is taken as it stands. */
const expand = (path) => path === '~' ? homedir() : path?.startsWith('~/') ? join(homedir(), path.slice(2)) : path
const dataRoot = expand(value('--data-root')) ?? join(homedir(), 'my_dsh_data')
const configFile = expand(value('--config')) ?? join(dataRoot, 'state/superagent/webhook-reply.json')
const ledgerFile = expand(value('--file')) ?? join(dataRoot, 'state/superagent/receipts/receipts.jsonl')
const mapFile = expand(value('--map')) ?? join(dataRoot, 'state/superagent/receipts/board.json')
const repo = expand(value('--repo')) ?? join(homedir(), 'my_dsh')
const scene = value('--scene') ?? 'superagent-ops'
const dbFile = expand(value('--db')) ?? join(dataRoot, 'state/superagent/orchestrator.sqlite')
const backfillMode = has('--backfill')
const statusMode = has('--status')

/** What the sender config says; a missing file is the plain defaults, a malformed one is worth stopping for. */
let config = {}
if (existsSync(configFile)) {
  try { config = JSON.parse(readFileSync(configFile, 'utf8')) }
  catch (error) { fail(`${configFile} is not JSON: ${error}`) }
  if (!config || typeof config !== 'object') fail(`${configFile} must hold one JSON object`)
}
const host = value('--host') ?? (typeof config.listen?.host === 'string' ? config.listen.host : '127.0.0.1')
const port = Number(value('--port') ?? config.listen?.port ?? 3083)
if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`Bad --port: ${value('--port') ?? config.listen?.port}`)
const callbackUrl = typeof config.url === 'string' && config.url ? config.url : `http://${host}:${port}/receipt`
/** The ledger's own path, as the board's evidence column spells it: relative to the data root, which is stable. */
const ledgerLabel = relative(dataRoot, ledgerFile) || ledgerFile
/** The receiver's own pid while it runs: the one-shot modes read and write the same files, so they must not run beside it. */
const pidFile = join(dirname(mapFile), 'receiver.pid')
const boardEnabled = !has('--no-board') && config.board !== false

const KINDS = { acknowledgement: '确认', reply: '回复', notice: '通知' }
/** Engine-side limits: a reply text is at most 20 000 characters, and no board cell should carry that much. */
const MAX_TEXT = 20_000
const MAX_SNIPPET = 400
const MAX_EVIDENCE = 480
const MAX_BODY = 256 * 1024
const RETRY_MS = 60_000
const MAX_ATTEMPTS = 5
/** What a reply row waits for before it can leave the board; the machine closes its own record, so nothing waits. */
const ACCEPTANCE = '本机文件已收到这条回执（回执是记录，不是活，机器记录后直接收口）'

/** One cell of board text: no pipes, no line breaks, short enough to read on the board. */
const cell = (text, limit) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The ledger is the record: its keys are the idempotency index, so a restarted daemon never writes a reply twice.
/** key → {line, at} for every line already in the JSONL. */
const ledgerIndex = new Map()
let ledgerLines = 0
if (existsSync(ledgerFile)) {
  for (const line of readFileSync(ledgerFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    ledgerLines += 1
    try {
      const entry = JSON.parse(line)
      if (entry?.key) ledgerIndex.set(String(entry.key), { line: ledgerLines, at: entry.at })
    } catch { /* A line another program mangled is not read back as an index; the file still holds it. */ }
  }
}
/** The board side of the loop: one entry per received key, `boardId`/`state` what the board holds, `skipped` why not. */
const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : { version: 1, keys: {} }
if (!map.keys || typeof map.keys !== 'object') map.keys = {}
const saveMap = () => {
  mkdirSync(dirname(mapFile), { recursive: true })
  const temp = `${mapFile}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(map, undefined, 2)}\n`, 'utf8')
  renameSync(temp, mapFile)
}
const appendReceipt = (receipt) => {
  mkdirSync(dirname(ledgerFile), { recursive: true })
  appendFileSync(ledgerFile, `${JSON.stringify(receipt)}\n`, 'utf8')
  ledgerLines += 1
  ledgerIndex.set(receipt.key, { line: ledgerLines, at: receipt.at })
  return ledgerLines
}

// The board is written only through the workbench repo's single writer, as the scene's primary harness panel, exactly as
// the ticket projector does — its own board gates stay in force.
/** The scene's primary harness panel, which owns the rows this program creates; null turns the board side off. */
let panel = null
if (boardEnabled) {
  const sceneFile = join(dataRoot, 'scenes', `${scene}.json`)
  if (!existsSync(sceneFile)) console.error(`board off: no scene at ${sceneFile}`)
  else panel = (JSON.parse(readFileSync(sceneFile, 'utf8')).panels ?? [])
    .find((item) => item?.type === 'harness' && item?.slice?.primary === true)?.id ?? null
  if (!panel) console.error(`board off: scene ${scene} has no primary harness panel`)
}
let boardWrite = null
/** One writer call as this program's slice; a board still held by the projector is waited out, not failed. */
async function writeBoard(command, args = [], options = {}) {
  if (!boardWrite) {
    const writer = join(repo, 'scripts/board.mjs')
    if (!existsSync(writer)) throw new Error(`no board writer at ${writer}: point --repo at the workbench repo`)
    const { executeBoard } = await import(pathToFileURL(writer).href)
    boardWrite = async (name, list, extra) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await executeBoard({ dataRoot, sceneId: scene, command: name, args: list,
          options: { panel, ...extra } })
        if (result.ok || !(result.errors ?? []).some((error) => String(error).includes('锁定'))) return result
        if (attempt < 2) await sleep(500 * (attempt + 1))
      }
      return { ok: false, errors: ['场景板持续被锁定'] }
    }
  }
  return await boardWrite(command, args, options)
}

/** The board row a receipt becomes: the file pointer and the whole reply text, in the evidence cell. */
const rowText = (entry) => cell(`回执 · ${KINDS[entry.kind] ?? entry.kind} · ${entry.conversation}/${cell(entry.event, 8)}`
  + `${entry.ticket ? ` · 工单 ${cell(entry.ticket, 8)}` : ''}｜${entry.snippet}`, 220)
const rowEvidence = (entry) => cell(`回执落盘：${ledgerLabel}#L${entry.line}｜${entry.at}｜kind ${entry.kind}｜消息 ${entry.key}`
  + `｜来源 webhook:${entry.conversation}/${entry.event}${entry.ticket ? `｜工单 ${entry.ticket}` : ''}｜正文：${entry.snippet}`, MAX_EVIDENCE)

/** Records why the board side of one receipt did not finish, and stops retrying a receipt the board keeps refusing. */
function recordFailure(entry, errors) {
  entry.errors = (errors ?? []).map(String)
  entry.attempts = (entry.attempts ?? 0) + 1
  if (entry.attempts >= MAX_ATTEMPTS) {
    entry.skipped = `board: ${entry.errors.join('；') || 'no reason given'}`
    console.error(`SKIPPED ${entry.line} after ${entry.attempts} attempts: ${entry.skipped}`)
  }
  saveMap()
  return { ok: false, errors: entry.errors, boardId: entry.boardId ?? null, state: entry.state ?? null }
}

/** Moves one receipt's board row from wherever the board holds it to 已完成; safe to call again after a failure. */
async function advance(entry) {
  if (entry.done) return { ok: true, boardId: entry.boardId, state: entry.state, duplicate: true }
  if (entry.skipped) return { ok: false, skipped: entry.skipped, boardId: entry.boardId ?? null, state: entry.state ?? null }
  if (!panel) { entry.skipped = 'board off'; saveMap(); return { ok: false, skipped: entry.skipped } }
  try {
    if (!entry.boardId) {
      const added = await writeBoard('add', [], { text: rowText(entry), accept: ACCEPTANCE, evidence: rowEvidence(entry),
        now: entry.at, extra: { 执行面: 'dsh' } })
      if (!added.ok || !added.taskId) return recordFailure(entry, added.errors ?? ['add did not return a task id'])
      entry.boardId = added.taskId
      entry.state = 'todo'
      entry.errors = []
      saveMap()
    }
    // The board's own path for a row the machine owns: claim it, then submit its evidence, then accept it.
    const steps = [['claim', 'doing'], ['submit', 'review'], ['accept', 'done']]
    const rank = { todo: 0, doing: 1, review: 2, done: 3 }
    for (const [command, next] of steps) {
      if ((rank[entry.state] ?? 0) >= rank[next]) continue
      const options = { now: entry.at, ...(command === 'submit' ? { evidence: rowEvidence(entry) } : {}) }
      const result = await writeBoard(command, [entry.boardId], options)
      if (!result.ok) return recordFailure(entry, result.errors ?? [`${command} failed`])
      entry.state = next
      saveMap()
    }
    entry.done = true
    saveMap()
    return { ok: true, boardId: entry.boardId, state: entry.state }
  } catch (error) {
    return recordFailure(entry, [String(error?.message ?? error)])
  }
}

/** One receipt as the engine posts it: `key` is the outbox message id, so the same reply twice is one record. */
function normalize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('the body must be one JSON object')
  if (typeof body.key !== 'string' || !body.key.trim()) throw new Error('missing key (the outbox message id)')
  if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('missing text')
  if (body.text.length > MAX_TEXT) throw new Error(`text longer than ${MAX_TEXT} characters`)
  if (typeof body.conversation !== 'string' || !body.conversation.trim()) throw new Error('missing conversation')
  if (typeof body.event !== 'string' || !body.event.trim()) throw new Error('missing event')
  const at = new Date().toISOString()
  return {
    at,
    thread: `webhook:${body.conversation.trim()}/${body.event.trim()}`,
    ...(typeof body.ticket === 'string' && body.ticket.trim() ? { ticket: body.ticket.trim() } : {}),
    key: body.key.trim(),
    kind: typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim().slice(0, 40) : 'unknown',
    conversation: body.conversation.trim(),
    event: body.event.trim(),
    source: 'webhook',
    text: body.text
  }
}
/** What the board side needs to know about one receipt, kept so a retry after a restart has everything but the long text. */
const entryOf = (receipt, line) => ({
  key: receipt.key, at: receipt.at, line, kind: receipt.kind, conversation: receipt.conversation, event: receipt.event,
  ...(receipt.ticket ? { ticket: receipt.ticket } : {}), snippet: cell(receipt.text, MAX_SNIPPET),
  boardId: null, state: null, done: false, attempts: 0, errors: []
})

/** The one path a posted reply takes: the JSONL line, then the board row derived from it. */
async function receive(body) {
  let receipt
  try { receipt = normalize(body) } catch (error) { return { status: 400, body: { ok: false, error: error.message } } }
  const known = map.keys[receipt.key]
  if (known?.done || known?.skipped) {
    return { status: 200, body: { ok: true, duplicate: true, key: receipt.key, line: known.line,
      board: known.boardId ?? null, reason: known.skipped ?? 'recorded' } }
  }
  let entry = known
  const onFile = ledgerIndex.get(receipt.key)
  if (!onFile) {
    // The file does not know this key yet, or lost the line the map remembers: the receipt is written (again) and any board
    // progress the map already holds is kept, so a lost line cannot duplicate its board row.
    const line = appendReceipt(receipt)
    entry = known ? { ...known, line } : entryOf(receipt, line)
    map.keys[receipt.key] = entry
    saveMap()
  } else if (!entry) {
    // A crash between the file append and the map write: the file is the record, so the entry is rebuilt around it.
    entry = entryOf(receipt, onFile.line)
    entry.at = onFile.at ?? entry.at
    map.keys[receipt.key] = entry
    saveMap()
  } else if (entry.line !== onFile.line) {
    entry.line = onFile.line
    saveMap()
  }
  const board = await advance(entry)
  console.log(`RECEIPT ${receipt.at} ${receipt.kind}${entry.ticket ? ` ticket=${entry.ticket}` : ''}`
    + ` line=${entry.line}${board.boardId ? ` board=${board.boardId}:${board.state}` : ''}`
    + `${board.ok ? '' : ` boardPENDING=${board.errors?.join('；') ?? board.skipped ?? ''}`}`)
  return { status: 200, body: { ok: true, duplicate: false, key: receipt.key, line: entry.line,
    board: entry.boardId ?? null, state: entry.state, ...(board.ok ? {} : { boardPending: board.errors ?? [board.skipped] }) } }
}

// Requests are handled one at a time: the ledger, the map and the scene board are each written in order, and a filesystem
// write interleaved with another would be the only race this program could have.
let queue = Promise.resolve()
const enqueue = (run) => {
  const next = queue.then(run, run)
  queue = next.then(() => {}, () => {})
  return next
}
const json = (res, status, body) => {
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) { reject(new Error(`body larger than ${MAX_BODY} bytes`)); req.destroy() }
    else chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const counts = () => {
  const entries = Object.values(map.keys)
  return {
    recorded: entries.length,
    onBoard: entries.filter((entry) => entry.done).length,
    waitingForBoard: entries.filter((entry) => !entry.done && !entry.skipped).length,
    skipped: entries.filter((entry) => entry.skipped).length
  }
}
const startedAt = new Date().toISOString()
const health = () => ({ ok: true, pid: process.pid, startedAt, callbackUrl, listen: { host, port }, configFile,
  ledger: { file: ledgerFile, lines: ledgerLines }, board: { enabled: Boolean(panel), scene, panel }, ...counts() })

/** `--status`: what the receiver has recorded, without starting it. */
function printStatus() {
  console.log(JSON.stringify({ ...health(), lastReceiptAt: [...ledgerIndex.values()].at(-1)?.at ?? null }, undefined, 2))
}
/** `--backfill`: the webhook replies the outbox already dropped, in their original order and with their own time. */
async function backfill() {
  if (!existsSync(dbFile)) fail(`No orchestrator database at ${dbFile}`)
  // The running receiver holds both files in memory; a second writer would drop its next save, so one writer at a time.
  if (!has('--force') && existsSync(pidFile)) {
    const running = Number(readFileSync(pidFile, 'utf8'))
    let alive = false
    try { if (Number.isInteger(running) && running > 0) { process.kill(running, 0); alive = true } } catch {}
    if (alive) fail(`The receiver runs as pid ${running} and owns ${mapFile}; stop it (or pass --force) before --backfill`)
  }
  process.removeAllListeners('warning')
  process.on('warning', (warning) => { if (!/SQLite/.test(String(warning?.message))) console.error(String(warning?.message)) })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const rows = db.prepare('SELECT id, value FROM outbox ORDER BY rowid').all()
  db.close()
  let imported = 0, skipped = 0, unreadable = 0
  for (const row of rows) {
    let message
    try { message = JSON.parse(String(row.value)) } catch { unreadable += 1; continue }
    if (message?.channel?.source !== 'webhook' || message?.status !== 'dropped') continue
    const at = message.dropped?.at
    if (typeof at !== 'string' || !at) { unreadable += 1; continue }
    if (ledgerIndex.has(row.id) || map.keys[row.id]) { skipped += 1; continue }
    const conversation = message.channel.address?.conversation
    const event = message.channel.address?.event
    if (!conversation || !event || typeof message.text !== 'string') { unreadable += 1; continue }
    const receipt = {
      at,
      recordedAt: new Date().toISOString(),
      backfill: true,
      dropped: message.dropped?.reason ?? 'dropped',
      thread: message.channel.thread ?? `webhook:${conversation}/${event}`,
      ...(message.ticketId ? { ticket: message.ticketId } : {}),
      key: row.id,
      kind: message.kind ?? 'unknown',
      conversation,
      event,
      source: 'webhook',
      text: message.text
    }
    const line = appendReceipt(receipt)
    // History lands in the file only: those replies belong to tickets whose board rows already tell their story, and ten
    // past receipts as board rows would claim space in 已完成 without anyone able to act on them.
    map.keys[receipt.key] = { ...entryOf(receipt, line), skipped: 'history backfill (file only)' }
    imported += 1
    console.log(`+ ${at} ${receipt.kind}${receipt.ticket ? ` ticket=${receipt.ticket}` : ''} line=${line}`)
  }
  saveMap()
  console.log(JSON.stringify({ ok: true, imported, skipped, unreadable, ledger: ledgerFile, lines: ledgerLines,
    board: 'history kept out of the board on purpose' }, undefined, 2))
  process.exitCode = unreadable ? 2 : 0
}

if (statusMode) { printStatus(); process.exit(0) }
if (backfillMode) { await backfill(); process.exit(process.exitCode ?? 0) }

// The daemon: one callback URL, one receipt file, one board row per reply.
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`)
  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) return json(res, 200, health())
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST a receipt body; GET /health reads state' })
    if (!['/receipt', '/', '/callback'].includes(url.pathname)) {
      return json(res, 404, { ok: false, error: `unknown path ${url.pathname}` })
    }
    const raw = await readBody(req)
    let body
    try { body = JSON.parse(raw) } catch { return json(res, 400, { ok: false, error: 'the body is not JSON' }) }
    const answer = await enqueue(() => receive(body))
    json(res, answer.status, answer.body)
  } catch (error) {
    json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
})
server.on('error', (error) => { console.error(`RECEIVER failed to listen on ${host}:${port}: ${error}`); process.exit(2) })
server.listen(port, host, () => {
  mkdirSync(dirname(pidFile), { recursive: true })
  writeFileSync(pidFile, String(process.pid), 'utf8')
  const state = counts()
  console.log(`RECEIVER ${callbackUrl} · ${scene}/${panel ?? '-'} · ledger ${ledgerFile} (${ledgerLines} lines)`
    + ` · recorded ${state.recorded}, on board ${state.onBoard}, waiting ${state.waitingForBoard}, skipped ${state.skipped}`)
  const expected = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  if (!callbackUrl.startsWith(expected)) {
    console.error(`WARN ${configFile} "url" is ${callbackUrl} but this process listens on ${expected}: senders would post elsewhere`)
  }
  if (configFile && !existsSync(configFile)) {
    console.error(`WARN no ${configFile}: senders put no callback on events until it exists, so replies stay dropped`)
  }
})

/** A pending board write finishes before the process leaves; the engine treats an unanswered POST as a retry. */
let stopping = false
const stop = async (signal) => {
  if (stopping) return
  stopping = true
  console.log(`STOP ${signal}`)
  server.close()
  rmSync(pidFile, { force: true })
  await queue.catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => { void stop('SIGINT') })
process.on('SIGTERM', () => { void stop('SIGTERM') })

// A receipt whose board row failed is retried here, not by the engine: the reply is already safe in the file, and asking the
// engine to send it again would only duplicate it on the sender's side once it succeeds.
setInterval(() => {
  if (stopping) return
  void enqueue(async () => {
    for (const [key, entry] of Object.entries(map.keys)) {
      if (entry.done || entry.skipped) continue
      const result = await advance(entry)
      if (result.ok) console.log(`RETRY ${key} → ${entry.boardId}:${entry.state}`)
    }
  })
}, RETRY_MS).unref()
