import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import * as sessionStore from '../services/session-store.js';
import { config, type LinearAgentRosterEntry } from '../config.js';
import { getLinearDelivery, markLinearDelivery, updateLinearWorkbenchRun } from '../services/linear-state.js';
import type { LinearPendingControlRecord } from '../services/linear-state.js';
import type { WorkerToDaemon } from '../types.js';
import type { DaemonSession } from './types.js';

export type LinearAgentActivityContent =
  | { type: 'thought'; body: string }
  | { type: 'elicitation'; body: string }
  | { type: 'response'; body: string }
  | { type: 'error'; body: string };

export interface LinearAgentActivityClient {
  createAgentActivity(input: {
    agentSessionId: string;
    content: LinearAgentActivityContent;
    signal?: 'select' | 'auth';
    signalMetadata?: { options?: Array<{ label?: string; value: string }>; url?: string; userId?: string; providerName?: string };
  }): Promise<{ id?: string }>;
}

export interface LinearExternalUrl {
  key: string;
  label: string;
  url: string;
}

export type LinearAgentPlanStepStatus = 'pending' | 'inProgress' | 'completed' | 'canceled';

export interface LinearAgentPlanStep {
  content: string;
  status: LinearAgentPlanStepStatus;
}

export interface LinearSessionClient {
  updateAgentSessionExternalUrls(input: {
    agentSessionId: string;
    externalUrls: Array<{ label: string; url: string }>;
  }): Promise<{ externalUrls?: Array<{ label: string; url: string }> }>;
  updateAgentSessionPlan(input: {
    agentSessionId: string;
    plan: LinearAgentPlanStep[];
  }): Promise<void>;
}

export interface LinearIssueClient {
  updateIssue(input: { issueId: string; stateId?: string; delegateId?: string }): Promise<void>;
  createIssueComment(input: { issueId: string; body: string }): Promise<{ id?: string }>;
}

export interface LinearAgentSessionClient {
  createAgentSessionOnIssue(input: {
    issueId: string;
    externalUrls?: Array<{ label: string; url: string }>;
  }): Promise<{ id?: string; url?: string }>;
  createAgentSessionOnComment(input: {
    commentId: string;
    externalUrls?: Array<{ label: string; url: string }>;
  }): Promise<{ id?: string; url?: string }>;
}

export interface LinearGraphqlClient extends LinearAgentActivityClient, LinearSessionClient, LinearIssueClient, LinearAgentSessionClient {}

export interface LinearIssueSideEffectConfig {
  statusOnStartId?: string;
  statusOnDoneId?: string;
  statusOnErrorId?: string;
  delegateSelfId?: string;
  commentMirrorEnabled?: boolean;
}

export type LinearEgressResult =
  | { ok: true; action: 'delivered'; activityId?: string }
  | { ok: true; action: 'duplicate' }
  | { ok: false; action: 'skipped' | 'failed'; error: string };

export interface LinearHandoffContext {
  task: string;
  summary?: string;
  repositoryFullName?: string;
  sourceRunUrl?: string;
}

export type LinearHandoffResult =
  | { ok: true; action: 'delivered'; targetAgentSessionId?: string; commentId?: string }
  | { ok: true; action: 'duplicate'; targetAgentSessionId?: string; commentId?: string }
  | { ok: false; action: 'skipped' | 'failed'; error: string };

export interface LinearActivityEmitter {
  placeholderOnce(ds: DaemonSession, body?: string): Promise<LinearEgressResult>;
  thought(ds: DaemonSession, body: string, key: string): Promise<LinearEgressResult>;
  finalOutput(ds: DaemonSession, msg: Extract<WorkerToDaemon, { type: 'final_output' }>): Promise<LinearEgressResult>;
  error(ds: DaemonSession, message: string, turnKey?: string): Promise<LinearEgressResult>;
  externalUrls(ds: DaemonSession, urls: LinearExternalUrl[]): Promise<LinearEgressResult>;
  selectElicitation(agentSessionId: string, control: LinearPendingControlRecord): Promise<LinearEgressResult>;
  authElicitation(agentSessionId: string, authUrl: string, providerName?: string): Promise<LinearEgressResult>;
}

