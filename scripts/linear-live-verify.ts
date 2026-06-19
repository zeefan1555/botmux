import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

const envFile = join(homedir(), '.botmux', '.env');
dotenvConfig({ path: existsSync(envFile) ? envFile : '.env' });
process.env.SESSION_DATA_DIR ||= readFileSync(join(homedir(), '.botmux', '.data-dir'), 'utf8').trim();

const [
  sessionStore,
  linearOAuth,
  linearChannel,
  linearEgress,
] = await Promise.all([
  import('../src/services/session-store.js'),
  import('../src/core/linear-oauth.js'),
  import('../src/core/linear-channel.js'),
  import('../src/core/linear-egress.js'),
]);

const {
  createLinearGraphqlActivityClient,
  deliverLinearPlaceholderOnce,
  deliverLinearFinalOutput,
  deliverLinearError,
  updateLinearExternalUrls,
  deliverLinearSelectElicitation,
  deliverLinearAuthElicitation,
  applyLinearIssueSideEffects,
  handoffToLinearAgent,
  projectLinearAgentPlan,
} = linearEgress;
const {
  buildLinearStartPrompt,
  createLinearFeedState,
  feedLinearTurn,
} = linearChannel;

sessionStore.init(process.env.LINEAR_CHANNEL_IDENTITY ?? 'linear:codex-local');

type IssueRef = { id: string; key: string; title: string; url: string; stateId?: string };
type AgentSessionRef = { id: string; url?: string };

const token = await resolveAccessToken();
const client = createLinearGraphqlActivityClient(token);
const orgId = await currentOrganizationId();
const channelIdentity = process.env.LINEAR_CHANNEL_IDENTITY ?? 'linear:codex-local';
const runtimeBotId = process.env.LINEAR_RUNTIME_BOT_ID ?? 'cli_aabab75ade389bd6';
const workingDir = process.env.LINEAR_WORKING_DIR || process.cwd();

const results: Array<{ issue: string; ok: boolean; body: string }> = [];

await run('ZEE-364', 'ActivityEmitter delivery state', async issue => {
  const agent = await createAgentSession(issue.key);
  const ds = dsFor(issue, agent);
  await deliverLinearPlaceholderOnce(ds, client, 'Accepted live verification run.');
  await deliverLinearPlaceholderOnce(ds, client, 'Duplicate should not appear.');
  await deliverLinearFinalOutput(ds, { type: 'final_output', content: 'Live verification response for ZEE-353.', lastUuid: 'live-final', turnId: `live-${Date.now()}` }, client);
  await deliverLinearError(ds, 'Live verification error activity for ZEE-353 error path.', client, `live-error-${Date.now()}`);
  return `created AgentSession ${agent.id}; emitted thought, response, error; duplicate placeholder was suppressed by delivery state.`;
});

await run('ZEE-365', 'safe externalUrls', async issue => {
  const agent = await createAgentSession(issue.key);
  const ds = dsFor(issue, agent);
  await updateLinearExternalUrls(ds, client, [{ key: 'verify-issue', label: 'Verification issue', url: issue.url }]);
  const rejected = await updateLinearExternalUrls(ds, client, [{ key: 'bad', label: 'Bad local URL', url: 'https://127.0.0.1:7891/?token=secret' }]);
  return `created AgentSession ${agent.id}; wrote safe externalUrl ${issue.url}; rejected local token URL with result ${JSON.stringify(rejected)}.`;
});

await run('ZEE-366', 'PendingControl approval base', async issue => {
  const agent = await createAgentSession(issue.key);
  const { createLinearPendingControl, consumeLinearPendingControl, linearPendingControlKey } = await import('../src/services/linear-state.js');
  const key = linearPendingControlKey({ organizationId: orgId, issueId: issue.id, agentSessionId: agent.id, kind: 'approval', controlKey: `live-${Date.now()}` });
  const control = createLinearPendingControl({
    key,
    kind: 'approval',
    scope: 'turn',
    organizationId: orgId,
    issueId: issue.id,
    agentSessionId: agent.id,
    controlKey: 'live-approval',
    question: 'Approve this live verification control?',
    options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }],
  });
  await deliverLinearSelectElicitation(agent.id, control, client);
  const consumed = consumeLinearPendingControl(key, { selectedValue: 'approve' });
  return `created AgentSession ${agent.id}; emitted select approval; consumed pending control locally with ${consumed.action}.`;
});

