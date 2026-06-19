# Linear Workbench Full Target

This document is a target architecture, not a delivery plan. Implementation
continues through thin vertical slices, starting from
`docs/design/2026-06-19-linear-channel-v2.md`.

## Summary

The full target is a Linear-native workbench for botmux agents. It should match
the complete job that Lark currently does for botmux: start work, show progress,
ask for choices, control the running agent, coordinate with other agents, recover
state, and leave an audit trail.

It must not copy Lark UI. Linear should use Linear objects:

- Issue;
- AgentSession;
- AgentActivity;
- Agent Plan;
- signals;
- externalUrls;
- delegate;
- issue status;
- comments only when explicitly configured.

## Feynman Model

Lark is like a chat office: people talk in a group, split into topics, press
cards, and @ other bots.

Linear is like a work order desk: the Issue is the office, each AgentSession is
one working meeting, each turn is something a person says or a control button,
and Agent Activities are the visible meeting notes.

Codex should not carry the whole office in one endless session. Each run gets a
clean execution context. The Issue workbench keeps a curated index so future runs
know what happened without replaying every terminal scroll.

## Target Object Model

### Linear Issue Workbench

Issue-level workspace. It stores the long-lived target and curated cross-run
state:

- issue goal and current understanding;
- AgentRun list and status summary;
- repository binding and workingDir key;
- branch, worktree, PR, and run links;
- decisions and pending decisions;
- cross-run constraints and conflicts.

It must not store secrets, raw terminal logs, screenshots, write tokens, or full
Agent CLI transcripts as the execution authority.

### Linear Agent Run

One execution round for one agent in one Linear AgentSession. It owns:

- botmux Session;
- worker/backend;
- CLI resume context;
- runtimeBotId;
- workingDir;
- usage attribution;
- delivery state.

One Issue can have many runs. Multiple agents on one Issue must use separate
AgentSessions and separate botmux Sessions.

### Linear Turn

One input or control inside a run:

- `created`;
- `prompted`;
- `stop`;
- `select`;
- `auth`;
- `approval`;
- `retry`;
- `handoff`.

Turn type affects routing, idempotency, and whether Codex receives text at all.
Control turns are handled by daemon control handlers first.

### Linear Activity Timeline

Linear-visible projection of the run:

- thought;
- action;
- elicitation;
- response;
- error;
- Agent Plan;
- externalUrls;
- optional issue field updates.

It is not botmux execution state and not a terminal stream.

## Lark To Linear Mapping

| Lark model | Linear full target |
| --- | --- |
| Group or topic-group workspace | Linear Issue Workbench |
| Topic root / rootMessageId | Linear AgentSession id |
| Follow-up reply | prompted AgentActivity |
| Streaming card | semantic AgentActivity + Agent Plan + externalUrl |
| Repo select card | elicitation/select + repository allowlist |
| TUI prompt card | elicitation/select when safe, otherwise dashboard externalUrl |
| `/repo` pin | repo binding / workingDir pin with validation |
| `available_bots` handoff | LinearAgentRoster + official AgentSession create/delegate |
| `botmux send/history/quoted/bots` | Linear prompt contract, replay, and GraphQL queries |
| Dashboard or terminal write link | read-only externalUrls; write actions stay controlled |

Do not port Lark card shape, Lark helper commands, Lark open_id identity, or
Lark thread/card state into the Linear prompt.

## Visibility Model

Linear has six visible outlets:

- `thought`: low-frequency status or judgment summary, optionally ephemeral;
- `action`: human-readable action summary and coarse result;
- `elicitation`: the only visible "waiting for user input" object;
- `response/error`: durable result boundary for the run;
- `AgentSession.plan`: experimental/guarded task checklist;
- `externalUrls`: read-only links to dashboard, session detail, replay, PR, or
  run summary.

Hard rule: visible outputs must not contain token-bearing URLs, raw secrets,
local absolute paths, raw terminal dumps, screenshots, or raw command logs. Use a
safe read-only externalUrl for details.

Issue status, delegate self, and comment mirror are guarded configuration, not
default core behavior.

## Control Model

Use typed `PendingControl` records with:

- scope: `turn | run | workbench | workspace/app`;
- status;
- expiry;
- idempotency key;
- source run and turn;
- handler;
- redacted payload hash.

Control types:

- `repo_select`: allowlist + issueRepositorySuggestions + validation;
- `approval`: required for sensitive or irreversible operations;
- `auth`: Linear auth signal to an OAuth or safe authorization entrypoint;
- `stop`: daemon/worker control signal, not a prompt;
- `resume_retry`: explicit continue, retry, or new-run policy;
- `tui_input`: only simple choices map to Linear; complex TUI stays in dashboard;
- `handoff`: official Linear session create/delegate/mention plus botmux routing.

Codex may request controls, but only daemon control handlers can authorize or
execute channel/workbench side effects.

## Multi-Agent Collaboration

Full target supports multiple agents on one Issue through:

- `LinearAgentRoster`;
- `HandoffRequest`;
- visible handoff receipt;
- `ContextPackage`;
- independent AgentRun per target agent;
- Workbench-level conflict guard.

Agent A can suggest a handoff. The daemon validates roster, policy, permissions,
repo scope, and issue scope, then creates or routes the target AgentSession
through official Linear APIs or confirmed webhook flow.

ContextPackage includes curated summary, task, repo/branch/PR references,
decisions, constraints, and safe links. It must not include raw transcript,
terminal dumps, secrets, write URLs, Lark identities, or unvalidated paths.

