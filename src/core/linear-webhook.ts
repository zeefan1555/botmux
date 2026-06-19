import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LinearFeedTurn, LinearTurnType } from './linear-channel.js';

export interface NormalizeLinearWebhookOptions {
  channelIdentity: string;
  runtimeBotId: string;
  workingDir?: string;
  deliveryId?: string;
}

export type LinearWebhookParseResult =
  | { ok: true; turn: LinearFeedTurn; payload: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export function verifyLinearWebhookSignature(rawBody: string | Buffer, signature: string | null | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseVerifiedLinearWebhook(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  opts: NormalizeLinearWebhookOptions,
  now = Date.now(),
): LinearWebhookParseResult {
  const signature = headerValue(headers, 'linear-signature');
  if (!verifyLinearWebhookSignature(rawBody, signature, secret)) {
    return { ok: false, status: 401, error: 'invalid Linear webhook signature' };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, error: 'invalid Linear webhook JSON' };
  }
  if (!isRecentLinearWebhookTimestamp(payload.webhookTimestamp, now)) {
    return { ok: false, status: 401, error: 'stale Linear webhook timestamp' };
  }
  const turn = normalizeLinearAgentSessionEvent(payload, {
    ...opts,
    deliveryId: opts.deliveryId ?? headerValue(headers, 'linear-delivery'),
  });
  return turn ? { ok: true, turn, payload } : { ok: false, status: 400, error: 'unsupported Linear webhook payload' };
}

export function isRecentLinearWebhookTimestamp(value: unknown, now = Date.now(), toleranceMs = 60_000): boolean {
  const ts = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(ts) && Math.abs(now - ts) <= toleranceMs;
}

export function normalizeLinearAgentSessionEvent(
  payload: Record<string, unknown>,
  opts: NormalizeLinearWebhookOptions,
): LinearFeedTurn | null {
  const organizationId = stringAt(payload, 'organizationId') ?? stringAt(payload, 'organization.id');
  const agentSession = objectAt(payload, 'agentSession') ?? objectAt(payload, 'data.agentSession');
  if (!organizationId || !agentSession) return null;

  const agentSessionId = stringAt(agentSession, 'id');
  const issue = objectAt(agentSession, 'issue');
  const issueId = stringAt(issue, 'id');
  if (!agentSessionId || !issueId) return null;

  const agentActivity = objectAt(payload, 'agentActivity') ?? objectAt(payload, 'activity') ?? objectAt(payload, 'data.agentActivity');
  const agentActivityId = stringAt(agentActivity, 'id');
  const type = normalizeTurnType(
    stringAt(payload, 'action') ?? stringAt(payload, 'type'),
    stringAt(agentActivity, 'signal') ?? stringAt(payload, 'signal'),
  );
  const agentActivityBody = stringAt(agentActivity, 'content.body') ?? stringAt(agentActivity, 'body');
  const body = type === 'prompted'
    ? agentActivityBody
      ?? stringAt(payload, 'prompt')
      ?? stringAt(payload, 'body')
      ?? stringAt(agentSession, 'comment.body')
      ?? stringAt(issue, 'description')
      ?? stringAt(issue, 'title')
      ?? ''
    : stringAt(payload, 'prompt')
      ?? stringAt(payload, 'body')
      ?? agentActivityBody
      ?? stringAt(agentSession, 'comment.body')
      ?? stringAt(issue, 'description')
      ?? stringAt(issue, 'title')
      ?? '';

  return {
    type,
    eventId: opts.deliveryId ?? stringAt(payload, 'id') ?? agentActivityId,
    organizationId,
    issueId,
    agentSessionId,
    agentActivityId,
    channelIdentity: opts.channelIdentity,
    runtimeBotId: opts.runtimeBotId,
    body,
    promptContext: payload.promptContext ?? null,
    issue: {
      id: issueId,
      identifier: stringAt(issue, 'identifier'),
      title: stringAt(issue, 'title'),
      description: stringAt(issue, 'description'),
    },
    workingDir: opts.workingDir,
  };
}

function normalizeTurnType(value: string | undefined, signal?: string): LinearTurnType {
  if (signal?.toLowerCase() === 'stop') return 'stop';
  return value?.toLowerCase().includes('prompt') ? 'prompted' : 'created';
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const found = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function objectAt(value: unknown, path: string): Record<string, unknown> | undefined {
  const v = path.split('.').reduce<unknown>((cur, key) => (
    cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[key] : undefined
  ), value);
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function stringAt(value: unknown, path: string): string | undefined {
  const v = path.split('.').reduce<unknown>((cur, key) => (
    cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[key] : undefined
  ), value);
  return typeof v === 'string' && v ? v : undefined;
}
