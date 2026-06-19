import { randomBytes } from 'node:crypto';
import { consumeLinearOAuthState, readStoredLinearOAuthToken, saveLinearOAuthState, saveLinearOAuthToken, type LinearOAuthStateRecord, type LinearTokenKey } from '../services/linear-state.js';

const LINEAR_OAUTH_SCOPE = 'read,write,app:assignable,app:mentionable';

export interface LinearOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  channelIdentity: string;
  runtimeBotId: string;
  workingDir?: string;
  organizationId?: string;
  issueId?: string;
  agentSessionId?: string;
  turnId?: string;
}

export interface LinearOAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export function createLinearAuthorizeUrl(config: LinearOAuthConfig, now = Date.now()): URL {
  const state = randomBytes(16).toString('hex');
  saveLinearOAuthState({
    state,
    clientId: config.clientId,
    channelIdentity: config.channelIdentity,
    runtimeBotId: config.runtimeBotId,
    redirectUri: config.redirectUri,
    workingDir: config.workingDir,
    organizationId: config.organizationId,
    issueId: config.issueId,
    agentSessionId: config.agentSessionId,
    turnId: config.turnId,
    createdAt: now,
  });

  const url = new URL('https://linear.app/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', LINEAR_OAUTH_SCOPE);
  url.searchParams.set('actor', 'app');
  url.searchParams.set('state', state);
  return url;
}

export async function handleLinearOAuthCallback(
  code: string,
  state: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; organizationId: string; organizationName?: string; state: LinearOAuthStateRecord } | { ok: false; error: string }> {
  const saved = consumeLinearOAuthState(state);
  if (!saved) return { ok: false, error: 'invalid or expired OAuth state' };
  if (!code) return { ok: false, error: 'missing OAuth code' };

  const token = await exchangeLinearOAuthCode(code, { ...saved, clientSecret }, fetchImpl);
  const org = await fetchLinearOrganization(token.access_token, fetchImpl);
  saveLinearOAuthToken({
    organizationId: org.id,
    clientId: saved.clientId,
    channelIdentity: saved.channelIdentity,
  }, {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    scope: token.scope,
    expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
  });
  return { ok: true, organizationId: org.id, organizationName: org.name, state: saved };
}

export async function resolveLinearOAuthAccessToken(
  key: LinearTokenKey,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string | null> {
  const stored = readStoredLinearOAuthToken(key);
  if (!stored) return null;
  if (now < stored.expires_at - 5 * 60 * 1000) return stored.access_token;
  if (!stored.refresh_token) return null;
  const refreshed = await refreshLinearOAuthToken(stored.refresh_token, key.clientId, clientSecret, fetchImpl);
  saveLinearOAuthToken(key, {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    token_type: refreshed.token_type,
    scope: refreshed.scope ?? stored.scope,
    expires_at: now + (refreshed.expires_in ?? 3600) * 1000,
  });
  return refreshed.access_token;
}

async function exchangeLinearOAuthCode(
  code: string,
  config: Pick<LinearOAuthConfig, 'clientId' | 'clientSecret' | 'redirectUri'>,
  fetchImpl: typeof fetch,
): Promise<LinearOAuthTokenResponse> {
  const res = await fetchImpl('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Linear OAuth token exchange failed: ${await res.text()}`);
  const token = await res.json() as LinearOAuthTokenResponse;
  if (!token.access_token) throw new Error('Linear OAuth token response missing access_token');
  return token;
}

async function refreshLinearOAuthToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<LinearOAuthTokenResponse> {
  const res = await fetchImpl('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Linear OAuth token refresh failed: ${await res.text()}`);
  const token = await res.json() as LinearOAuthTokenResponse;
  if (!token.access_token) throw new Error('Linear OAuth refresh response missing access_token');
  return token;
}

async function fetchLinearOrganization(accessToken: string, fetchImpl: typeof fetch): Promise<{ id: string; name?: string }> {
  const res = await fetchImpl('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: 'query BotmuxLinearOrganization { organization { id name } }' }),
  });
  if (!res.ok) throw new Error(`Linear organization lookup failed: ${res.status}`);
  const body = await res.json() as { data?: { organization?: { id?: string; name?: string } }; errors?: Array<{ message?: string }> };
  if (body.errors?.length) throw new Error(body.errors.map(e => e.message).filter(Boolean).join('; ') || 'Linear organization lookup failed');
  const org = body.data?.organization;
  if (!org?.id) throw new Error('Linear organization lookup missing organization id');
  return { id: org.id, name: org.name };
}
