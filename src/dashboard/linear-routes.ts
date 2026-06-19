import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLinearAuthorizeUrl, handleLinearOAuthCallback } from '../core/linear-oauth.js';
import { parseVerifiedLinearWebhook } from '../core/linear-webhook.js';
import { linearTurnKey } from '../core/linear-channel.js';
import { getLinearDelivery, markLinearDelivery } from '../services/linear-state.js';
import { jsonRes } from './workflow-api.js';

const MAX_LINEAR_BODY_BYTES = 512 * 1024;

export interface LinearDashboardRouteDeps {
  proxyToDaemon: (runtimeBotId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export async function handleLinearDashboardRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: LinearDashboardRouteDeps,
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (req.method === 'GET' && url.pathname === '/linear/oauth/authorize') {
    const cfg = routeConfig(env, `${url.origin}/linear/oauth/callback`);
    if (!cfg.ok) {
      jsonRes(res, 400, { ok: false, error: cfg.error });
      return true;
    }
    const authorize = createLinearAuthorizeUrl({
      ...cfg.value,
      organizationId: valueParam(url, 'organizationId'),
      issueId: valueParam(url, 'issueId'),
      agentSessionId: valueParam(url, 'agentSessionId'),
      turnId: valueParam(url, 'turnId'),
    });
    res.writeHead(302, { location: authorize.toString() });
    res.end();
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/linear/oauth/callback') {
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const secret = env.LINEAR_CLIENT_SECRET;
    if (!secret) {
      jsonRes(res, 400, { ok: false, error: 'LINEAR_CLIENT_SECRET is required' });
      return true;
    }
    try {
      const result = await handleLinearOAuthCallback(code, state, secret, deps.fetchImpl ?? fetch);
      if (!result.ok) {
        jsonRes(res, 400, result);
        return true;
      }
      const resume = await resumeAfterOAuthIfPossible(result.state, deps);
      jsonRes(res, 200, {
        ok: true,
        organizationId: result.organizationId,
        organizationName: result.organizationName,
        channelIdentity: result.state.channelIdentity,
        resumed: resume.resumed,
        resumeError: resume.error,
      });
      return true;
    } catch (err: any) {
      jsonRes(res, 400, { ok: false, error: err?.message ?? String(err) });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/linear/webhook') {
    const cfg = routeConfig(env, `${url.origin}/linear/oauth/callback`);
    if (!cfg.ok) {
      jsonRes(res, 400, { ok: false, error: cfg.error });
      return true;
    }
    const webhookSecret = env.LINEAR_WEBHOOK_SECRET;
    if (!webhookSecret) {
      jsonRes(res, 400, { ok: false, error: 'LINEAR_WEBHOOK_SECRET is required' });
      return true;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req, MAX_LINEAR_BODY_BYTES);
    } catch {
      jsonRes(res, 413, { ok: false, error: 'request body too large' });
      return true;
    }
    const parsed = parseVerifiedLinearWebhook(rawBody, req.headers, webhookSecret, {
      channelIdentity: cfg.value.channelIdentity,
      runtimeBotId: cfg.value.runtimeBotId,
      workingDir: cfg.value.workingDir,
    });
    if (!parsed.ok) {
      if (parsed.error === 'unsupported Linear webhook payload') {
        jsonRes(res, 200, { ok: true, action: 'ignored' });
        return true;
      }
      jsonRes(res, parsed.status, { ok: false, error: parsed.error });
      return true;
    }

    const deliveryKey = `webhook:${linearTurnKey(parsed.turn)}`;
    const existingDelivery = getLinearDelivery(deliveryKey);
    if (existingDelivery && existingDelivery.status !== 'failed') {
      jsonRes(res, 200, { ok: true, action: 'duplicate' });
      return true;
    }
    markLinearDelivery(deliveryKey, 'received');
    const upstream = await deps.proxyToDaemon(parsed.turn.runtimeBotId, '/api/linear/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn: parsed.turn }),
    });
    const text = await upstream.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = { ok: upstream.ok, text }; }
    markLinearDelivery(deliveryKey, upstream.ok ? 'queued' : 'failed', upstream.ok ? {} : { error: text });
    jsonRes(res, upstream.status, body);
    return true;
  }

  return false;
}

function routeConfig(env: NodeJS.ProcessEnv, fallbackRedirectUri: string): { ok: true; value: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  channelIdentity: string;
  runtimeBotId: string;
  workingDir?: string;
} } | { ok: false; error: string } {
  const clientId = env.LINEAR_CLIENT_ID;
  const clientSecret = env.LINEAR_CLIENT_SECRET;
  const runtimeBotId = env.LINEAR_RUNTIME_BOT_ID ?? env.LINEAR_RUNTIME_CONFIG_ID;
  if (!clientId) return { ok: false, error: 'LINEAR_CLIENT_ID is required' };
  if (!clientSecret) return { ok: false, error: 'LINEAR_CLIENT_SECRET is required' };
  if (!runtimeBotId) return { ok: false, error: 'LINEAR_RUNTIME_BOT_ID is required' };
  return {
    ok: true,
    value: {
      clientId,
      clientSecret,
      redirectUri: env.LINEAR_REDIRECT_URI ?? fallbackRedirectUri,
      channelIdentity: env.LINEAR_CHANNEL_IDENTITY ?? `linear:${clientId}`,
      runtimeBotId,
      workingDir: env.LINEAR_WORKING_DIR,
    },
  };
}

async function resumeAfterOAuthIfPossible(
  state: { organizationId?: string; issueId?: string; agentSessionId?: string; channelIdentity: string; runtimeBotId: string; workingDir?: string; turnId?: string },
  deps: LinearDashboardRouteDeps,
): Promise<{ resumed: boolean; error?: string }> {
  if (!state.organizationId || !state.issueId || !state.agentSessionId) return { resumed: false };
  const eventId = `oauth:${state.turnId ?? state.agentSessionId}`;
  const upstream = await deps.proxyToDaemon(state.runtimeBotId, '/api/linear/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      turn: {
        type: 'prompted',
        eventId,
        organizationId: state.organizationId,
        issueId: state.issueId,
        agentSessionId: state.agentSessionId,
        channelIdentity: state.channelIdentity,
        runtimeBotId: state.runtimeBotId,
        body: 'Linear OAuth authorization completed. Continue the blocked task.',
        promptContext: { linearAuthCompleted: true },
        workingDir: state.workingDir,
      },
    }),
  });
  if (!upstream.ok) return { resumed: false, error: await upstream.text() };
  return { resumed: true };
}

function valueParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value || undefined;
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
