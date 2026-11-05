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

---

# 两套 harness 常驻（launchd）

原来两套 DSH harness 都是手起的：`superagent` 在 3082，`web` 用 `--port 0`（端口每次随机，写作时是 53052）。
现在各自一个 launchd job 固定端口、登录即起、挂了自动拉起。

| job | profile | 端口 | 日志 |
| --- | --- | --- | --- |
| `com.dsh.harness-superagent` | `superagent`（dsh-superagent 引擎 + 面板 + 看板浮层） | **3082**（端口写在该 profile 的 patch 里） | `~/my_dsh_data/state/superagent/harness.{out,err}.log` |
| `com.dsh.harness-web` | `web`（工作台：scene-todo / community-desk / task-board） | **3080**（plist 传 `--port 3080`，profile patch 也钉了同一值） | `~/my_dsh_data/state/harness/web.{out,err}.log` |
| `com.sanxin.dsh-superagent-receipts` | 回执接收端（非 harness） | 3083 | `state/superagent/receipts/receiver.{out,err}.log` |

## 切换（先停手起的进程，再 bootstrap）

**顺序不能反**：同一个 profile 跑两个实例会互相写 workspace 注册表；端口被占时 `KeepAlive` 会每 30 秒重试一次。

```sh
uid=$(id -u)
# 1) 停手起的 harness（只停这两个 profile，别误伤回执接收端）
pkill -f 'dsh --profile superagent' ; pkill -f 'dsh --profile web' ; sleep 2
# 2) 装 plist 并加载
cp ~/src/dsh-superagent/scripts/launchd/com.dsh.harness-*.plist ~/Library/LaunchAgents/
for job in com.dsh.harness-superagent com.dsh.harness-web; do
  launchctl bootout gui/$uid/$job 2>/dev/null
  launchctl bootstrap gui/$uid ~/Library/LaunchAgents/$job.plist
done
# 3) 看
launchctl print gui/$uid/com.dsh.harness-superagent | head -20
curl -s -o /dev/null -w '3082 %{http_code}\n' http://127.0.0.1:3082/
curl -s -o /dev/null -w '3080 %{http_code}\n' http://127.0.0.1:3080/
```

`superagent` 那条会重启引擎进程：**正在进行的会话不会丢**（会话日志持久化），但当前这一轮回复会断。
浏览器标签页要重新打开一次——顺手也把已卸载插件的残留客户端模块清掉。

## 边界

- 端口只有两处真源：`superagent` 在 `~/.dsh/profiles/superagent/cordis.patch.yml`，`web` 在 plist 的 `--port 3080`
  与 `~/.dsh/profiles/web/cordis.patch.yml` 两条同值，改端口要两处一起改。
- 两个 profile 的 bundle 不合并：`superagent` 装 `dsh-superagent`，`web` 装工作台三件套；共享的是数据层
  （看板 / 切片记忆 / 回执都在 `~/my_dsh_data`，写入口只有 `board.mjs`）。
- 看板浮层（`dsh-scene-todo`）现在两套 harness 都装了；`superagent` 侧绑定在 `superagent-ops` 场景上
  （`~/my_dsh_data/scenes/superagent-ops.json` 的 `panel.config.sessionId`）。
