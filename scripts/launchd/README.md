# 本机回执接收器（launchd 常驻）

webhook 来源只能靠事件里的 `callback` 回消息：`src/sources/webhook.ts#sendWebhook` 在没有 callback 时返回 `gone`，
outbox 把它落成 `channelGone` 终态、不重试。2026-11-05 之前的事件都没有 callback，10 条回执（确认 / 提问 / 完成回报）
因此全部 dropped。

`../webhook-receipt.mjs` 就是这个 callback：引擎 POST `{key, conversation, event, kind, ticket?, text}` 过来，
它把每条回执写成一行 JSONL，再投影成 `superagent-ops` 待办板的一行（走 `~/my_dsh/scripts/board.mjs#executeBoard`
单一写入口，和 `project-board.mjs` 的工单投影同一条闸门）。

| 件 | 位置 |
| --- | --- |
| 回调 URL / 监听地址 | `~/my_dsh_data/state/superagent/webhook-reply.json`（`url`、`listen`） |
| 回执流水（真源） | `~/my_dsh_data/state/superagent/receipts/receipts.jsonl`，一行一条，含时间 / 线程 / 工单号 / kind / 正文 |
| 看板侧映射 | `~/my_dsh_data/state/superagent/receipts/board.json`（`key → {line, boardId, state}`，重跑幂等） |
| 日志 | `~/my_dsh_data/state/superagent/receipts/receiver.out.log`、`.err.log` |
| 看板落点 | `~/my_dsh_data/boards/superagent-ops/待办板.md` 的「已完成」一节，行标为 `回执 · 确认/回复/通知 · …` |

## 安装（一次）

```sh
cp ~/src/dsh-superagent/scripts/launchd/com.sanxin.dsh-superagent-receipts.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.sanxin.dsh-superagent-receipts 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sanxin.dsh-superagent-receipts.plist
```

`RunAtLoad` + `KeepAlive`：登录即起，进程挂了 10 秒后自动重启。改脚本后重启用：

```sh
launchctl kickstart -k gui/$(id -u)/com.sanxin.dsh-superagent-receipts
```

## 查

```sh
curl -s http://127.0.0.1:3083/health          # 收到多少条、看板上了多少、有没有在等看板
node ~/src/dsh-superagent/scripts/webhook-receipt.mjs --status   # 同上 + 配置与文件路径
tail -f ~/my_dsh_data/state/superagent/receipts/receiver.out.log
launchctl print gui/$(id -u)/com.sanxin.dsh-superagent-receipts | head
```

## 停

```sh
launchctl bootout gui/$(id -u)/com.sanxin.dsh-superagent-receipts
```

## 发送侧

两个发送脚本默认就从上面那份配置里取 URL，不用手填：

- `../superagent-event.mjs`：`--callback <URL>` 覆盖，`--no-callback` 显式不带，配置缺失时与老行为一致（不带 callback）。
- `../superagent-reply.mjs`：同上，人回话的事件因此自带 callback，引擎对它的确认/回复也能落回来。

## 历史补偿

outbox 里已 dropped 的 webhook 回执可随时重新导入（幂等，只补 JSONL，不补看板——那些回执对应的工单行已经在看板上讲过故事）。
`receipts.jsonl` 和 `board.json` 同一时刻只允许一个写者，所以先停接收器再导：

```sh
launchctl bootout gui/$(id -u)/com.sanxin.dsh-superagent-receipts
node ~/src/dsh-superagent/scripts/webhook-receipt.mjs --backfill
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sanxin.dsh-superagent-receipts.plist
```

（`--force` 能跳过这项保护，但两边的内存态会互相覆盖，别在有回执进来时这么干。）

## 边界与已知识别

- 写入闸门不绕：看板一律经 `~/my_dsh/scripts/board.mjs#executeBoard`，以场景主切片
  `superagent-ops/superagent-ops-agent` 身份写；工单投影 `project-board.mjs` 的行为未改，两者按 ticket id / 回执 key
  各管各的行。
- 回执行是「记录」不是「活」：机器记录后直接收口进「已完成」，不占「任务」区、不进 `review`（否则
  `acceptance-round.mjs` 会把它当待验收行）。
- 看板写失败不让引擎重发：回执先落 JSONL，看板侧失败进 `board.json` 的待办队列，进程每 60 秒重试；连续失败 5 次标记
  `skipped` 并写日志，文件里仍有原文。
- 板锁冲突：`board.mjs` 的锁只有两次尝试，接收器遇到「场景板被锁定」会退避重试三次，仍失败就留给 60 秒后的重试。
- 只监听回环地址；body 上限 256 KB（引擎正文上限 20 000 字符）。
