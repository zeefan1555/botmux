# Linear Workbench UX Projector

本文是 Linear 工作台用户体验改造的设计收口，不是实现提交。目标是解决
ZEE-365 暴露的问题：Linear 上显示 `starting/working`，但用户不知道 Codex
是否真的启动，甚至最终完成后可见状态仍没有收口。

## 目标

- 让 Linear 用户清楚看到：已接收、Codex 已启动、需要用户输入、失败、完成。
- 给每个 AgentSession 一个安全只读观察入口，而不是把终端内容刷进 Issue。
- 让 agent 可以主动发阶段状态，但不泄露隐藏推理链、命令输出、路径、diff 或 secret。
- 尽量不碰 Lark 旧路径；Linear UX 放在独立适配层中。

## 非目标

- 不复制 Lark streaming card。
- 不从 `screen_update`、stdout、stderr、终端截图或 TUI 光标生成 Linear activity。
- 不把 token-bearing dashboard URL、write terminal URL、localhost/LAN/file URL 写入 Linear。
- 不迁移 Lark repo card、TUI card、final delivery 或 Lark prompt builder。

## 001. Linear-only UX Projector

新增 `LinearRunStatusProjector`，位于 worker/daemon 语义事件和
`LinearActivityEmitter` 之间。

费曼版：worker 像厨房，只报告发生了什么；Projector 像前台播报员，把厨房
事件翻译成 Linear 用户能看懂的几句话。

职责：

- 接收 Linear run 语义事件。
- 决定哪些事件对用户可见。
- 统一文案、幂等 key、节流、脱敏和降级。
- 调用 `LinearActivityEmitter` 写 `thought/action/response/error/externalUrls`。

不做：

- 不解析终端输出。
- 不订阅 `screen_update`。
- 不替代 botmux Session、idempotency、worker state。

## 002. 可见状态契约

默认可见状态：

| Event | Linear projection | 说明 |
| --- | --- | --- |
| `accepted` | short `thought` | 已接收，正在启动或恢复 Codex |
| `worker_ready` | `thought` 或 `action` | Codex 确认已启动 |
| `external_urls_ready` | AgentSession `externalUrls` | 写安全只读观察链接 |
| `status_update` | `thought` | agent 主动阶段状态 |
| `waiting_user` | `elicitation` 或 blocker | 需要用户输入 |
| `final_response` | `response` | 本轮唯一成功 durable 结果 |
| `error` | `error` | 运行中失败 |
| `start_failed` | `error` | 启动阶段失败 |
| `stopped` | `response` 或 `thought` | 停止收据 |

默认不可见：

- `prompt_sent`；
- `screen_update`；
- stdout/stderr；
- raw command；
- diff；
- local path scrolling；
- 高频 still-working 心跳。

## 003. 事件接入

推荐收敛为一个通用回调：

```ts
linearRunEvent(ds, event)
```

初始事件 union：

```ts
accepted
awaiting_input
start_failed
worker_ready
status_update
waiting_user
final_response
error
stopped
external_urls_ready
```

`worker-pool` 和 `daemon` 只发布语义事件，不拼 Linear 文案。
`linear-egress.ts` 保持低层写入器定位。

## 004. Agent-facing `linear-status`

`botmux linear-status` 是 Linear channel 里的 agent-facing 进度工具，对应
Linear `thought`。它不是最终答案、不是 Lark message、不是终端日志出口。

写入链路：

```text
CLI -> /api/linear/status -> linearRunEvent(status_update)
    -> LinearRunStatusProjector -> LinearActivityEmitter.thought
```

Linear prompt 的 Channel Contract 必须显式注入：

- 任务超过短时间或阶段切换时可使用。
- 只写用户可见阶段摘要。
- 不写 hidden chain-of-thought。
- 不写命令输出、stdout/stderr、secret、local path、diff、token URL。
- 最终答案仍通过正常 final response 输出。
- 鼓励稳定 key，例如 `phase:read-code`、`phase:tests`、`blocked:token`。

Projector 保护：

- body 长度限制；
- whitespace normalize；
- 基础 token/URL/path 过滤；
- key sanitize；
- 同 key 幂等；
- 短窗口限频；
- terminal state 后忽略同 turn 的 status。

## 005. 只读观察入口

Linear timeline 保持少量语义状态；真实执行过程通过只读 `externalUrls`
打开。

链接分层：

- `Botmux session`：只读 session summary/status 页面。
- `Read-only terminal`：只读 terminal/replay 页面。

近期实现可以先放一个最安全、最可靠的只读链接，但目标态保留两个 key：