export function createLinearActivityEmitter(client: LinearGraphqlClient): LinearActivityEmitter {
  return {
    placeholderOnce: (ds, body) => deliverLinearPlaceholderOnce(ds, client, body),
    thought: (ds, body, key) => deliverLinearThought(ds, body, client, key),
    finalOutput: (ds, msg) => deliverLinearFinalOutput(ds, msg, client),
    error: (ds, message, turnKey) => deliverLinearError(ds, message, client, turnKey),
    externalUrls: (ds, urls) => updateLinearExternalUrls(ds, client, urls),
    selectElicitation: (agentSessionId, control) => deliverLinearSelectElicitation(agentSessionId, control, client),
    authElicitation: (agentSessionId, authUrl, providerName) => deliverLinearAuthElicitation(agentSessionId, authUrl, client, providerName),
  };
}

export function createLinearGraphqlActivityClient(accessToken: string, fetchImpl: typeof fetch = fetch): LinearGraphqlClient {
  return {
    async createAgentActivity(input) {
      const res = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation BotmuxAgentActivityCreate($input: AgentActivityCreateInput!) {
            agentActivityCreate(input: $input) {
              success
              agentActivity { id }
            }
          }`,
          variables: { input },
        }),
      });
      if (!res.ok) throw new Error(`Linear activity create failed: ${res.status}`);
      const body = await res.json() as { data?: { agentActivityCreate?: { agentActivity?: { id?: string } } }; errors?: Array<{ message?: string }> };
      if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear activity create failed');
      return { id: body.data?.agentActivityCreate?.agentActivity?.id };
    },
    async updateAgentSessionExternalUrls(input) {
      const res = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
	          query: `mutation BotmuxAgentSessionExternalUrls($agentSessionId: String!, $data: AgentSessionUpdateInput!) {
	            agentSessionUpdate(id: $agentSessionId, input: $data) {
	              success
	              agentSession { id }
	            }
	          }`,
	          variables: { agentSessionId: input.agentSessionId, data: { externalUrls: input.externalUrls } },
	        }),
	      });
	      if (!res.ok) throw new Error(`Linear agent session update failed: ${res.status}`);
	      const body = await res.json() as {
	        data?: { agentSessionUpdate?: { agentSession?: { id?: string } } };
	        errors?: Array<{ message?: string }>;
	      };
	      if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear agent session update failed');
	      return { externalUrls: input.externalUrls };
	    },
    async updateAgentSessionPlan(input) {
      const res = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation BotmuxAgentSessionPlan($agentSessionId: String!, $data: AgentSessionUpdateInput!) {
            agentSessionUpdate(id: $agentSessionId, input: $data) { success agentSession { id } }
          }`,
          variables: { agentSessionId: input.agentSessionId, data: { plan: input.plan } },
        }),
      });
      if (!res.ok) throw new Error(`Linear agent session plan update failed: ${res.status}`);
      const body = await res.json() as { errors?: Array<{ message?: string }> };
      if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear agent session plan update failed');
    },
    async updateIssue(input) {
      const data: Record<string, string> = {};
      if (input.stateId) data.stateId = input.stateId;
      if (input.delegateId) data.delegateId = input.delegateId;
      if (!Object.keys(data).length) return;
      const res = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation BotmuxIssueUpdate($issueId: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $issueId, input: $input) { success issue { id } }
          }`,
          variables: { issueId: input.issueId, input: data },
        }),
      });
      if (!res.ok) throw new Error(`Linear issue update failed: ${res.status}`);
      const body = await res.json() as { errors?: Array<{ message?: string }> };
      if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear issue update failed');
    },
    async createIssueComment(input) {
      const res = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation BotmuxCommentCreate($input: CommentCreateInput!) {
            commentCreate(input: $input) { success comment { id } }
          }`,
          variables: { input: { issueId: input.issueId, body: input.body } },
        }),
      });
      if (!res.ok) throw new Error(`Linear comment create failed: ${res.status}`);
      const body = await res.json() as { data?: { commentCreate?: { comment?: { id?: string } } }; errors?: Array<{ message?: string }> };
      if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear comment create failed');
      return { id: body.data?.commentCreate?.comment?.id };
    },
    async createAgentSessionOnIssue(input) {
      const res = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation BotmuxAgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
            agentSessionCreateOnIssue(input: $input) {
              success
              agentSession { id url }
            }
          }`,
          variables: { input },
        }),
      });
      if (!res.ok) throw new Error(`Linear agent session create on issue failed: ${res.status}`);
      const body = await res.json() as { data?: { agentSessionCreateOnIssue?: { agentSession?: { id?: string; url?: string } } }; errors?: Array<{ message?: string }> };
      if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear agent session create on issue failed');
      return { id: body.data?.agentSessionCreateOnIssue?.agentSession?.id, url: body.data?.agentSessionCreateOnIssue?.agentSession?.url };
    },
    async createAgentSessionOnComment(input) {
      const res = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation BotmuxAgentSessionCreateOnComment($input: AgentSessionCreateOnComment!) {
            agentSessionCreateOnComment(input: $input) {
              success
              agentSession { id url }
            }
          }`,
          variables: { input },
        }),
      });
      if (!res.ok) throw new Error(`Linear agent session create on comment failed: ${res.status}`);
      const body = await res.json() as { data?: { agentSessionCreateOnComment?: { agentSession?: { id?: string; url?: string } } }; errors?: Array<{ message?: string }> };
      if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear agent session create on comment failed');
      return { id: body.data?.agentSessionCreateOnComment?.agentSession?.id, url: body.data?.agentSessionCreateOnComment?.agentSession?.url };
    },
  };
}

