import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface LinearTokenKey {
  organizationId: string;
  clientId: string;
  channelIdentity: string;
}

export interface LinearOAuthTokenData {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at: number;
}

export type LinearDeliveryStatus = 'received' | 'queued' | 'delivered' | 'failed';

export interface LinearDeliveryRecord {
  key: string;
  status: LinearDeliveryStatus;
  updatedAt: string;
  activityId?: string;
  targetId?: string;
  error?: string;
}

export interface LinearOAuthStateRecord {
  state: string;
  clientId: string;
  channelIdentity: string;
  runtimeBotId: string;
  redirectUri: string;
  workingDir?: string;
  organizationId?: string;
  issueId?: string;
  agentSessionId?: string;
  turnId?: string;
  createdAt: number;
}

export type LinearPendingControlKind = 'choice' | 'free_text' | 'approval';
export type LinearPendingControlScope = 'turn' | 'run' | 'workbench' | 'workspace';
export type LinearPendingControlStatus = 'pending' | 'consumed' | 'expired' | 'failed';

export interface LinearPendingControlOption {
  value: string;
  label: string;
}

export interface LinearPendingControlRecord {
  key: string;
  kind: LinearPendingControlKind;
  scope: LinearPendingControlScope;
  organizationId: string;
  issueId?: string;
  agentSessionId?: string;
  turnId?: string;
  controlKey: string;
  question: string;
  options?: LinearPendingControlOption[];
  originalTurn?: unknown;
  status: LinearPendingControlStatus;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  selectedValue?: string;
  answerText?: string;
  error?: string;
}

export type LinearPendingControlConsumeResult =
  | { ok: true; action: 'consumed' | 'duplicate'; record: LinearPendingControlRecord }
  | { ok: false; action: 'missing' | 'expired' | 'invalid' | 'failed'; error: string; record?: LinearPendingControlRecord };

export type LinearWorkbenchRunStatus = 'awaiting_input' | 'queued' | 'stopped' | 'completed' | 'error';

export interface LinearWorkbenchRun {
  agentSessionId: string;
  sessionId?: string;
  channelIdentity?: string;
  runtimeBotId?: string;
  status: LinearWorkbenchRunStatus;
  firstSeenAt: string;
  updatedAt: string;
  lastTurnId?: string;
  lastActivityId?: string;
}

export interface LinearWorkbenchRepoBinding {
  repositoryKey: string;
  repositoryFullName: string;
  selectedByAgentSessionId?: string;
  selectedAt: string;
}

export interface LinearWorkbenchIndex {
  version: 1;
  organizationId: string;
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  updatedAt: string;
  runs: LinearWorkbenchRun[];
  repoBinding?: LinearWorkbenchRepoBinding;
  decisions: Array<{ key: string; summary: string; updatedAt: string }>;
}

const TOKEN_BUFFER_MS = 5 * 60 * 1000;

export function saveLinearOAuthToken(key: LinearTokenKey, token: LinearOAuthTokenData): void {
  writeJson(tokenPath(key), { key, token });
}

export function loadLinearOAuthToken(key: LinearTokenKey, now = Date.now()): LinearOAuthTokenData | null {
  const token = readStoredLinearOAuthToken(key);
  if (!token) return null;
  if (now >= token.expires_at - TOKEN_BUFFER_MS) return null;
  return token;
}

export function readStoredLinearOAuthToken(key: LinearTokenKey): LinearOAuthTokenData | null {
  const data = readJson<{ key: LinearTokenKey; token: LinearOAuthTokenData }>(tokenPath(key));
  if (!data || data.key.organizationId !== key.organizationId || data.key.clientId !== key.clientId || data.key.channelIdentity !== key.channelIdentity) {
    return null;
  }
  return data.token;
}

export function markLinearDelivery(key: string, status: LinearDeliveryStatus, patch: Omit<Partial<LinearDeliveryRecord>, 'key' | 'status' | 'updatedAt'> = {}): LinearDeliveryRecord {
  const record: LinearDeliveryRecord = { key, status, updatedAt: new Date().toISOString(), ...patch };
  writeJson(deliveryPath(key), record);
  return record;
}

