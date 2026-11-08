#!/usr/bin/env node
/**
 * inbox-guard.mjs — 递归派单禁令的「收件侧」护栏（2026-11-08 三鑫定）。
 *
 * 规则：会话（含代发）可以给 superagent 派单；**superagent 自己的 agent（worker / executor）不得给 superagent 派单**。
 *
 * 三道门：
 *   ① 发送侧：scripts/superagent-event.mjs 直接拒发 --origin-kind worker / 命中 superagent 会话 id 的事件
 *   ② 收件侧：本脚本盯 <inbox>/pending/，发现 origin.kind=worker 或 origin.session 属于 superagent 自己管的会话，
 *      立刻移出 pending → rejected/（附 .reason.txt），不给引擎读到
 *   ③ 规范侧：prompts/work.md 写明禁止；worker 工具集里本来就没有「给别人派活」的工具，只剩 shell 这条路，本脚本堵它
 *
 * 用法:
 *   node inbox-guard.mjs --once                 # 扫一遍就退（可进 cron / 手动）
 *   node inbox-guard.mjs --watch [--interval 1] # 常驻，每 N 秒扫一遍（launchd 用这个）
 *
 * 为什么还要「常驻」：引擎 15 秒轮询一次收件箱；只有比它更快才能抢在前面把违规事件挪走。
 * 这不是铁墙——直接手写 JSON 塞进 pending 且不带 origin 字段的伪造件挡不住（引擎侧才会真正校验），
 * 残余风险写在 docs/adr/0012-递归派单禁令.md「残余风险」一节。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// 归属判定的唯一实现（与 scripts/superagent-event.mjs 共用，口径见文件头注释）。
import { ownedBySuperagent } from './origin-ownership.mjs'

const argv = process.argv.slice(2)
const value = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv.at(at + 1) }
const once = argv.includes('--once')
const watch = argv.includes('--watch')
const interval = Number(value('--interval') ?? 1)
const dataRoot = value('--data-root') ?? join(homedir(), 'my_dsh_data')
const inbox = value('--inbox') ?? join(dataRoot, 'state', 'superagent', 'webhook-inbox')
const pending = join(inbox, 'pending')
const rejected = join(inbox, 'rejected')
const auditFile = join(dataRoot, 'state', 'superagent', 'event-audit.jsonl')
if (!once && !watch) { console.error('用法: node inbox-guard.mjs --once | --watch [--interval 1]'); process.exit(2) }

const ownedCache = new Map()
/** 会话 id 是否属于 superagent 自己管的会话（带缓存；判定口径在 scripts/origin-ownership.mjs）。 */
function isOwnedBySuperagent(sessionId) {
  if (!sessionId) return false
  if (ownedCache.has(sessionId)) return ownedCache.get(sessionId)
  const owned = ownedBySuperagent(sessionId, dataRoot)
  ownedCache.set(sessionId, owned)
  return owned
}

function audit(entry) {
  mkdirSync(join(dataRoot, 'state', 'superagent'), { recursive: true })
  appendFileSync(auditFile, `${JSON.stringify(entry)}\n`)
}

function sweep() {
  if (!existsSync(pending)) return 0
  let moved = 0
  for (const name of readdirSync(pending)) {
    if (!name.endsWith('.json')) continue
    const file = join(pending, name)
    let event
    try { event = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    // 引擎 EventSchema 只收扁平标量 meta，所以来源是 meta['origin.kind'] / meta['origin.session']；
    // 同时兼容早期写成嵌套对象 meta.origin 的事件（会被引擎打回 bad/，这里兜底能拦就直接拦）。
    const meta = event?.meta ?? {}
    const origin = meta.origin && typeof meta.origin === 'object' ? meta.origin : null
    const kind = origin?.kind ?? meta['origin.kind']
    const session = origin?.session ?? meta['origin.session']
    let reason
    if (kind === 'worker') reason = 'origin.kind=worker：superagent 的 agent 不得给 superagent 派单（防递归）'
    else if (session && isOwnedBySuperagent(session)) reason = `origin.session=${session} 属于 superagent 自己管的会话（防递归）`
    if (!reason) continue
    mkdirSync(rejected, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(rejected, `${name.replace(/\.json$/, '')}-${stamp}.json`)
    renameSync(file, target)
    writeFileSync(`${target}.reason.txt`, `${reason}\nquarantinedAt=${new Date().toISOString()}\n`)
    audit({ at: new Date().toISOString(), guard: 'inbox-guard', action: 'rejected', eventId: event?.id ?? name, originKind: kind ?? null, originSession: session ?? null, reason })
    moved += 1
    console.error(`[inbox-guard] 挪走 ${name}：${reason}`)
  }
  return moved
}

if (once) {
  const n = sweep()
  console.log(`inbox-guard: 扫完，挪走 ${n} 条`)
  process.exit(0)
}
console.log(`inbox-guard: 常驻，每 ${interval}s 扫一次 ${pending}`)
sweep()
setInterval(sweep, Math.max(0.5, interval) * 1000)