export async function handoffToLinearAgent(input: {
  sourceClient: LinearIssueClient;
  targetClient: LinearAgentSessionClient;
  ds: DaemonSession;
  targetAgentKey: string;
  context: LinearHandoffContext;
  roster?: LinearAgentRosterEntry[];
}): Promise<LinearHandoffResult> {
  const issueId = input.ds.linear?.issueId;
  if (!issueId) return { ok: false, action: 'skipped', error: 'missing Linear issueId' };
  const target = (input.roster ?? config.linear.agents).find(agent => agent.key === input.targetAgentKey);
  if (!target) return { ok: false, action: 'skipped', error: `unknown Linear agent: ${input.targetAgentKey}` };
  if (!input.context.task.trim()) return { ok: false, action: 'skipped', error: 'handoff task is required' };

  const key = linearHandoffDeliveryKey(input.ds, target, input.context);
  const existing = getLinearDelivery(key);
  if (existing?.status === 'delivered') {
    return { ok: true, action: 'duplicate', targetAgentSessionId: existing.targetId, commentId: existing.activityId };
  }

  markLinearDelivery(key, 'queued');
  try {
    const body = buildLinearHandoffReceipt(input.ds, target, input.context);
    const comment = await input.sourceClient.createIssueComment({ issueId, body });
    if (!comment.id) throw new Error('Linear handoff comment did not return an id');
    const created = await input.targetClient.createAgentSessionOnComment({ commentId: comment.id });
    markLinearDelivery(key, 'delivered', { activityId: comment.id, targetId: created.id });
    return { ok: true, action: 'delivered', targetAgentSessionId: created.id, commentId: comment.id };
  } catch (err: any) {
    markLinearDelivery(key, 'failed', { error: err?.message ?? String(err) });
    return { ok: false, action: 'failed', error: err?.message ?? String(err) };
  }
}

export async function applyLinearIssueSideEffects(
  client: LinearIssueClient,
  ds: DaemonSession,
  event: 'start' | 'done' | 'error',
  body?: string,
  cfg: LinearIssueSideEffectConfig = config.linear.issueSideEffects,
): Promise<string[]> {
  const issueId = ds.linear?.issueId;
  if (!issueId) return [];
  const stateId = event === 'start' ? cfg.statusOnStartId : event === 'done' ? cfg.statusOnDoneId : cfg.statusOnErrorId;
  const actions: string[] = [];
  if (stateId || cfg.delegateSelfId) {
    await client.updateIssue({ issueId, stateId, delegateId: event === 'start' ? cfg.delegateSelfId : undefined });
    if (stateId) actions.push(`status:${event}`);
    if (event === 'start' && cfg.delegateSelfId) actions.push('delegate:self');
  }
  if (event === 'done' && cfg.commentMirrorEnabled && body?.trim()) {
    await client.createIssueComment({ issueId, body });
    actions.push('comment:mirror');
  }
  return actions;
}

