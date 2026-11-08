/**
 * origin-ownership.mjs —— 递归派单禁令（ADR-0012）的「归属判定」唯一实现。
 *
 * 发送侧（scripts/superagent-event.mjs）和收件侧（scripts/inbox-guard.mjs）必须共用本文件：
 * 两处各写一份 SQL 就会出现口径漂移（2026-11-08 的自我冲突就是这么来的）。
 *
 * 判定规则（2026-11-08 三鑫拍板口径 a，2026-11-08 出「自由文本误判」后定稿）：
 *   一个会话 id 算「superagent 自己管的会话」，当且仅当它被一条 **session 形状的结构化字段** 引用：
 *     - 键名里带 `session`（大小写不敏感）：`session` / `origin.session` / `executorSession` …
 *     - 且该字段不在派单来源子树 `mandate.basis.scope.event` 里。
 *
 *   两条排除各治一种误判：
 *   ① 派单来源：`ticket.mandate.basis.scope.event` 记的是「这条工单被哪条事件、哪个会话代发出来的」。
 *      定时器 / 会话代发本来就会反复复用同一个 `origin.session`；若把这处也算归属，
 *      第二次代发就会被上一次自己留下的痕迹拒掉（自我冲突，本文件存在的直接原因）。
 *   ② 自由文本：工单的 report.summary / attention.question / inputs[].text / title 等正文里可能
 *      只是**提到**了某个会话 id（人写的说明、报告转述），那不是归属。只认键名带 session 的结构化字段，
 *      正文提到多少次都不算 —— 否则任何一次报告里写一句 id 就会把长期定时器永久拒死。
 *
 * 边界（未变）：`--origin-kind worker` 在发送侧仍然直接拒发；收件侧仍然把 worker 来源挪进 rejected/。
 * 本文件只管「会话 id 归属」，不碰来源三档。
 *
 * 已知局限：数组元素不是对象键（json_tree 里 key 为 NULL），所以「数组里的一串会话 id」不按归属算；
 * 若将来引擎把受管会话 id 记进数组，需要在这里补规则，而不是在调用方各补一份。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `ticket.mandate.basis.scope.event`：工单的「派单来源」，只作留痕，不算归属。 */
export const SCOPE_EVENT_PATH = '$.mandate.basis.scope.event'

/** 会话 id 作为 SQL 字面量：单引号转义。 */
function quoteLiteral(sessionId) {
  return `'${String(sessionId).replace(/'/g, "''")}'`
}

/**
 * 归属计数查询：>0 表示这个会话 id 被一处「session 形状的结构化字段」引用。
 * - 合法 JSON 的行：用 `json_tree()` 挑「键名带 session」的节点，并排除派单来源子树；
 * - 不是合法 JSON 的行（理论上引擎不会写出来）：退回 `instr()` 保守判，宁可拒发。
 */
export function ownershipCountQuery(sessionId) {
  const literal = quoteLiteral(sessionId)
  const nodeMatch = `lower(coalesce(node.key, '')) like '%session%' and node.value = ${literal} and node.path not like '${SCOPE_EVENT_PATH}%'`
  return [
    'select',
    `(select count(*) from ticket where json_valid(value) and exists (select 1 from json_tree(ticket.value) as node where ${nodeMatch}))`,
    `+ (select count(*) from ticket where not json_valid(value) and instr(value, ${literal}) > 0)`,
    `+ (select count(*) from thread where json_valid(value) and exists (select 1 from json_tree(thread.value) as node where ${nodeMatch}))`,
    `+ (select count(*) from thread where not json_valid(value) and instr(value, ${literal}) > 0);`,
  ].join(' ')
}

/** orchestrator.sqlite 的路径（跟着 --data-root 走，测试可指向临时目录）。 */
export function databasePath(dataRoot = join(homedir(), 'my_dsh_data')) {
  return join(dataRoot, 'state', 'superagent', 'orchestrator.sqlite')
}

/**
 * 会话 id 是否属于 superagent 自己管的会话。
 * 查库失败（无库 / 无 sqlite3 / SQL 报错）一律按「不属于」处理，与旧实现一致。
 */
export function ownedBySuperagent(sessionId, dataRoot = join(homedir(), 'my_dsh_data')) {
  if (!sessionId) return false
  const db = databasePath(dataRoot)
  if (!existsSync(db)) return false
  const out = spawnSync('sqlite3', ['-readonly', `file:${db}?mode=ro`, ownershipCountQuery(sessionId)], { encoding: 'utf8' })
  if (out.status !== 0) return false
  return Number(String(out.stdout).trim() || 0) > 0
}