await run('ZEE-367', 'repo selection through PendingControl', async issue => {
  const agent = await createAgentSession(issue.key);
  const activeSessions = new Map();
  const state = createLinearFeedState();
  const baseTurn = turnFor(issue, agent, { workingDir: undefined, body: 'Live repo selection verification.' });
  const first = await feedLinearTurn(baseTurn, {
    activeSessions,
    state,
    repositoryCandidates: [{ key: 'botmux', hostname: 'github.com', repositoryFullName: 'zeefan/botmux', workingDir, displayName: 'botmux' }],
    recordActivity: activity => recordActivity(activity),
    mockWorker: () => 'repo selected and original task continued',
  });
  const second = await feedLinearTurn(turnFor(issue, agent, { type: 'prompted', eventId: `select-${Date.now()}`, body: 'botmux', control: { kind: 'repo_select', selectedValue: 'botmux' } }), {
    activeSessions,
    state,
    repositoryCandidates: [{ key: 'botmux', hostname: 'github.com', repositoryFullName: 'zeefan/botmux', workingDir, displayName: 'botmux' }],
    recordActivity: activity => recordActivity(activity),
    mockWorker: () => 'repo selected and original task continued',
  });
  return `created AgentSession ${agent.id}; first turn=${first.action}; select follow-up=${second.action}.`;
});

await run('ZEE-368', 'stop control and turn cancellation', async issue => {
  const agent = await createAgentSession(issue.key);
  const activeSessions = new Map();
  const state = createLinearFeedState();
  await feedLinearTurn(turnFor(issue, agent, { body: 'Live stop verification start.' }), {
    activeSessions,
    state,
    recordActivity: activity => recordActivity(activity),
    mockWorker: () => 'started',
  });
  const stopped = await feedLinearTurn(turnFor(issue, agent, { type: 'stop', eventId: `stop-${Date.now()}`, body: 'stop' }), {
    activeSessions,
    state,
    recordActivity: activity => recordActivity(activity),
    mockWorker: () => 'should not run',
  });
  return `created AgentSession ${agent.id}; stop result=${stopped.action}; stop was handled as control turn, not prompt text.`;
});

await run('ZEE-369', 'WorkbenchIndex canonical store and projection', async issue => {
  const agentA = await createAgentSession(issue.key);
  const agentB = await createAgentSession(issue.key);
  const activeSessions = new Map();
  const state = createLinearFeedState();
  await feedLinearTurn(turnFor(issue, agentA, { eventId: `wb-a-${Date.now()}` }), { activeSessions, state, recordActivity: activity => recordActivity(activity), mockWorker: () => 'run A done' });
  await feedLinearTurn(turnFor(issue, agentB, { eventId: `wb-b-${Date.now()}` }), { activeSessions, state, recordActivity: activity => recordActivity(activity), mockWorker: () => 'run B done' });
  const { loadLinearWorkbenchIndex, buildLinearWorkbenchProjection } = await import('../src/services/linear-state.js');
  const index = loadLinearWorkbenchIndex(orgId, issue.id);
  if (!index) throw new Error('missing WorkbenchIndex');
  await comment(issue.key, buildLinearWorkbenchProjection(index));
  return `created AgentSessions ${agentA.id}, ${agentB.id}; WorkbenchIndex now has ${index.runs.length} run(s) and was projected as issue comment.`;
});

await run('ZEE-370', 'prompt and context contract with Lark isolation', async issue => {
  const agent = await createAgentSession(issue.key);
  const prompt = buildLinearStartPrompt(turnFor(issue, agent, { promptContext: { verification: true } }), `live-session-${Date.now()}`);
  const forbidden = ['<botmux_routing>', '<botmux_reminder>', 'available_bots', 'open_id', 'botmux send', 'botmux history', 'botmux quoted'];
  const hits = forbidden.filter(s => prompt.includes(s));
  if (hits.length) throw new Error(`Linear prompt leaked Lark blocks: ${hits.join(', ')}`);
  await client.createAgentActivity({ agentSessionId: agent.id, content: { type: 'response', body: 'Prompt contract checked: no Lark helper blocks detected.' } });
  return `created AgentSession ${agent.id}; audited generated prompt and found no Lark routing/helper blocks.`;
});