export function getLinearDelivery(key: string): LinearDeliveryRecord | null {
  return readJson<LinearDeliveryRecord>(deliveryPath(key));
}

export function claimLinearDelivery(key: string): boolean {
  // ponytail: single-daemon file claim; add file locking if parallel webhook workers share dataDir.
  if (getLinearDelivery(key)) return false;
  markLinearDelivery(key, 'received');
  return true;
}

export function linearPendingControlKey(input: {
  organizationId: string;
  issueId?: string;
  agentSessionId?: string;
  turnId?: string;
  kind: LinearPendingControlKind;
  controlKey: string;
}): string {
  return [
    input.organizationId,
    input.issueId ?? '-',
    input.agentSessionId ?? '-',
    input.turnId ?? '-',
    input.kind,
    input.controlKey,
  ].join(':');
}

export function createLinearPendingControl(input: Omit<LinearPendingControlRecord, 'status' | 'createdAt' | 'expiresAt'> & {
  ttlMs?: number;
  now?: number;
}): LinearPendingControlRecord {
  const existing = getLinearPendingControl(input.key);
  if (existing?.status === 'pending') return existing;
  const now = input.now ?? Date.now();
  const { ttlMs, now: _now, ...rest } = input;
  const record: LinearPendingControlRecord = {
    ...rest,
    status: 'pending',
    createdAt: now,
    expiresAt: now + (ttlMs ?? 30 * 60 * 1000),
  };
  writeJson(pendingControlPath(record.key), record);
  return record;
}

export function getLinearPendingControl(key: string): LinearPendingControlRecord | null {
  return readJson<LinearPendingControlRecord>(pendingControlPath(key));
}

export function consumeLinearPendingControl(key: string, answer: { selectedValue?: string; answerText?: string }, now = Date.now()): LinearPendingControlConsumeResult {
  const record = getLinearPendingControl(key);
  if (!record) return { ok: false, action: 'missing', error: 'pending control not found' };
  if (record.status === 'consumed') return { ok: true, action: 'duplicate', record };
  if (record.status !== 'pending') return { ok: false, action: 'failed', error: `pending control is ${record.status}`, record };
  if (now > record.expiresAt) {
    const expired = { ...record, status: 'expired' as const };
    writeJson(pendingControlPath(key), expired);
    return { ok: false, action: 'expired', error: 'pending control expired', record: expired };
  }
  const selectedValue = answer.selectedValue?.trim();
  if ((record.kind === 'choice' || record.kind === 'approval') && selectedValue) {
    const allowed = new Set((record.options ?? []).map(option => option.value));
    if (!allowed.has(selectedValue)) return { ok: false, action: 'invalid', error: 'selected value is not a pending option', record };
  }
  if ((record.kind === 'choice' || record.kind === 'approval') && !selectedValue) {
    return { ok: false, action: 'invalid', error: 'selected value is required', record };
  }
  const consumed: LinearPendingControlRecord = {
    ...record,
    status: 'consumed',
    consumedAt: now,
    selectedValue,
    answerText: answer.answerText,
  };
  writeJson(pendingControlPath(key), consumed);
  return { ok: true, action: 'consumed', record: consumed };
}

export function linearStateFileMode(path: string): number | null {
  try { return statSync(path).mode & 0o777; } catch { return null; }
}

export function linearTokenPathForTest(key: LinearTokenKey): string {
  return tokenPath(key);
}

export function loadLinearWorkbenchIndex(organizationId: string, issueId: string): LinearWorkbenchIndex | null {
  return readJson<LinearWorkbenchIndex>(workbenchPath(organizationId, issueId));
}

