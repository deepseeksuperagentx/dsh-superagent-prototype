#!/usr/bin/env node
/**
 * Project the orchestrator's tickets onto our own todo board, in one direction.
 *
 *   scripts/project-board.mjs [--db <stateDir>/orchestrator.sqlite] [--repo <workbench repo>] [--dry-run]
 *
 * The upstream `ticket` table is the source of truth for work items (see ADR-0009 in the workbench repo); the board is a
 * projection of it, so a ticket's work shows up on the same board, in the same git history and in the same cockpit as
 * everything else here. Only `ticket` is read — the other eight tables are the orchestrator's own business — and the board
 * is written only through that repo's single writer, `scripts/board.mjs#executeBoard`, so its own board gates keep holding.
 *
 * One ticket keeps one board row: the id mapping lives in this script's own key-value file, so re-running changes nothing.
 * A ticket that ended upstream waits for a person on the board (`review`) — the projector never accepts its own rows, and
 * it never writes a row back to SQLite. A row a person moved, closed or deleted stays where they put it.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// `node:sqlite` prints an experimental warning on first use, which would bury the projection's own report in a log.
process.removeAllListeners('warning')
process.on('warning', (warning) => { if (!/SQLite/.test(String(warning?.message))) console.error(String(warning?.message)) })

const usage = `Usage: project-board.mjs [--db <sqlite file>] [--repo <workbench repo>] [--data-root <path>] [--map <json file>] [--scene <id>] [--dry-run]
  Defaults: --db ~/my_dsh_data/state/superagent/orchestrator.sqlite (the profile's stateDir), --repo ~/my_dsh,
  --data-root ~/my_dsh_data, --scene superagent-ops, --map <data-root>/state/superagent-ops/projection.json.
  Exit codes: 0 the board matches the tickets · 1 the inputs are wrong · 2 a write to the board failed.`
const fail = (message) => { console.error(`${message}\n${usage}`); process.exit(1) }

const argv = process.argv.slice(2)
/** The option's next word, or undefined when the option is absent. */
const value = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv.at(at + 1) }
const OPTIONS = ['--db', '--repo', '--data-root', '--map', '--scene']
const FLAGS = ['--dry-run', '--help']
for (const arg of argv) if (arg.startsWith('--') && !OPTIONS.includes(arg) && !FLAGS.includes(arg)) fail(`Unknown option: ${arg}`)
if (argv.includes('--help')) { console.log(usage); process.exit(0) }

const home = homedir()
/** `~/x` and `~` are spelled out; an absolute path is taken as it stands. */
const expand = (path) => path === '~' ? home : path?.startsWith('~/') ? join(home, path.slice(2)) : path
const dataRoot = expand(value('--data-root')) ?? join(home, 'my_dsh_data')
const db = expand(value('--db')) ?? join(dataRoot, 'state/superagent/orchestrator.sqlite')
const repo = expand(value('--repo')) ?? join(home, 'my_dsh')
const scene = value('--scene') ?? 'superagent-ops'
const mapFile = expand(value('--map')) ?? join(dataRoot, `state/${scene}/projection.json`)
const dryRun = argv.includes('--dry-run')
if (!existsSync(db)) fail(`No orchestrator database at ${db}: point --db at the profile's stateDir`)
const boardWriter = join(repo, 'scripts/board.mjs')
if (!existsSync(boardWriter)) fail(`No board writer at ${boardWriter}: point --repo at the workbench repo`)
const sceneFile = join(dataRoot, 'scenes', `${scene}.json`)
if (!existsSync(sceneFile)) fail(`No scene at ${sceneFile}: the board's projection target must exist first`)

/** What a projected row waits for before it can leave the board: an acceptance verdict, by a machine or by a person. */
const ACCEPTANCE = '上游 worker 收工并回灌报告；验收结论落本行证据列（机器复核写「机器验收：」，三鑫拍板写「三鑫拍板：」）'
/** One table cell of text: no pipes, no line breaks, short enough to read on the board. */
const cell = (text) => String(text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 220)
/** The evidence a row points at: the ticket's own id, and the latest report its worker wrote back. */
const evidenceOf = (ticket) => {
  const report = ticket.assignments.findLast((item) => item.report)?.report
  const work = report ? `worker 报告 ${report.state} @${report.at}：${report.summary}` : 'worker 未回灌报告'
  const end = ticket.ended ? ` · ${ticket.ended.by} 于 ${ticket.ended.at} 收单（${ticket.ended.outcome}）：${ticket.ended.reason ?? '无说明'}` : ''
  return cell(`上游 ticket ${ticket.id} · ${work}${end}`)
}
/** The latest report a worker wrote back, if any. */
const latestReport = (ticket) => ticket.assignments.findLast((item) => item.report)?.report
/** Upstream to board state: a running assignment is doing; a worker asking for a person is blocked; an ended ticket waits for an acceptance. */
const stateOf = (ticket) => {
  if (ticket.ended) return ['dropped', 'stopped'].includes(ticket.ended.outcome) ? 'cancelled' : 'review'
  // A worker waiting for a person is not "doing": its session is still open, but it reported that it needs a decision.
  const report = latestReport(ticket)
  if (report && ['blocked', 'failed'].includes(report.state)) return 'blocked'
  if (ticket.assignments.some((item) => item.state === 'running')) return 'doing'
  return 'todo'
}