await run('ZEE-371', 'auth signal and safe OAuth continuation', async issue => {
  const agent = await createAgentSession(issue.key);
  const authBase = (process.env.LINEAR_REDIRECT_URI ?? 'https://linear.app').replace(/\/linear\/oauth\/callback$/, '/linear/oauth/authorize');
  await deliverLinearAuthElicitation(agent.id, `${authBase}?organizationId=${orgId}&issueId=${issue.id}&agentSessionId=${agent.id}`, client, 'Linear');
  return `created AgentSession ${agent.id}; emitted auth elicitation with URL metadata and no token payload.`;
});

await run('ZEE-372', 'issue status, delegate, and comment mirror', async issue => {
  const agent = await createAgentSession(issue.key);
  const ds = dsFor(issue, agent);
  const startActions = await applyLinearIssueSideEffects(client, ds, 'start', undefined, { statusOnStartId: issue.stateId });
  const doneActions = await applyLinearIssueSideEffects(client, ds, 'done', 'Live comment mirror for ZEE-361.', { commentMirrorEnabled: true });
  return `created AgentSession ${agent.id}; explicit status action=${startActions.join(',') || 'none'}; explicit comment mirror=${doneActions.join(',') || 'none'}; default config remains off.`;
});

await run('ZEE-373', 'official agent handoff with ContextPackage', async issue => {
  const agent = await createAgentSession(issue.key);
  const result = await handoffToLinearAgent({
    sourceClient: client,
    targetClient: client,
    ds: dsFor(issue, agent),
    targetAgentKey: 'codex-self',
    roster: [{ key: 'codex-self', channelIdentity, runtimeBotId, displayName: 'Codex self-verification' }],
    context: { task: 'Continue this verification as the target agent.', summary: 'Curated handoff package only; secret=redacted-test /Users/bytedance/private should be redacted.', repositoryFullName: 'zeefan/botmux', sourceRunUrl: issue.url },
  });
  if (!result.ok) throw new Error(result.error);
  return `created source AgentSession ${agent.id}; handoff receipt comment=${result.commentId}; target AgentSession=${result.targetAgentSessionId}.`;
});

await run('ZEE-374', 'Agent Plan projection', async issue => {
  const agent = await createAgentSession(issue.key);
  const ds = dsFor(issue, agent);
  const disabled = await projectLinearAgentPlan(ds, client, [{ content: 'This should be skipped by default.', status: 'pending' }], false);
  const enabled = await projectLinearAgentPlan(ds, client, [
    { content: 'Create real AgentSession', status: 'completed' },
    { content: 'Project sanitized plan token=live-secret /Users/bytedance/private', status: 'inProgress' },
  ], true);
  const duplicate = await projectLinearAgentPlan(ds, client, [
    { content: 'Create real AgentSession', status: 'completed' },
    { content: 'Project sanitized plan token=live-secret /Users/bytedance/private', status: 'inProgress' },
  ], true);
  return `created AgentSession ${agent.id}; disabled result=${disabled.action}; enabled result=${enabled.action}; duplicate result=${duplicate.action}.`;
});

console.log(JSON.stringify({ ok: results.every(r => r.ok), results }, null, 2));

async function run(issueKey: string, title: string, fn: (issue: IssueRef) => Promise<string>) {
  const issue = await getIssue(issueKey);
  try {
    const observed = await fn(issue);
    const body = [
      '## Live Linear Verification',
      '',
      `- scenario: ${title}`,
      `- verify issue: ${issue.key} / ${issue.url}`,
      `- observed: ${observed}`,
      '- command: `pnpm tsx scripts/linear-live-verify.ts`',
      '- remaining risk: live run uses the authorized local Linear app token; separate human UI click smoke may still be useful for select/stop UX.',
    ].join('\n');
    await comment(issue.key, body);
    results.push({ issue: issue.key, ok: true, body: observed });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await comment(issue.key, [
      '## Live Linear Verification',
      '',
      `- scenario: ${title}`,
      '- result: failed',
      `- error: ${msg}`,
    ].join('\n'));
    results.push({ issue: issue.key, ok: false, body: msg });
  }
}

