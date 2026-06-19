# Botmux

Botmux bridges chat conversations to AI coding command-line tools while keeping
the conversation anchored to the chat where the work started.

## Language

**Agent CLI**:
An AI coding command-line tool that botmux can run on behalf of a chat, such as
Claude Code, Codex, Gemini, Cursor, or OpenCode.
_Avoid_: agent cli, CLI bot

**Bot**:
A chat-visible identity configured to route messages into one selected
**Agent CLI**.
_Avoid_: agent, app

**Session**:
A continuing conversation between one chat anchor and one **Agent CLI**.
_Avoid_: thread, task

**Channel**:
A conversation surface that can start or continue a **Session** and receive the
**Agent CLI** response.
_Avoid_: app, runner, transport

**Linear Channel**:
Linear used as a **Channel** for botmux, where a Linear agent interaction is
handled as a botmux **Session** instead of a separate agent loop.
_Avoid_: weather-bot fork, Linear runner

**Linear Issue**:
The Linear work item that acts as the long-lived workbench for one or more
botmux **Sessions**.
_Avoid_: chat, thread, agent session

**Linear Agent Session**:
The Linear-visible run or delivery target for one agent working on a
**Linear Issue**. It is not the long-lived botmux **Session** anchor.
_Avoid_: issue, botmux session, worker

**Linear Agent Activity**:
A Linear-visible record emitted within a **Linear Agent Session**, such as a
thought, action, clarification request, final response, or error.
_Avoid_: card, message, terminal output

**Channel Anchor Id**:
The external id a **Channel** uses to find the same conversation again. For
Linear this is the **Linear Issue** id combined with the **Channel Identity**,
so each agent has its own long-lived botmux **Session** on the same issue.
_Avoid_: sessionId, agentSessionId

**Channel Identity**:
The configured bot/app identity that owns a **Channel Anchor Id**. It separates
multiple botmux agents working on the same external object.
_Avoid_: larkAppId, user id

**Linear Feed Turn**:
The normalized handoff from a Linear webhook into an existing or newly created
botmux **Session**. It sends input to the worker through botmux worker IPC or
starts the worker through the existing CLI path.
_Avoid_: Lark message, messageQueue entry

**Runtime Config**:
The botmux configuration used to start an **Agent CLI**, including the CLI id,
wrapper command, model, working directory, sandbox setting, and backend. It is
not the same as a **Channel Identity**.
_Avoid_: channel identity, Linear app identity

**Linear Prompt Contract**:
The Linear-specific prompt shape passed to an **Agent CLI**. It carries Linear
Issue, Agent Session, Agent Activity, and prompt context data, and excludes
Lark routing instructions or helper commands.
_Avoid_: Lark prompt, weather-bot prefix protocol

**Linear Activity Emitter**:
The thin Linear egress layer that writes semantic Agent Activities, applies
delivery idempotency, and attaches safe session links. It must not translate
terminal screen updates into Linear activity.
_Avoid_: streaming parser, Lark card renderer

**Pending Elicitation**:
A persisted Linear question awaiting a user answer in the same **Linear Agent
Session**. It stores the original turn, question, allowed options or free-text
shape, status, and expiry so the answer can resume the right botmux Session.
_Avoid_: repo-only picker, dashboard attention

**Linear Issue Workbench**:
The issue-level Linear workspace that keeps the long-lived goal, curated
cross-run summary, run index, repository and PR references, and decisions for
one Linear issue. It is not an Agent CLI session.
_Avoid_: Codex session, transcript

**Linear Agent Run**:
One execution round for one botmux agent in one **Linear Agent Session**. It owns
its botmux Session, worker, resume context, working directory, and usage.
_Avoid_: issue, workbench

**Linear Turn**:
One normalized user input or control signal inside a **Linear Agent Run**, such
as created, prompted, stop, select, auth, approval, retry, or handoff.
_Avoid_: Lark message, terminal input

**Linear Activity Timeline**:
The Linear-visible projection of an agent run, made from Agent Activities,
Agent Plan, external links, and optional issue field updates. It is not botmux's
execution state.
_Avoid_: primary state, terminal stream

**Pending Control**:
A persisted Linear control operation with a scope, expiry, idempotency key, and
handler. Repo selection, approval, auth, stop, retry, and handoff are typed
controls; only some controls are user-facing elicitations.
_Avoid_: plain prompt, generic question

**Workbench Index**:
The canonical botmux-owned, issue-level curated index for a **Linear Issue
Workbench**. Linear-visible summaries are projections of this index, not the
execution authority.
_Avoid_: event store, full transcript

**Context Package**:
A curated, redacted handoff or recovery bundle containing the target task,
summary, relevant decisions, repository and PR references, and safe links. It
does not include raw terminal output, secrets, or another run's full transcript.
_Avoid_: transcript copy, prompt dump

**Linear Stop Turn**:
A Linear signal that asks botmux to stop the current turn for one **Linear Agent
Session**. It is a control signal, not a prompt sent to the Agent CLI.
_Avoid_: user message, issue-level close

**Token Usage**:
Token counts reported by an **Agent CLI** or its persisted transcript for a
**Session**. Token In is the Agent CLI's native input-side total, including
cache read/create tokens when the CLI reports them; Token Out is the native
output-side total. Botmux does not estimate token counts from message text.
_Avoid_: token estimate, cost estimate

**Usage Ledger**:
Append-only daily JSONL files under `~/.botmux/usage/` recording per-turn
**Token Usage** deltas per **Session**. Each record is a self-describing JSON
line (recordId, ts, session/bot/chat context, caller open_id, token deltas
plus cumulative totals). Baselines are anchored at worker spawn so resumed or
pre-botmux transcript history is never recorded. External trackers (e.g.
kaboo) consume this directory; botmux never uploads it anywhere itself.
Zero-delta records with `kind: "ownership"` are written at worker spawn (and
when the CLI-native session id is first learned) so consumers can exclude a
session from their native parsers before its first positive delta lands; they
are markers, not accounting events, and never re-seed baselines.
_Avoid_: usage log, billing database

## Example Dialogue

Dev: "This Bot uses Codex as its Agent CLI."

Domain expert: "Good. When the user replies in the same Session, botmux should
route that reply back to the same Agent CLI conversation."

Dev: "Cursor did not expose Token Usage for this Session."

Domain expert: "Then botmux should say the Token Usage is unavailable, not guess
from the visible text."