Concurrency:

- read-only and planning agents may run in parallel;
- write agents on different branches/worktrees may run in parallel when policy
  allows it;
- same workingDir, same branch, or same PR write operations require lock or
  approval.

## State And Recovery

Execution authority stays in botmux.

State layers:

- `RuntimeState`: in-memory worker, PTY, backend;
- `SessionState`: persisted botmux Session, cliSessionId, workingDir, runtime,
  usage, and delivery anchors;
- `LinearDeliveryState`: idempotency for activities, URLs, status, delegate, and
  comment mirror;
- `PendingControlState`: pending repo, approval, auth, stop, retry, and handoff;
- `WorkbenchIndex`: canonical botmux-owned issue-level summary and references;
- `ReplaySource`: Linear activities, comments, external links, and PRs as
  evidence only;
- `PolicyConfig`: repo allowlist, roster, URL policy, workflow mapping, handoff
  policy.

Linear-visible records are projections. Botmux execution state is canonical for
execution. Replay is evidence, not authority.

WorkbenchIndex should be stored canonically in botmux dataDir with redacted
metadata and versioning. Linear can receive a human-readable projection, but that
projection cannot authorize local execution.

Degraded recovery is allowed only when it can safely rebuild an approximate
context. It must be marked reconstructed/degraded. It must fail instead of
rebuilding when required approvals, repo binding, tokens, stop state, handoff
state, CLI session id, sandbox/worktree state, or non-idempotent side effects are
uncertain.

## Prompt And Context

Linear prompt construction has six layers:

1. Channel Contract and Action Guardrails.
2. Agent identity, runtime, capabilities, and repo policy.
3. Linear guidance.
4. WorkbenchIndex curated summary.
5. Current Run Context: promptContext, issue/comment content, user body, control
   answer, all marked as untrusted external/user content where appropriate.
6. Replay Context only for degraded recovery or audit.

Activity replay enters prompt as a curated summary with evidence links and a
degraded marker. It is not injected as raw history during normal resume.

Hard banned in Linear prompts:

- `<botmux_routing>`;
- `<botmux_reminder>`;
- `<mentions>`;
- `<available_bots>`;
- Lark open_id/union_id identity blocks;
- `botmux send/history/quoted/bots` helper instructions;
- Lark quote, thread alias, message id, card id, chat type;
- Lark repo/TUI card operation instructions;
- Lark app credentials or front-end identities.

## Capability Layers

### Core

Core is required for the workbench to be coherent:

- four-layer object model;
- LinearActivityEmitter and delivery state;
- PendingControl infrastructure;
- approval infrastructure;
- repo/select/free-text controls;
- WorkbenchIndex canonical store and Linear projection;
- safe externalUrls;
- Linear Prompt/Context contract and Lark helper isolation;
- stop as daemon/worker control.

### Guarded

Guarded features require configuration or policy gates:

- Issue status workflow mapping;
- delegate self;
- comment mirror;
- auth/OAuth flow;
- official handoff and ContextPackage;
- repo, branch, PR, and worktree lock;
- degraded recovery from replay.

### Experimental

Experimental features depend on preview APIs or complex orchestration:

- Agent Plan;
- natural-language handoff detection;
- multi-agent parallel orchestration;
- automatic merge or conflict resolution;
- complex TUI keyboard control from Linear;
- automatic status lifecycle without explicit mapping.

## Non-Goals

- Do not build a Linear clone of Lark cards.
- Do not stream raw terminal output into AgentActivity.
- Do not let issue text authorize local paths, commands, secrets, URLs, or
  handoff.
- Do not use AgentActivity replay as the main state store.
- Do not default to changing status, delegate, assignee, or comments.
- Do not collect raw passwords or tokens in Linear.
- Do not share one worker or Codex transcript across agents or runs.
- Do not make Agent Plan or natural-language handoff a core dependency.
- Do not do a broad Lark channel rewrite to support Linear.

## Evidence

Official Linear docs:

- Agent sessions, states, externalUrls, webhooks, activities, repository
  suggestions, ephemeral activities, and Agent Plan:
  https://linear.app/developers/agent-interaction
- Best practices for immediate thought, status started, delegate self, response
  and elicitation, and activity replay:
  https://linear.app/developers/agent-best-practices
- Signals for stop, auth, and select:
  https://linear.app/developers/agent-signals
- User-facing agents, mention, delegation, comments, and guidance:
  https://linear.app/docs/agents-in-linear

Local evidence:

- `src/core/linear-egress.ts`: current v1 egress is only
  `thought/response/error`.
- `src/core/linear-channel.ts`: current feed maps Linear turns to botmux
  Sessions and currently errors on missing workingDir.
- `src/core/linear-webhook.ts`: current normalization covers only
  `created/prompted`.
- `src/services/linear-state.ts`: Linear local state already belongs under
  `config.session.dataDir/linear`.
- `src/core/worker-pool.ts`: Linear final output/error already branch away from
  Lark card delivery; `screen_update` is display state.
- `src/types.ts` and `src/worker.ts`: worker IPC currently lacks a turn-level
  cancel control.
- `src/im/lark/card-handler.ts`: Lark repo/TUI card behavior is useful as a
  state-machine reference but not reusable as Linear UI.

Open evidence before implementation:

- exact mutation shape for proactive agent session creation;
- current stability and fields of Agent Plan API;
- auth signal callback details in the installed Linear app setup;
- issueRepositorySuggestions candidate and result shape in the current schema;
- activity replay pagination and ordering details.
