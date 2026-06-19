# Linear Channel v2 Design Baseline

## Summary

Linear Channel v2 keeps Linear as a first-class botmux channel, not a Lark
clone and not a separate Linear runner. v1 proved the durable loop:

`Linear AgentSession -> botmux Session/worker -> Codex -> Linear response/error`.

v2 adds the smallest Linear-native interaction layer around that loop:

- semantic `thought/action` status, not terminal streaming;
- safe `externalUrls`, not token-bearing local links;
- `elicitation/select` for controlled user input and repository choice;
- `stop` as a real current-turn control signal;
- low-intrusion workbench features: guidance, guarded delegate self, and
  degraded activity replay.

The design rule is: Linear should feel like an issue workbench. Lark remains a
chat/topic workbench. The two share the botmux backend, but not the frontend
interaction model.

## Feynman Model

Think of the Linear Issue as the work order, the AgentSession as one working
round, botmux Session as the local workshop bench, and Codex as the tool on that
bench. v1 only proved that a work order can reach the bench and get a final
answer back. v2 adds the work-order habits users expect: "I received it", "I am
working", "choose the repo", "stop this round", and "open the safe dashboard".

What v2 must not do: turn the Issue into a terminal recording, copy Lark cards,
or let issue text decide local filesystem paths.

## Confirmed Decisions

### 001. Scope

Include in v2:

- short semantic `thought/action`;
- safe `externalUrls`;
- `elicitation/select`;
- stop signal;
- repository selection via allowlist plus `issueRepositorySuggestions`.

Exclude from v2:

- full terminal streaming into Linear;
- Lark card clone;
- Agent Plan preview;
- multi-agent handoff;
- Agent Activities replay as the main state source.

### 002. Activity Emitter

Add a thin `LinearActivityEmitter`.

Responsibilities:

- write `thought/action/elicitation/response/error`;
- centralize delivery idempotency and low-frequency throttling;
- attach safe external URLs;
- preserve `final_output -> response` and `error -> error` as the durable
  result boundary.

Forbidden:

- generating activity from `screen_update`;
- writing command output, raw terminal text, screenshots, spinner text, or local
  paths into `thought/action`.

Suggested idempotency keys:

- `agentSessionId:turnId:received`;
- `agentSessionId:turnId:codex-ready`;
- `agentSessionId:turnId:elicitation:<elicitationKey>`;
- `agentSessionId:turnId:response`;
- `agentSessionId:turnId:error:<errorClass>`.

### 003. External URLs

Support `agentSessionUpdate.externalUrls`, but only from explicit public,
read-only configuration.

Add a dedicated public base URL setting such as `LINEAR_PUBLIC_BASE_URL` or
`linear.publicBaseUrl`. Do not infer this from existing dashboard or web
external host settings.

Allowed:

- read-only botmux session/dashboard URL;
- read-only terminal replay URL;
- PR URL;
- run/log summary URL without secrets.

Rejected:

- `localhost`, `127.0.0.1`, LAN IPs, `file://`;
- URLs containing write tokens or secrets, including `?token=` or `?t=`;
- terminal write links;
- URLs copied from Issue text or prompt context.

Maintain key-based URL state such as `dashboard-session`, `terminal-readonly`,
and `pr`, then merge before updating Linear to avoid replacing existing links.

### 004. Repository Selection

Upgrade missing or ambiguous `workingDir` from a v1 hard error to a Linear
`elicitation/select`, but only when botmux has a local repository allowlist.

Minimal allowlist shape:

```ts
linear.repositories[] = {
  key,
  hostname,
  repositoryFullName,
  workingDir,
  displayName?,
  branch?
}
```

Rules:

- `workingDir` must pass local validation;
- `issueRepositorySuggestions` may rank candidates, but cannot authorize cwd;
- Issue text and prompt context may hint, but must not directly select cwd;
- user selected value must match pending options exactly;
- selected repo continues the same AgentSession with the original prompt.

### 005. Stop Signal

Stop is a control signal, not a prompt. It targets the current turn of one
AgentSession, not the whole Issue.

Target semantics:

- v2.0: mark stop state, suppress late delivery, best-effort cancel, and fall
  back to closing the worker/session if needed;
- v2.1: adapter-aware `cancel_turn` that preserves the CLI session when safe.

Add explicit stop modeling:

- `LinearTurnType = 'created' | 'prompted' | 'stop'`, or a dedicated
  `LinearStopTurn`;
- `Session.linear.stopRequestedAt`;
- `Session.linear.stopTurnId`;
- `Session.linear.stopState = requested | sent_to_worker | stopped | failed`;
- worker IPC `{ type: 'cancel_turn'; turnId?: string; reason?: string }`.

Duplicate stop should be idempotent. Late `final_output` for a cancelled turn
must not produce a Linear response. Stop-triggered worker exit should write one
stop confirmation, not an error storm.

### 006. Human Input

Create a generic `PendingElicitation`, not a repo-only state machine.

Minimum fields:

- `agentSessionId`;
- `turnId`;
- `elicitationKey`;
- `kind: repo | choice | confirm | free_text`;
- `question`;
- `options?`;
- `originalTurn` or `originalPrompt/promptContext`;
- `status: pending | consumed | expired | failed`;
- `createdAt/expiresAt`;
- `activityId?`;
- `selectedValue?/answerText?`.

Mappings:

- `tui_prompt`: only convert to Linear elicitation when options are few,
  semantically clear, and do not require keyboard-level TUI interaction;