const source = new DatabaseSync(db, { readOnly: true })
const rows = source.prepare('SELECT value FROM ticket ORDER BY rowid').all().map((row) => row.value)
source.close()
/** A row this script cannot read is reported, never dropped quietly: a ticket vanishing from the board looks like a person deleted it. */
const malformed = []
const tickets = []
for (const [at, value] of rows.entries()) {
  let ticket
  try { ticket = JSON.parse(String(value)) } catch { malformed.push(`第 ${at + 1} 行不是 JSON`); continue }
  if (!ticket?.id || !ticket?.title || !Array.isArray(ticket.assignments)) { malformed.push(`${ticket?.id ?? `第 ${at + 1} 行`} 缺 id / 事项 / 派工`); continue }
  tickets.push(ticket)
}

/** The scene's primary harness panel: the projection speaks as that slice, which is what the board's gates allow. */
const panel = (JSON.parse(readFileSync(sceneFile, 'utf8')).panels ?? [])
  .find((item) => item?.type === 'harness' && item?.slice?.primary === true)?.id
if (!panel) fail(`Scene ${scene} has no primary harness panel; the projector cannot own its rows`)

/** This script's own key-value file: `ticket id → {boardId, state}`. It is the only state a projection keeps. */
const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : { version: 1, tickets: {} }
if (!map.tickets) map.tickets = {}
const saveMap = () => {
  if (dryRun) return
  mkdirSync(dirname(mapFile), { recursive: true })
  const temp = `${mapFile}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(map, undefined, 2)}\n`, 'utf8')
  renameSync(temp, mapFile)
}

const { executeBoard } = await import(pathToFileURL(boardWriter).href)
const { applyDigest, digestLine } = await import(pathToFileURL(join(repo, 'scripts/scene-memory.mjs')).href)
const outcomes = { added: [], moved: [], unchanged: [], kept: [], digested: [], failed: [] }
/** One writer call as the projection's own slice. A dry run answers without touching the board. */
const write = async (command, args = [], options = {}) => {
  if (dryRun) return { ok: true, taskId: 'T-DRYRUN' }
  return await executeBoard({ dataRoot, sceneId: scene, command, args, options: { panel, ...options } })
}
/** Record what the board actually holds now, so a half-done transition retries instead of looking like a person's edit. */
const settled = (ticketId, boardId, state) => { map.tickets[ticketId] = { ...map.tickets[ticketId], boardId, state, at: new Date().toISOString() } }

// The board is read once: a row in 已完成 has no state cell, so it is treated as the terminal state it got accepted into.
const listing = await executeBoard({ dataRoot, sceneId: scene, command: 'list' })
if (!listing.ok) fail(`Board ${scene} does not read clean: ${listing.errors.join('；')}`)
const onBoard = new Map([
  ...(listing.completed ?? []).map((row) => [row.id, { ...row, state: 'done' }]),
  ...(listing.tasks ?? []).map((row) => [row.id, row]),
])

/** The steps the board's own state machine allows from one state to another; a row never goes backwards on its own. */
const steps = (from, to, ticket) => {
  if (to === 'cancelled') return [['cancel', { reason: `上游 ${ticket.ended.outcome}：${ticket.ended.reason ?? '无说明'}`, now: ticket.ended.at }]]
  const path = []
  let at = from
  const report = latestReport(ticket)
  if (at === 'todo' && to === 'blocked' || at === 'doing' && to === 'blocked') {
    // 流 B 的入口：worker 说要人（blocked / failed），板上这一行挂起并点名三鑫。
    path.push(['block', { blockType: 'needs_input', needs: '三鑫', reason: `上游 worker 报告 ${report?.state ?? 'blocked'}：${cell(report?.summary ?? '')}`, now: ticket.updatedAt }])
    at = 'blocked'
  }
  if (at === 'todo' && ['doing', 'review'].includes(to)) { path.push(['start', { now: ticket.updatedAt }]); at = 'doing' }
  if (at === 'blocked' && ['doing', 'review'].includes(to)) {
    // The board only lets a blocked row go back to doing; a finished ticket therefore travels blocked → doing → review.
    path.push(['start', { now: ticket.updatedAt }]); at = 'doing'
  }
  if (at === 'doing' && to === 'review') path.push(['submit', { evidence: evidenceOf(ticket), now: ticket.ended?.at ?? ticket.updatedAt }])
  return path
}
/** Where a row stands after one of those steps. */
const landed = (command) => command === 'start' ? 'doing' : command === 'submit' ? 'review' : command === 'block' ? 'blocked' : 'cancelled'