export function suppressStoppedLinearFinalOutput(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
): boolean {
  const linear = ds.linear ?? ds.session.linear;
  if (ds.channel !== 'linear' || !linear?.cancelledTurnId || !msg.turnId) return false;
  if (linear.cancelledTurnId !== msg.turnId) return false;
  if (linear.stopState !== 'requested' && linear.stopState !== 'sent_to_worker' && linear.stopState !== 'stopped') return false;
  ds.linear = { ...linear, stopState: 'stopped' };
  ds.session.linear = ds.linear;
  sessionStore.updateSession(ds.session);
  return true;
}

export async function deliverLinearPlaceholderOnce(
  ds: DaemonSession,
  client: LinearAgentActivityClient,
  body = 'Accepted. Starting Codex.',
): Promise<LinearEgressResult> {
  const agentSessionId = ds.linear?.agentSessionId;
  if (!agentSessionId) return { ok: false, action: 'skipped', error: 'missing Linear agentSessionId' };
  return deliverOnce(ds, client, `linear:placeholder:${agentSessionId}`, agentSessionId, { type: 'thought', body }, 'lastActivityId');
}

export async function deliverLinearThought(
  ds: DaemonSession,
  body: string,
  client: LinearAgentActivityClient,
  key: string,
): Promise<LinearEgressResult> {
  const agentSessionId = ds.linear?.agentSessionId;
  if (!agentSessionId) return { ok: false, action: 'skipped', error: 'missing Linear agentSessionId' };
  return deliverOnce(ds, client, `linear:thought:${agentSessionId}:${key}`, agentSessionId, { type: 'thought', body }, 'lastActivityId');
}

export async function deliverLinearFinalOutput(
  ds: DaemonSession,
  msg: Extract<WorkerToDaemon, { type: 'final_output' }>,
  client: LinearAgentActivityClient,
): Promise<LinearEgressResult> {
  const agentSessionId = ds.linear?.agentSessionId;
  if (!agentSessionId) return { ok: false, action: 'skipped', error: 'missing Linear agentSessionId' };
  const result = await deliverOnce(ds, client, `linear:response:${agentSessionId}:${msg.turnId || msg.lastUuid}`, agentSessionId, { type: 'response', body: msg.content }, 'lastResponseActivityId');
  if (result.ok && result.action === 'delivered') {
    updateWorkbenchFromSession(ds, 'completed', msg.turnId, result.activityId);
  }
  return result;
}

export async function deliverLinearError(
  ds: DaemonSession,
  message: string,
  client: LinearAgentActivityClient,
  turnKey = 'error',
): Promise<LinearEgressResult> {
  const agentSessionId = ds.linear?.agentSessionId;
  if (!agentSessionId) return { ok: false, action: 'skipped', error: 'missing Linear agentSessionId' };
  const result = await deliverOnce(ds, client, `linear:error:${agentSessionId}:${turnKey}`, agentSessionId, { type: 'error', body: message }, 'lastActivityId');
  if (result.ok && result.action === 'delivered') {
    updateWorkbenchFromSession(ds, 'error', turnKey, result.activityId);
  }
  return result;
}