- `botmux-session`
- `terminal-readonly`

安全规则：

- 只在显式 `LINEAR_PUBLIC_BASE_URL` 或等价 public base 配置存在时写。
- 拒绝 `localhost`、`127.0.0.1`、私网 IP、`file://`。
- 拒绝 `?token=`、`?t=`、write terminal token、dashboard token。
- URL 只能由 botmux 配置生成，不能来自 issue/comment/promptContext。
- key-based merge，不能盲覆盖已有 PR URL。

## 006. 启动失败和状态收口

`start_failed` 必须独立建模。它最终写 Linear `AgentActivity.error`，
但 Projector 内部要和运行中 `error` 分开。

触发范围：

- token/OAuth 缺失；
- `runtimeBotId` 无效；
- `workingDir` 缺失或非法；
- repo select / elicitation 创建失败且无法等待用户；
- `forkWorker` 抛错；
- worker init/ready 失败。

最小 turn 状态机：

```text
nonterminal: accepted, starting, ready, waiting_user, running
terminal: start_failed, final_response, error, stopped
```

规则：

- terminal 后忽略同 turn 的 `status_update/worker_ready/external_urls_ready`。
- `start_failed` 后不写 `worker_ready`。
- `stopped` 后 suppress late `final_response`。
- `final_response/error` 后不再写 thought/action。
- 状态 key 使用 `agentSessionId + turnId`，并持久化到 delivery/visible state。

启动 watchdog 是兜底，不是主要失败判断：

- `accepted/queued` 后登记 startup deadline。
- 明确失败事件立即投影 `start_failed`。
- `worker_ready/waiting_user/final_response/error/stopped` 任一到达即取消。
- deadline 到期仍无进展时，写启动超时 error，并说明未收到 worker ready。
- 阈值默认保守且可配置。

## 007. 实施切片

1. 文档收口 UX Projector 小节。
2. Projector 骨架 + `linearRunEvent` 桥接。
3. 用户可见过程：`worker_ready`、safe `externalUrls`、`linear-status` prompt contract。
4. 失败兜底：`start_failed`、startup watchdog、turn terminal visibleState。

允许小改：

- `src/core/linear-run-status-projector.ts` 新建；
- `src/core/worker-pool.ts` Linear 分支改成发布语义事件；
- `src/daemon.ts` `/api/linear/turn`、`/api/linear/status`、worker callbacks 转 event；
- `src/core/linear-egress.ts` 仅补低层 `action` 或 delivery helper；
- `src/core/linear-channel.ts` feed result 到事件；
- Linear prompt builder 注入 `botmux linear-status` contract；
- 新增 projector/route/worker callback 测试。

尽量不碰：

- Lark card handler/card builder；
- Lark repo card；
- Lark TUI card；
- Lark prompt builder 既有 blocks；
- Lark final delivery/card/doc-comment；
- BotConfig/runtime registry 大结构；
- worker `screen_update` 逻辑。

## 验证矩阵

每个 UX 改动必须做真实 Linear issue 验证。ZEE-365 类 issue 作为第一 smoke。

| 场景 | 预期 |
| --- | --- |
| 新评论 @ agent 正常执行 | `accepted -> worker_ready -> final_response` |
| 无效 workingDir/runtime/token | `start_failed/error`，不显示假 working |
| agent 主动 `botmux linear-status --key phase:*` | 低频 thought，重复 key 不刷屏 |
| public base URL 配置存在 | 写只读 externalUrls |
| public base URL 缺失 | 不写 localhost/LAN/token 链接 |
| final 后 late status_update | 不再刷 thought |
| stop 后 late final_output | 不写 response |
| Lark smoke | Lark streaming card/final delivery 仍正常 |

## 代码证据锚点

- `docs/design/2026-06-19-linear-channel-v2.md`：v2 明确 semantic activity，
  禁止从 `screen_update` 生成 Linear activity。
- `src/core/linear-egress.ts`：当前 `LinearActivityEmitter` 是低层 GraphQL/
  幂等写入器。
- `src/daemon.ts`：当前 queued/status/Linear worker callbacks 还直接调用 emitter，
  需要收敛到 Projector。
- `src/core/worker-pool.ts`：`ready/final_output/error/user_notify` 是语义事件来源；
  Linear 分支应发 event，不承载 Linear 文案。
- `src/skills/definitions.ts` 与 `src/cli.ts`：已有 `botmux-linear-status` /
  `botmux linear-status`，但 prompt contract 和 Projector 链路还需要补齐。