for (const ticket of tickets) {
  const wanted = stateOf(ticket)
  const known = map.tickets[ticket.id]
  if (!known) {
    const added = await write('add', [], { text: cell(ticket.title), accept: ACCEPTANCE, now: ticket.createdAt, extra: { 执行面: 'dsh' } })
    if (!added.ok || !added.taskId) { outcomes.failed.push(`add ${ticket.id}：${(added.errors ?? ['没有返回任务 id']).join('；')}`); continue }
    settled(ticket.id, added.taskId, 'todo')
    let at = 'todo'
    for (const [command, options] of steps('todo', wanted, ticket)) {
      const result = await write(command, [added.taskId], options)
      if (!result.ok) { outcomes.failed.push(`${command} ${added.taskId}：${(result.errors ?? []).join('；')}`); break }
      at = landed(command)
      settled(ticket.id, added.taskId, at)
    }
    outcomes.added.push(`${added.taskId} ← ${ticket.id}（${at}）`)
    continue
  }

  const row = onBoard.get(known.boardId)
  if (!row) { outcomes.kept.push(`${known.boardId} ← ${ticket.id}：行已不在板上，不补建`); continue }
  if (['done', 'cancelled'].includes(row.state)) { outcomes.unchanged.push(`${known.boardId} ← ${ticket.id}（板上 ${row.state}，终态）`); continue }
  if (row.state !== known.state) { outcomes.kept.push(`${known.boardId} ← ${ticket.id}：板上被人改成 ${row.state}，投影不再动它`); settled(ticket.id, known.boardId, row.state); continue }
  if (row.state === wanted) { outcomes.unchanged.push(`${known.boardId} ← ${ticket.id}（${wanted}）`); continue }
  const path = steps(row.state, wanted, ticket)
  if (!path.length) { outcomes.kept.push(`${known.boardId} ← ${ticket.id}：${row.state} → ${wanted} 不是板上允许的一步，等人处理`); continue }
  const before = outcomes.failed.length
  let at = row.state
  for (const [command, options] of path) {
    const result = await write(command, [known.boardId], options)
    if (!result.ok) { outcomes.failed.push(`${command} ${known.boardId}：${(result.errors ?? []).join('；')}`); break }
    at = landed(command)
    settled(ticket.id, known.boardId, at)
  }
  if (outcomes.failed.length > before) continue
  outcomes.moved.push(`${known.boardId} ← ${ticket.id}：${row.state} → ${at}`)
}

// 收工摘要回写切片记忆：工单收工后把最新报告压成 §〇 里的一行，下一个会话开场就能读到；会话自己的交接字段不动。
// §〇 只留一条，所以多条同时收工时取报告时间最新的那一条，其余的不排队。
const memoryFile = join(dataRoot, 'memory', scene, `${panel}.md`)
if (existsSync(memoryFile)) {
  const candidates = tickets.flatMap((ticket) => {
    const known = map.tickets[ticket.id]
    if (!known || stateOf(ticket) !== 'review') return []
    const report = latestReport(ticket)
    const at = ticket.ended?.at ?? report?.at ?? ticket.updatedAt ?? ''
    const key = `${ticket.ended?.at ?? ''}|${report?.at ?? ''}|${report?.state ?? ''}|${ticket.ended?.outcome ?? ''}`
    return [{ ticket, known, report, at, key }]
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const latest = candidates[0]
  if (latest && latest.known.digest !== latest.key) {
    const line = digestLine({
      boardId: latest.known.boardId,
      title: latest.ticket.title,
      state: latest.report?.state ?? '未回灌',
      summary: latest.report?.summary ?? latest.ticket.ended?.reason ?? '',
      at: latest.at
    })
    const result = applyDigest(readFileSync(memoryFile, 'utf8'), line)
    if (!result.changed) {
      outcomes.kept.push(`记忆 ${latest.known.boardId}：${result.reason}`)
    } else {
      if (!dryRun) {
        const temp = `${memoryFile}.tmp-${process.pid}`
        writeFileSync(temp, result.markdown, 'utf8')
        renameSync(temp, memoryFile)
      }
      latest.known.digest = latest.key
      outcomes.digested.push(`${latest.known.boardId} ← ${latest.report?.state ?? '未回灌'}`)
    }
  }
}

saveMap()
const line = (label, items) => console.log(`${label} ${items.length}：${items.length ? items.join('；') : '无'}`)
console.log(`${dryRun ? 'DRY_RUN' : 'PROJECTED'} · ${scene} · 上游 ${tickets.length} 条工单 · 面板 ${panel}`)
line('新建', outcomes.added)
line('移动', outcomes.moved)
line('未变', outcomes.unchanged)
line('保留人的改动', outcomes.kept)
line('记忆回写', outcomes.digested)
line('读不懂的行', malformed)
line('失败', outcomes.failed)
process.exitCode = outcomes.failed.length || malformed.length ? 2 : 0