export async function deliverLinearSelectElicitation(
  agentSessionId: string,
  control: LinearPendingControlRecord,
  client: LinearAgentActivityClient,
): Promise<LinearEgressResult> {
  if (getLinearDelivery(`linear:elicitation:${control.key}`)?.status === 'delivered') return { ok: true, action: 'duplicate' };
  markLinearDelivery(`linear:elicitation:${control.key}`, 'queued');
  try {
    const activity = await client.createAgentActivity({
      agentSessionId,
      content: { type: 'elicitation', body: control.question },
      signal: 'select',
      signalMetadata: {
        options: (control.options ?? []).map(option => ({ label: option.label, value: option.value })),
      },
    });
    markLinearDelivery(`linear:elicitation:${control.key}`, 'delivered', { activityId: activity.id });
    return { ok: true, action: 'delivered', activityId: activity.id };
  } catch (err: any) {
    markLinearDelivery(`linear:elicitation:${control.key}`, 'failed', { error: err?.message ?? String(err) });
    return { ok: false, action: 'failed', error: err?.message ?? String(err) };
  }
}

export async function deliverLinearAuthElicitation(
  agentSessionId: string,
  authUrl: string,
  client: LinearAgentActivityClient,
  providerName = 'Linear',
): Promise<LinearEgressResult> {
  const key = `linear:auth:${agentSessionId}:${createHash('sha256').update(authUrl).digest('hex').slice(0, 16)}`;
  if (getLinearDelivery(key)?.status === 'delivered') return { ok: true, action: 'duplicate' };
  markLinearDelivery(key, 'queued');
  try {
    const activity = await client.createAgentActivity({
      agentSessionId,
      content: { type: 'elicitation', body: 'Please authenticate to continue.' },
      signal: 'auth',
      signalMetadata: { url: authUrl, providerName },
    });
    markLinearDelivery(key, 'delivered', { activityId: activity.id });
    return { ok: true, action: 'delivered', activityId: activity.id };
  } catch (err: any) {
    markLinearDelivery(key, 'failed', { error: err?.message ?? String(err) });
    return { ok: false, action: 'failed', error: err?.message ?? String(err) };
  }
}

export function buildLinearSessionExternalUrl(ds: DaemonSession, publicBaseUrl = config.linear.publicBaseUrl): LinearExternalUrl | null {
  if (!publicBaseUrl.trim()) return null;
  const url = `${publicBaseUrl.replace(/\/+$/, '')}/#/sessions?sessionId=${encodeURIComponent(ds.session.sessionId)}`;
  const safe = normalizeLinearExternalUrl(url);
  if (!safe.ok) return null;
  return { key: 'dashboard-session', label: 'Botmux session', url: safe.url };
}

export function buildLinearTerminalExternalUrl(ds: DaemonSession, publicBaseUrl = config.linear.publicTerminalBaseUrl): LinearExternalUrl | null {
  if (!publicBaseUrl.trim()) return null;
  const url = `${publicBaseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(ds.session.sessionId)}`;
  const safe = normalizeLinearExternalUrl(url);
  if (!safe.ok) return null;
  return { key: 'terminal-readonly', label: 'Read-only terminal', url: safe.url };
}

export function buildLinearSessionExternalUrls(ds: DaemonSession): LinearExternalUrl[] {
  return [
    buildLinearTerminalExternalUrl(ds),
  ].filter((url): url is LinearExternalUrl => !!url);
}

export async function updateLinearExternalUrls(
  ds: DaemonSession,
  client: LinearSessionClient,
  urls: LinearExternalUrl[],
): Promise<LinearEgressResult> {
  const agentSessionId = ds.linear?.agentSessionId;
  if (!agentSessionId) return { ok: false, action: 'skipped', error: 'missing Linear agentSessionId' };
  const normalized = normalizeLinearExternalUrls(urls);
  if (!normalized.ok) return { ok: false, action: 'skipped', error: normalized.error };
  if (!normalized.urls.length) return { ok: false, action: 'skipped', error: 'no externalUrls' };

  const merged = mergeLinearExternalUrls(ds.linear?.externalUrls ?? [], normalized.urls);
  const key = `linear:externalUrls:${agentSessionId}:${hashExternalUrls(merged)}`;
  if (getLinearDelivery(key)?.status === 'delivered') return { ok: true, action: 'duplicate' };
  markLinearDelivery(key, 'queued');
  try {
    await client.updateAgentSessionExternalUrls({
      agentSessionId,
      externalUrls: merged.map(({ label, url }) => ({ label, url })),
    });
    markLinearDelivery(key, 'delivered');
    ds.linear = { ...ds.linear!, externalUrls: merged };
    ds.session.linear = ds.linear;
    sessionStore.updateSession(ds.session);
    return { ok: true, action: 'delivered' };
  } catch (err: any) {
    markLinearDelivery(key, 'failed', { error: err?.message ?? String(err) });
    return { ok: false, action: 'failed', error: err?.message ?? String(err) };
  }
}