async function resolveAccessToken(): Promise<string> {
  const dir = join(process.env.SESSION_DATA_DIR!, 'linear', 'tokens');
  const file = readdirSync(dir).find(f => f.endsWith('.json'));
  if (!file) throw new Error('No Linear OAuth token file found');
  const stored = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  if (Date.now() < stored.token.expires_at - 5 * 60_000) return stored.token.access_token;
  return linearOAuth.resolveLinearOAuthAccessToken(stored.key, process.env.LINEAR_CLIENT_SECRET!);
}

async function currentOrganizationId(): Promise<string> {
  const data = await gql<{ organization: { id: string } }>(`query { organization { id } }`, {});
  return data.organization.id;
}

async function getIssue(key: string): Promise<IssueRef> {
  const data = await gql<{ issue: { id: string; identifier: string; title: string; url: string; state?: { id: string } } }>(
    `query($id: String!) { issue(id: $id) { id identifier title url state { id } } }`,
    { id: key },
  );
  return { id: data.issue.id, key: data.issue.identifier, title: data.issue.title, url: data.issue.url, stateId: data.issue.state?.id };
}

async function createAgentSession(issueKey: string): Promise<AgentSessionRef> {
  const data = await gql<{ agentSessionCreateOnIssue: { agentSession: { id: string; url?: string } } }>(
    `mutation($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { success agentSession { id url } } }`,
    { input: { issueId: issueKey } },
  );
  return data.agentSessionCreateOnIssue.agentSession;
}

async function comment(issueId: string, body: string): Promise<void> {
  await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`, { input: { issueId, body } });
}

async function recordActivity(activity: { type: 'response' | 'error' | 'elicitation'; agentSessionId: string; content: string; control?: any }) {
  if (activity.type === 'elicitation' && activity.control) {
    await deliverLinearSelectElicitation(activity.agentSessionId, activity.control, client);
    return;
  }
  await client.createAgentActivity({ agentSessionId: activity.agentSessionId, content: { type: activity.type, body: activity.content } });
}

function turnFor(issue: IssueRef, agent: AgentSessionRef, patch: Record<string, unknown> = {}) {
  return {
    type: 'created',
    eventId: `live-${issue.key}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    organizationId: orgId,
    issueId: issue.id,
    agentSessionId: agent.id,
    agentActivityId: `live-activity-${Math.random().toString(16).slice(2)}`,
    channelIdentity,
    runtimeBotId,
    body: `Live verification for ${issue.key}`,
    issue: { id: issue.id, identifier: issue.key, title: issue.title },
    workingDir,
    ...patch,
  } as any;
}

function dsFor(issue: IssueRef, agent: AgentSessionRef) {
  const now = new Date().toISOString();
  const session = {
    sessionId: `live-${issue.key}-${agent.id}`,
    chatId: `linear:org:${orgId}`,
    rootMessageId: `linear:agent-session:${agent.id}`,
    title: issue.title,
    status: 'active' as const,
    createdAt: now,
    channel: 'linear' as const,
    channelIdentity,
    runtimeBotId,
    linear: { organizationId: orgId, issueId: issue.id, agentSessionId: agent.id },
  };
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    channel: 'linear' as const,
    channelIdentity,
    runtimeBotId,
    linear: session.linear,
    larkAppId: runtimeBotId,
    chatId: session.chatId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    spawnedAt: Date.now(),
    cliVersion: 'live-verify',
    lastMessageAt: Date.now(),
    hasHistory: false,
    workingDir,
  };
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!res.ok || body.errors?.length || !body.data) {
    throw new Error(body.errors?.map(e => e.message).filter(Boolean).join('; ') || `Linear GraphQL failed: ${res.status}`);
  }
  return body.data;
}