export function updateLinearWorkbenchRun(input: {
  organizationId: string;
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  agentSessionId: string;
  sessionId?: string;
  channelIdentity?: string;
  runtimeBotId?: string;
  status: LinearWorkbenchRunStatus;
  turnId?: string;
  activityId?: string;
  repoBinding?: Omit<LinearWorkbenchRepoBinding, 'selectedAt'> & { selectedAt?: string };
  now?: number;
}): LinearWorkbenchIndex {
  const at = new Date(input.now ?? Date.now()).toISOString();
  const index = loadLinearWorkbenchIndex(input.organizationId, input.issueId) ?? {
    version: 1 as const,
    organizationId: input.organizationId,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    issueTitle: input.issueTitle,
    updatedAt: at,
    runs: [],
    decisions: [],
  };
  index.issueIdentifier = input.issueIdentifier ?? index.issueIdentifier;
  index.issueTitle = input.issueTitle ?? index.issueTitle;
  index.updatedAt = at;

  const existing = index.runs.find(run => run.agentSessionId === input.agentSessionId);
  const nextRun: LinearWorkbenchRun = {
    ...(existing ?? { agentSessionId: input.agentSessionId, firstSeenAt: at, updatedAt: at, status: input.status }),
    sessionId: input.sessionId ?? existing?.sessionId,
    channelIdentity: input.channelIdentity ?? existing?.channelIdentity,
    runtimeBotId: input.runtimeBotId ?? existing?.runtimeBotId,
    status: input.status,
    updatedAt: at,
    lastTurnId: input.turnId ?? existing?.lastTurnId,
    lastActivityId: input.activityId ?? existing?.lastActivityId,
  };
  if (existing) {
    index.runs = index.runs.map(run => run.agentSessionId === input.agentSessionId ? nextRun : run);
  } else {
    index.runs.push(nextRun);
  }
  index.runs.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));

  if (input.repoBinding) {
    index.repoBinding = {
      repositoryKey: input.repoBinding.repositoryKey,
      repositoryFullName: input.repoBinding.repositoryFullName,
      selectedByAgentSessionId: input.repoBinding.selectedByAgentSessionId,
      selectedAt: input.repoBinding.selectedAt ?? at,
    };
  }

  writeJson(workbenchPath(input.organizationId, input.issueId), index);
  return index;
}

export function buildLinearWorkbenchProjection(index: LinearWorkbenchIndex): string {
  const title = [index.issueIdentifier, index.issueTitle].filter(Boolean).join(' ') || index.issueId;
  const lines = [
    `## Botmux Workbench Summary`,
    '',
    `Issue: ${title}`,
    index.repoBinding ? `Repository: ${index.repoBinding.repositoryFullName} (${index.repoBinding.repositoryKey})` : 'Repository: not selected',
    `Agent runs: ${index.runs.length}`,
    '',
    ...index.runs.map(run => `- ${run.agentSessionId}: ${run.status}${run.sessionId ? `, session ${run.sessionId}` : ''}`),
  ];
  return lines.join('\n');
}

export function saveLinearOAuthState(record: LinearOAuthStateRecord): void {
  writeJson(oauthStatePath(record.state), record);
}

export function consumeLinearOAuthState(state: string, now = Date.now()): LinearOAuthStateRecord | null {
  const path = oauthStatePath(state);
  const record = readJson<LinearOAuthStateRecord>(path);
  try { unlinkSync(path); } catch { /* consumed or absent */ }
  if (!record || record.state !== state) return null;
  if (now - record.createdAt > 10 * 60 * 1000) return null;
  return record;
}

function tokenPath(key: LinearTokenKey): string {
  return join(linearStateDir(), 'tokens', `${safe(key.organizationId)}--${safe(key.clientId)}--${safe(key.channelIdentity)}.json`);
}

function deliveryPath(key: string): string {
  return join(linearStateDir(), 'delivery', `${safe(key)}.json`);
}

function oauthStatePath(state: string): string {
  return join(linearStateDir(), 'oauth-state', `${safe(state)}.json`);
}

function pendingControlPath(key: string): string {
  return join(linearStateDir(), 'pending-controls', `${safe(key)}.json`);
}

function workbenchPath(organizationId: string, issueId: string): string {
  return join(linearStateDir(), 'workbenches', safe(organizationId), `${safe(issueId)}.json`);
}

function linearStateDir(): string {
  return join(config.session.dataDir, 'linear');
}

function safe(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}