export async function projectLinearAgentPlan(
  ds: DaemonSession,
  client: LinearSessionClient,
  steps: LinearAgentPlanStep[],
  enabled = config.linear.agentPlan.enabled,
): Promise<LinearEgressResult> {
  if (!enabled) return { ok: false, action: 'skipped', error: 'Linear Agent Plan projection is disabled' };
  const agentSessionId = ds.linear?.agentSessionId;
  if (!agentSessionId) return { ok: false, action: 'skipped', error: 'missing Linear agentSessionId' };
  const normalized = normalizeLinearAgentPlan(steps);
  if (!normalized.length) return { ok: false, action: 'skipped', error: 'no Agent Plan steps' };
  const key = `linear:plan:${agentSessionId}:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)}`;
  if (getLinearDelivery(key)?.status === 'delivered') return { ok: true, action: 'duplicate' };
  markLinearDelivery(key, 'queued');
  try {
    await client.updateAgentSessionPlan({ agentSessionId, plan: normalized });
    markLinearDelivery(key, 'delivered');
    return { ok: true, action: 'delivered' };
  } catch (err: any) {
    markLinearDelivery(key, 'failed', { error: err?.message ?? String(err) });
    return { ok: false, action: 'failed', error: err?.message ?? String(err) };
  }
}

async function deliverOnce(
  ds: DaemonSession,
  client: LinearAgentActivityClient,
  key: string,
  agentSessionId: string,
  content: LinearAgentActivityContent,
  metadataField: 'lastActivityId' | 'lastResponseActivityId',
): Promise<LinearEgressResult> {
  if (getLinearDelivery(key)?.status === 'delivered') return { ok: true, action: 'duplicate' };
  markLinearDelivery(key, 'queued');
  try {
    const activity = await client.createAgentActivity({ agentSessionId, content });
    markLinearDelivery(key, 'delivered', { activityId: activity.id });
    ds.linear = { ...ds.linear!, [metadataField]: activity.id };
    ds.session.linear = ds.linear;
    sessionStore.updateSession(ds.session);
    return { ok: true, action: 'delivered', activityId: activity.id };
  } catch (err: any) {
    markLinearDelivery(key, 'failed', { error: err?.message ?? String(err) });
    return { ok: false, action: 'failed', error: err?.message ?? String(err) };
  }
}

function normalizeLinearAgentPlan(steps: LinearAgentPlanStep[]): LinearAgentPlanStep[] {
  const allowed = new Set<LinearAgentPlanStepStatus>(['pending', 'inProgress', 'completed', 'canceled']);
  const out: LinearAgentPlanStep[] = [];
  for (const step of steps.slice(0, 20)) {
    if (!allowed.has(step.status)) continue;
    const content = safeText(step.content.trim(), 500);
    if (!content) continue;
    out.push({ content, status: step.status });
  }
  return out;
}

function updateWorkbenchFromSession(
  ds: DaemonSession,
  status: Parameters<typeof updateLinearWorkbenchRun>[0]['status'],
  turnId?: string,
  activityId?: string,
): void {
  if (!ds.linear?.organizationId || !ds.linear.issueId || !ds.linear.agentSessionId) return;
  updateLinearWorkbenchRun({
    organizationId: ds.linear.organizationId,
    issueId: ds.linear.issueId,
    agentSessionId: ds.linear.agentSessionId,
    sessionId: ds.session.sessionId,
    channelIdentity: ds.channelIdentity,
    runtimeBotId: ds.runtimeBotId,
    status,
    turnId,
    activityId,
  });
}

