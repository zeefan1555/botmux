import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLinearDashboardRoute } from '../src/dashboard/linear-routes.js';
import { resolveLinearOAuthAccessToken } from '../src/core/linear-oauth.js';
import { getLinearDelivery, loadLinearOAuthToken, saveLinearOAuthState, saveLinearOAuthToken } from '../src/services/linear-state.js';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;

const env = {
  LINEAR_CLIENT_ID: 'client_1',
  LINEAR_CLIENT_SECRET: 'secret_1',
  LINEAR_WEBHOOK_SECRET: 'webhook_secret',
  LINEAR_RUNTIME_BOT_ID: 'runtime_bot',
  LINEAR_CHANNEL_IDENTITY: 'linear:codex',
  LINEAR_WORKING_DIR: '/tmp',
} as NodeJS.ProcessEnv;

async function startLinearServer(opts: { proxyToDaemon?: any; fetchImpl?: any } = {}): Promise<void> {
  const proxyToDaemon = opts.proxyToDaemon ?? vi.fn(async () => new Response(JSON.stringify({ ok: true, action: 'queued' }), { status: 200 }));
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (await handleLinearDashboardRoute(req, res, url, {
      proxyToDaemon,
      fetchImpl: opts.fetchImpl,
      env,
    })) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad test server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => {
  prevDataDir = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-linear-routes-'));
  process.env.SESSION_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Linear dashboard routes', () => {
  it('creates an app-actor authorize URL and stores callback tokens locally', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'access_1',
          refresh_token: 'refresh_1',
          expires_in: 3600,
          token_type: 'Bearer',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { organization: { id: 'org_1', name: 'Org 1' } } }), { status: 200 });
    });
    await startLinearServer({ fetchImpl });

    const authorize = await fetch(`${baseUrl}/linear/oauth/authorize`, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get('location')!);
    expect(location.origin).toBe('https://linear.app');
    expect(location.searchParams.get('actor')).toBe('app');
    expect(location.searchParams.get('scope')).toBe('read,write,app:assignable,app:mentionable');
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await fetch(`${baseUrl}/linear/oauth/callback?code=code_1&state=${state}`);
    expect(callback.status).toBe(200);
    expect(await callback.json()).toMatchObject({ ok: true, organizationId: 'org_1', channelIdentity: 'linear:codex' });
    expect(loadLinearOAuthToken({ organizationId: 'org_1', clientId: 'client_1', channelIdentity: 'linear:codex' })?.access_token).toBe('access_1');
  });

  it('resumes the same AgentSession after contextual OAuth callback', async () => {
    const proxyToDaemon = vi.fn(async () => new Response(JSON.stringify({ ok: true, action: 'queued' }), { status: 200 }));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'access_1', refresh_token: 'refresh_1', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { organization: { id: 'org_1', name: 'Org 1' } } }), { status: 200 });
    });
    await startLinearServer({ proxyToDaemon, fetchImpl });

    const authorize = await fetch(`${baseUrl}/linear/oauth/authorize?organizationId=org_1&issueId=issue_1&agentSessionId=agent_session_1&turnId=turn_1`, { redirect: 'manual' });
    const location = new URL(authorize.headers.get('location')!);
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await fetch(`${baseUrl}/linear/oauth/callback?code=code_1&state=${state}`);
    expect(callback.status).toBe(200);
    expect(await callback.json()).toMatchObject({ ok: true, organizationId: 'org_1', resumed: true });
    expect(proxyToDaemon).toHaveBeenCalledWith('runtime_bot', '/api/linear/turn', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(proxyToDaemon.mock.calls[0][2].body);
    expect(body.turn).toMatchObject({
      type: 'prompted',
      eventId: 'oauth:turn_1',
      organizationId: 'org_1',
      issueId: 'issue_1',
      agentSessionId: 'agent_session_1',
      channelIdentity: 'linear:codex',
      runtimeBotId: 'runtime_bot',
      body: 'Linear OAuth authorization completed. Continue the blocked task.',
      promptContext: { linearAuthCompleted: true },
      workingDir: '/tmp',
    });
  });

  it('rejects duplicate or expired OAuth callbacks without token exchange', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'access_1', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { organization: { id: 'org_1' } } }), { status: 200 });
    });
    await startLinearServer({ fetchImpl });

    saveLinearOAuthState({
      state: 'expired_state',
      clientId: 'client_1',
      channelIdentity: 'linear:codex',
      runtimeBotId: 'runtime_bot',
      redirectUri: `${baseUrl}/linear/oauth/callback`,
      createdAt: Date.now() - 11 * 60 * 1000,
    });
    const expired = await fetch(`${baseUrl}/linear/oauth/callback?code=code_1&state=expired_state`);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ ok: false, error: 'invalid or expired OAuth state' });

    const authorize = await fetch(`${baseUrl}/linear/oauth/authorize`, { redirect: 'manual' });
    const state = new URL(authorize.headers.get('location')!).searchParams.get('state');
    const first = await fetch(`${baseUrl}/linear/oauth/callback?code=code_1&state=${state}`);
    expect(first.status).toBe(200);
    const duplicate = await fetch(`${baseUrl}/linear/oauth/callback?code=code_1&state=${state}`);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ ok: false, error: 'invalid or expired OAuth state' });
  });

  it('verifies Linear webhooks, proxies normalized turns once, and dedupes delivery retries', async () => {
    const proxyToDaemon = vi.fn(async () => new Response(JSON.stringify({ ok: true, action: 'queued' }), { status: 200 }));
    await startLinearServer({ proxyToDaemon });
    const now = Date.now();
    const raw = JSON.stringify({
      webhookTimestamp: now,
      organizationId: 'org_1',
      action: 'created',
      agentSession: {
        id: 'agent_session_1',
        comment: { body: 'Start work' },
        issue: { id: 'issue_1', identifier: 'ZEE-1', title: 'Workbench' },
      },
    });
    const signature = createHmac('sha256', env.LINEAR_WEBHOOK_SECRET!).update(raw).digest('hex');

    const first = await fetch(`${baseUrl}/linear/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'linear-signature': signature, 'linear-delivery': 'delivery_1' },
      body: raw,
    });
    const second = await fetch(`${baseUrl}/linear/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'linear-signature': signature, 'linear-delivery': 'delivery_1' },
      body: raw,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, action: 'duplicate' });
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
    expect(proxyToDaemon).toHaveBeenCalledWith('runtime_bot', '/api/linear/turn', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
    const body = JSON.parse(proxyToDaemon.mock.calls[0][2].body);
    expect(body.turn).toMatchObject({
      eventId: 'delivery_1',
      organizationId: 'org_1',
      issueId: 'issue_1',
      agentSessionId: 'agent_session_1',
      channelIdentity: 'linear:codex',
      runtimeBotId: 'runtime_bot',
      body: 'Start work',
      workingDir: '/tmp',
    });
  });

  it('allows Linear webhook retries after a failed daemon proxy attempt', async () => {
    const proxyToDaemon = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'daemon_down' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, action: 'queued' }), { status: 200 }));
    await startLinearServer({ proxyToDaemon });
    const now = Date.now();
    const raw = JSON.stringify({
      webhookTimestamp: now,
      organizationId: 'org_1',
      action: 'prompted',
      agentSession: {
        id: 'agent_session_1',
        comment: { body: 'Retry work' },
        issue: { id: 'issue_1', identifier: 'ZEE-1', title: 'Workbench' },
      },
    });
    const signature = createHmac('sha256', env.LINEAR_WEBHOOK_SECRET!).update(raw).digest('hex');
    const headers = { 'content-type': 'application/json', 'linear-signature': signature, 'linear-delivery': 'delivery_retry' };

    const first = await fetch(`${baseUrl}/linear/webhook`, { method: 'POST', headers, body: raw });
    expect(first.status).toBe(503);
    expect(getLinearDelivery('webhook:delivery_retry')?.status).toBe('failed');

    const second = await fetch(`${baseUrl}/linear/webhook`, { method: 'POST', headers, body: raw });
    expect(second.status).toBe(200);
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
    expect(getLinearDelivery('webhook:delivery_retry')?.status).toBe('queued');
  });

  it('acks unsupported Linear webhooks without proxying them to daemon', async () => {
    const proxyToDaemon = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await startLinearServer({ proxyToDaemon });
    const raw = JSON.stringify({
      webhookTimestamp: Date.now(),
      organizationId: 'org_1',
      action: 'create',
      data: {
        id: 'comment_1',
        body: 'Agent response',
        issue: { id: 'issue_1', identifier: 'ZEE-1', title: 'Workbench' },
      },
    });
    const signature = createHmac('sha256', env.LINEAR_WEBHOOK_SECRET!).update(raw).digest('hex');

    const res = await fetch(`${baseUrl}/linear/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'linear-signature': signature, 'linear-delivery': 'delivery_comment' },
      body: raw,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'ignored' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('refreshes stored Linear OAuth tokens inside the safety buffer', async () => {
    const key = { organizationId: 'org_1', clientId: 'client_1', channelIdentity: 'linear:codex' };
    saveLinearOAuthToken(key, {
      access_token: 'old_access',
      refresh_token: 'refresh_1',
      expires_at: Date.now() + 10_000,
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new_access',
      refresh_token: 'refresh_2',
      expires_in: 3600,
    }), { status: 200 }));

    await expect(resolveLinearOAuthAccessToken(key, 'secret_1', fetchImpl as any)).resolves.toBe('new_access');
    expect(loadLinearOAuthToken(key)?.access_token).toBe('new_access');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.linear.app/oauth/token', expect.objectContaining({ method: 'POST' }));
  });
});
