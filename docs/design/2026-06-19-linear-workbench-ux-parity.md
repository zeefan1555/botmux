# Linear Workbench UX Parity

This document is a UX target and acceptance guide, not an implementation patch.
It complements:

- `docs/design/2026-06-19-linear-workbench-full-target.md` for the long-term
  architecture target.
- `docs/design/2026-06-19-linear-workbench-ux-projector.md` for the first thin
  implementation slice around `LinearRunStatusProjector`.

The goal is to match the user-perceived job that Lark currently does for botmux,
while using Linear-native objects and keeping Lark code paths isolated.

## Feynman Model

Lark is a chat office. Users see topic cards, live card updates, repo buttons,
TUI buttons, bot mentions, and terminal links.

Linear is a work order desk. Users should see Issue-level status, AgentSession
progress, clear questions, final results, and safe links to execution details.

So the goal is not to copy Lark cards into Linear. The goal is to make the same
human questions answerable in Linear:

- Did the agent receive my request?
- Did Codex actually start?
- What phase is it in?
- Is it blocked, and what do I do next?
- Which answer is final?
- Where can I inspect details?
- What happened across multiple runs on the same Issue?

## Design Rule

Design order:

1. User-perceived capability.
2. Linear-native object.
3. botmux Linear adapter or state layer.
4. Lark regression boundary.

Do not start from Lark card shape, Lark helper commands, or `screen_update`.

## 001. UX Parity Map

Linear UX should match Lark by capability, not by UI.

Core user-perceived capabilities:

1. Accepted, started, blocked, completed, and failed states are visible.
2. Real execution details are inspectable through a safe read-only entry.
3. Choices and confirmations happen inside the same workbench.
4. Stop, retry, continue, and new-run boundaries are explicit.
5. Multi-run Issue history is understandable.
6. The agent can report low-frequency phase status.
7. Collaboration and side effects are visible and auditable.
8. Recoverable permission, policy, config, and delivery failures explain the
   user's next step.

Feynman version: Lark gives users a live control panel in chat. Linear should
give users a work order panel in the Issue. Different surface, same confidence.

## 002. Issue Workbench Summary And Run Index

AgentActivity timeline alone is not enough for an Issue where users may invoke
the agent multiple times.

Add a Workbench-level summary and run index:

- Issue goal and current understanding.
- AgentRun list with status summaries.
- Current repo, branch, PR, and safe external links.
- Key decisions and pending decisions.
- Latest blocker and next action.
- Final or error summary per run.

Canonical state belongs in botmux dataDir. Linear gets a human-readable
projection. Do not project raw workingDir paths, secrets, idempotency keys,
pending control internals, raw logs, screen updates, or full transcripts.

Feynman version: the Issue needs a table of contents. AgentActivity is the
meeting notes; WorkbenchIndex is the front page that says what happened and
what is next.

## 003. Controls And Human Input UX

Use a typed `PendingControl` foundation instead of separate one-off flows for
repo, auth, stop, retry, and approval.

Control kinds:

- `repo_select`
- `approval`
- `auth`
- `stop`
- `retry`
- `continue_run`
- `new_run`
- `tui_input`
- `handoff`

Shared fields should include scope, source Issue, AgentSession, turn id,
control key, expiry, idempotency key, status, handler, and visible receipt.

Codex may request a control. The daemon decides whether to create, consume, or
execute it. Issue text, prompt context, or Codex output must not directly
authorize local cwd, auth, externalUrls, handoff, status changes, delegate, PR
effects, or dangerous commands.

Feynman version: Codex can raise its hand and ask, "Can I do this?" The daemon
is the gatekeeper that checks policy and asks the user in Linear.

## 004. Activity Timeline Noise Policy

Linear AgentActivity is a work record, not a terminal stream.

Visible outlet responsibilities:

- `thought`: low-frequency status or blocker summary.
- `action`: coarse action summary, not raw command output.
- `elicitation`: the only formal "waiting for user input" surface.
- `response`: the unique durable success result.
- `error`: the unique durable failure result.
- `externalUrls`: safe details entry, not activity stream content.
- Agent Plan: guarded or experimental long-task helper, not core state.

Do not write these into Linear Activity:

- `screen_update`
- stdout or stderr
- raw command text
- raw stack traces
- local absolute paths
- full diffs
- token-bearing URLs
- hidden reasoning
- high-frequency heartbeats

Feynman version: the Issue timeline should read like a work log, not like a
terminal recording.

## 005. Recoverable Failure And Permission UX

Failures should be grouped by the user's next action, not by internal exception
class.

Failure categories:

- `auth/token`: re-authorize or complete OAuth.
- `repo/workingDir`: choose a repo or fix allowlist/config.
- `externalUrl`: work may continue, but read-only details link is unavailable.
- `runtime/start`: Codex did not start; fix runtime, CLI, cwd, or daemon config.
- `permission/policy`: approval or explicit config is required.
- `delivery`: Codex may have completed, but Linear writeback failed.

Every failure projection should include:

- what happened;
- impact;
- next step;
- severity or effect.

Effects:

- `terminal`
- `waiting_user`
- `degraded`
- `retryable_delivery`

Raw stack, environment values, tokens, private URLs, full GraphQL payloads,
stdout/stderr, and local absolute paths stay in botmux logs or audit state, not
Linear Activity.

Feynman version: users do not need the engine error code first. They need a
dashboard light that says "stop", "choose", "retry", or "continue with reduced
visibility".

## 006. Agent Behavior And Prompt Contract UX

The Linear prompt contract is part of UX.

Daemon and Projector can guarantee minimum visibility:

- accepted;
- worker ready;
- final response;
- error.

Long-task phase sense and blocker explanations require agent behavior rules:

- Use `botmux linear-status --key phase:*` for long phases.
- Use stable keys such as `phase:read-code`, `phase:test`, `blocker:oauth`.
- Keep status low-frequency and user-readable.
- Do not send final answers through `linear-status`.
- Do not include hidden reasoning, raw output, secrets, local paths, diffs, or
  token-bearing URLs.
- Request controls through agreed protocol or CLI/skill contract; daemon
  consumes and persists the resulting `PendingControl`.

Linear prompt must hard-ban Lark helper blocks and identity semantics:

- no `botmux send`;
- no `botmux history`;
- no `botmux quoted`;
- no `botmux bots`;
- no `available_bots`;
- no Lark `open_id`;
- no Lark card, thread, root message, quote, repo card, or TUI card
  instructions.

Feynman version: Linear agents need a service manual. They should report phase,
ask official questions, and put the final answer in the final response. They
should not bring a Lark microphone into a Linear office.

## 007. Implementation Layers

Implement UX in layers:

1. Run UX Projector.
2. Activity Timeline Policy.
3. Workbench Summary / Run Index.
4. PendingControl.
5. Safe Observation Surface.

First narrow implementation card:

- Add `LinearRunStatusProjector`.
- Add one `linearRunEvent` bridge.
- Cover only `accepted`, `worker_ready`, `final_response`, `error`, and
  `status_update`.
- Route `/api/linear/status` through the projector.
- Keep worker-pool as a semantic event source.
- Do not subscribe to `screen_update`.
- Do not migrate Lark card, repo card, TUI card, prompt blocks, or final
  delivery.

Core follow-up slices:

- delivery and visible state;
- safe externalUrls;
- `start_failed` and failure effect;
- WorkbenchIndex skeleton;
- PendingControl skeleton.

Guarded slices:

- repo select;
- approval and auth;
- stop, retry, continue, new run;
- status, delegate, comment mirror;
- handoff;
- branch, PR, and worktree locks.

Experimental slices:

- Agent Plan projection;
- natural-language handoff intent detection;
- complex TUI keyboard control;
- automatic issue status lifecycle;
- multi-agent orchestration.

Feynman version: first fix the front desk that says "received, started, done,
failed". Then add doors, forms, summaries, and advanced coordination.

## 008. Verification And Acceptance

UX completion requires real Linear Issue evidence. Unit tests and fake clients
are pre-flight checks, not final acceptance.

Verify against these user questions:

| User question | Required evidence |
| --- | --- |
| Did the agent receive my request? | Real Issue shows `accepted` |
| Did Codex actually start? | Real Issue shows `worker_ready`; no stuck `starting` |
| What is it doing? | `botmux linear-status --key phase:*` creates low-frequency status |
| What should I do when blocked? | failure/blocker gives actionable next step and effect |
| Can I choose or confirm clearly? | PendingControl/select/approval/auth consumes user input safely |
| Can I inspect execution details? | safe read-only externalUrls when configured; no bad URL when not |
| Can I understand multiple runs on one Issue? | Workbench projection shows run index and current next action |
| Which result is final? | only `response/error` are durable results; late status is suppressed |

Every implementation issue should include:

```md
## Verification Evidence

- Unit / integration:
  - command: <command>
  - result: <summary>
- Real Linear issue verification:
  - verify issue: <ZEE-xxx or URL>
  - scenario: <actual user operation>
  - observed: <visible activity/control/externalUrl/response>
  - evidence artifact: <activity id, message id, screenshot, or concise note>
- Projection vs canonical check:
  - checked: <botmux session/delivery/control state>
  - result: <consistent / inconsistency summary>
- Lark regression:
  - checked: <prompt/card/repo/TUI/final path>
  - result: <evidence>
- Remaining risk:
  - <none or explicit risk>
```

Non-happy paths are required:

- `start_failed`;
- delivery failure;
- missing public base URL;
- bad externalUrl rejection;
- token or OAuth missing;
- invalid workingDir or repo allowlist;
- late `status_update` after final;
- Lark smoke.

Feynman version: if the user cannot see it in a real Issue, the UX is not done.

## Evidence Anchors

- `docs/design/2026-06-19-linear-workbench-full-target.md`: target object
  model, Lark to Linear mapping, visibility model, controls, state and prompt
  boundaries.
- `docs/design/2026-06-19-linear-workbench-ux-projector.md`: first UX
  projector slice, visible state table, `linear-status`, safe externalUrls,
  `start_failed`, and verification matrix.
- `src/core/worker-pool.ts`: Linear should consume semantic events and must not
  turn `screen_update` into Linear activity.
- `src/daemon.ts`: current Linear turn and status ingress points are where
  event bridging should happen.
- `src/core/linear-egress.ts`: low-level Linear activity and delivery writer,
  not the UX policy state machine.
- `src/cli.ts` and `src/skills/definitions.ts`: existing `botmux linear-status`
  and skill contract that must be wired into the Linear prompt and Projector.

## Non-goals

- Do not build a Linear clone of Lark cards.
- Do not stream terminal output into AgentActivity.
- Do not let Issue text or promptContext authorize local cwd, secrets, URLs,
  handoff, status changes, or dangerous actions.
- Do not expose token-bearing dashboard or terminal write links.
- Do not use AgentActivity replay as the canonical execution state.
- Do not make Agent Plan, natural-language handoff, or multi-agent orchestration
  a core dependency.
- Do not refactor Lark channel code as part of this UX pass.