function linearHandoffDeliveryKey(ds: DaemonSession, target: LinearAgentRosterEntry, context: LinearHandoffContext): string {
  const source = ds.linear?.agentSessionId ?? ds.session.sessionId;
  const issueId = ds.linear?.issueId ?? ds.session.rootMessageId;
  const hash = createHash('sha256')
    .update(JSON.stringify({
      task: context.task,
      summary: context.summary,
      repositoryFullName: context.repositoryFullName,
    }))
    .digest('hex')
    .slice(0, 16);
  return `linear:handoff:${issueId}:${source}:${target.key}:${hash}`;
}

function buildLinearHandoffReceipt(ds: DaemonSession, target: LinearAgentRosterEntry, context: LinearHandoffContext): string {
  const sourceRun = ds.linear?.agentSessionId ?? ds.session.sessionId;
  const targetName = target.displayName ?? target.key;
  const sourceUrl = context.sourceRunUrl ? normalizeLinearExternalUrl(context.sourceRunUrl) : null;
  const safeSourceUrl = sourceUrl?.ok ? sourceUrl.url : undefined;
  return [
    `## Botmux handoff to ${safeText(targetName, 120)}`,
    '',
    `Source AgentSession: ${safeText(sourceRun, 120)}`,
    `Target agent: ${safeText(targetName, 120)} (${safeText(target.channelIdentity, 160)})`,
    context.repositoryFullName ? `Repository: ${safeText(context.repositoryFullName, 200)}` : undefined,
    safeSourceUrl ? `Source run: ${safeSourceUrl}` : undefined,
    '',
    '### Task',
    safeText(context.task, 2000),
    context.summary ? ['', '### Context', safeText(context.summary, 4000)] : undefined,
    '',
    '_This is a curated handoff package. It excludes raw transcripts, terminal output, secrets, write links, and unvalidated local paths._',
  ].flat().filter(Boolean).join('\n');
}

function safeText(value: string, max: number): string {
  return value
    .replace(/((?:access_)?token|refresh_token|secret|password|api[_-]?key)\s*[:=]\s*([^\s`]+)/gi, '$1=[redacted]')
    .replace(/\/(?:Users|home|tmp|var|private)\/[^\s`)]+/g, '[local-path]')
    .slice(0, max);
}

function normalizeLinearExternalUrls(urls: LinearExternalUrl[]): { ok: true; urls: LinearExternalUrl[] } | { ok: false; error: string } {
  const out: LinearExternalUrl[] = [];
  for (const raw of urls) {
    const key = raw.key.trim();
    const label = raw.label.trim();
    if (!key || !label) return { ok: false, error: 'externalUrl key and label are required' };
    const safe = normalizeLinearExternalUrl(raw.url);
    if (!safe.ok) return safe;
    out.push({ key, label, url: safe.url });
  }
  return { ok: true, urls: out };
}

export function normalizeLinearExternalUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'externalUrl must be absolute' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'externalUrl must use https' };
  if (isPrivateHost(url.hostname)) return { ok: false, error: 'externalUrl host must be public' };
  const blockedParams = ['token', 't', 'secret', 'key', 'auth', 'access_token'];
  for (const param of blockedParams) {
    if (url.searchParams.has(param)) return { ok: false, error: `externalUrl contains blocked query param: ${param}` };
  }
  url.username = '';
  url.password = '';
  url.hash = url.hash ? url.hash : '';
  return { ok: true, url: url.href };
}

function mergeLinearExternalUrls(existing: LinearExternalUrl[], incoming: LinearExternalUrl[]): LinearExternalUrl[] {
  const byKey = new Map(existing.map(url => [url.key, url]));
  for (const url of incoming) byKey.set(url.key, url);
  const seenUrls = new Set<string>();
  const merged: LinearExternalUrl[] = [];
  for (const url of byKey.values()) {
    if (seenUrls.has(url.url)) continue;
    seenUrls.add(url.url);
    merged.push(url);
  }
  return merged.sort((a, b) => a.key.localeCompare(b.key));
}

function hashExternalUrls(urls: LinearExternalUrl[]): string {
  return createHash('sha256').update(JSON.stringify(urls)).digest('hex').slice(0, 16);
}

function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  const ip = isIP(normalized);
  if (ip === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (ip === 6) return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  return false;
}