- `user_notify`: usually a short thought or blocker, not an elicitation;
- `botmux send --attention`: dashboard needs-you signal, not a consumable
  Linear question;
- `auth`: defer to v2.5 unless token re-auth is unavoidable.

When a select or free-text answer arrives, normalize webhook first checks for
pending elicitation, consumes it, records the answer, and routes the answer back
to the same AgentSession. It must not create a new Session or treat the answer
as an unrelated task.

### 007. Workbench Integration

Add low-intrusion Linear workbench features.

Do not automatically update Issue status in v2. Status workflows differ by
team. A future feature can use explicit mapping such as `onStart -> statusId`.

Allow guarded delegate self only when all conditions hold:

- configuration enables it;
- task looks like implementation/fix/build work;
- no other agent delegate exists;
- human assignee is not overwritten;
- token scope and API permission allow it;
- operation is idempotent.

Inject Agent guidance into the Linear prompt below system/developer/channel
contract and above ordinary Issue description/comments. Guidance must not
authorize local cwd, secrets, Lark helpers, or policy bypass.

Activity replay is only for degraded recovery, audit, and diagnosis. It is not
the main botmux state source.

Do not mirror final answers into ordinary Issue comments in v2. AgentActivity
`response/error` remains the official output.

### 008. Implementation Slices

Recommended order:

1. `LinearActivityEmitter` and delivery state.
2. `LinearSessionClient` and safe external URLs.
3. `PendingElicitationStore`.
4. Repo select and `issueRepositorySuggestions`.
5. Stop signal and `cancel_turn` IPC.
6. Guidance, degraded replay, guarded delegate self.

Files to prefer:

- `src/core/linear-egress.ts`;
- new `src/core/linear-session-client.ts` if useful;
- `src/services/linear-state.ts` or new `src/services/linear-elicitation-store.ts`;
- `src/core/linear-webhook.ts`;
- `src/core/linear-channel.ts`;
- `src/types.ts`;
- small Linear branches in `src/core/worker-pool.ts` and `src/worker.ts`.

Files to avoid large rewrites in v2:

- Lark ingress and prompt paths;
- `src/im/lark/card-handler.ts`;
- `src/im/lark/card-builder.ts`;
- `src/core/session-manager.ts`;
- bot registry or runtime config architecture.

## Verification Plan

Emitter:

- dedupe `thought/action/elicitation/response/error`;
- prove `screen_update` does not create Linear activity;
- reject command/path/raw terminal text in coarse action bodies.

External URLs:

- no `LINEAR_PUBLIC_BASE_URL` means no external URLs;
- localhost/LAN/token-bearing URLs are rejected;
- key-based merge preserves PR URLs and avoids duplicates.

Pending elicitation:

- persists, expires, consumes, and dedupes repo/choice/confirm/free-text;
- select webhook is consumed before normal feed;
- invalid select cannot become cwd or a new task.

Repo select:

- issue hints cannot directly set cwd;
- suggestions only rank allowlist entries;
- selected workingDir passes validation before worker start.

Stop:

- stop signal never enters Codex prompt;
- sends `cancel_turn` or kill fallback;
- suppresses late `final_output`;
- duplicate stop writes only one receipt.

Workbench:

- guidance priority and untrusted boundaries hold;
- replay only runs when local state is missing and is marked degraded;
- delegate self requires config, no other agent delegate, and idempotency.

Lark regression:

- Lark final delivery still uses card/doc-comment paths;
- Lark worker env and prompt still carry expected Lark fields;
- Lark repo card and TUI prompt tests or mocks still pass;
- run typecheck/build and focused Linear tests.

## Success Standard

v2 is done when a Linear user can see controlled progress, open safe links,
select or answer requested inputs, stop the current run, and continue the same
AgentSession without breaking Lark behavior.

Not blockers for v2:

- full terminal streaming;
- Lark card clone;
- Agent Plan preview;
- multi-agent handoff;
- generic auth/account linking flow;
- multi-question forms;
- keyboard-level TUI driving;
- automatic Issue status updates;
- comment mirroring;
- distributed storage or external secret store.

## Evidence

Official Linear documentation:

- Agent interaction lifecycle, AgentSession states, external URLs, created
  activity deadline, activity types, repository suggestions, ephemeral activity,
  and Agent Plan preview:
  https://linear.app/developers/agent-interaction
- Agent best practices, delegate guidance, comments versus Agent Activities,
  and additional webhook topics:
  https://linear.app/developers/agent-best-practices
- Stop, auth, and select signals:
  https://linear.app/developers/agent-signals
- User-facing agent usage, mention/delegate, and guidance:
  https://linear.app/docs/agents-in-linear

Local code evidence:

- `src/core/linear-egress.ts`: current egress only covers
  `thought/response/error`.
- `src/core/linear-channel.ts`: current Linear feed creates or restores botmux
  Session and currently errors when `workingDir` is missing.
- `src/core/linear-webhook.ts`: current normalize path covers only
  `created/prompted`.
- `src/services/linear-state.ts`: Linear token and delivery state already live
  under `config.session.dataDir/linear` with local JSON storage.
- `src/core/worker-pool.ts`: Linear final output/error already branch away from
  Lark cards; `screen_update` is display state, not Linear activity.
- `src/types.ts` and `src/worker.ts`: current worker IPC has close/suspend but
  no turn-level cancel message.
- `src/im/lark/card-handler.ts`: Lark repo selection has useful pending-state
  ideas, but its card UI and OpenID semantics are Lark-specific.
