import type { WorkerToDaemon } from '../types.js';
import { logger as defaultLogger } from '../utils/logger.js';
import {
  applyLinearIssueSideEffects,
  buildLinearSessionExternalUrls,
  createLinearActivityEmitter,
  suppressStoppedLinearFinalOutput,
  type LinearEgressResult,
  type LinearGraphqlClient,
} from './linear-egress.js';
import type { DaemonSession } from './types.js';
import type { LinearPendingControlRecord } from '../services/linear-state.js';

export type LinearRunEvent =
  | { type: 'accepted' }
  | { type: 'worker_ready' }
  | { type: 'status_update'; body: string; key: string }
  | { type: 'final_response'; msg: Extract<WorkerToDaemon, { type: 'final_output' }> }
  | { type: 'error'; message: string; turnKey?: string };

type ProjectorLogger = Pick<typeof defaultLogger, 'info' | 'warn'>;

export interface LinearRunStatusProjectorDeps {
  clientForSession: (ds: DaemonSession) => Promise<LinearGraphqlClient | null>;
  logger?: ProjectorLogger;
}

export interface LinearIdentityProjectorDeps {
  clientForIdentity: (input: { organizationId?: string; channelIdentity?: string; sessionId?: string }) => Promise<LinearGraphqlClient | null>;
  logger?: ProjectorLogger;
}

export type LinearRunProjectionResult =
  | LinearEgressResult
  | { ok: true; action: 'suppressed' };

function sessionTag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

export async function projectLinearRunEvent(
  ds: DaemonSession,
  event: LinearRunEvent,
  deps: LinearRunStatusProjectorDeps,
): Promise<LinearRunProjectionResult> {
  const log = deps.logger ?? defaultLogger;

  if (event.type === 'final_response' && suppressStoppedLinearFinalOutput(ds, event.msg)) {
    log.info(`[${sessionTag(ds)}] Linear final_response suppressed for stopped turn ${event.msg.turnId}`);
    return { ok: true, action: 'suppressed' };
  }

  const client = await deps.clientForSession(ds);
  if (!client) {
    log.warn(`[${sessionTag(ds)}] Linear ${event.type} projection skipped: missing Linear access token`);
    return { ok: false, action: 'skipped', error: 'missing_linear_token' };
  }

  const emitter = createLinearActivityEmitter(client);
  switch (event.type) {
    case 'accepted': {
      const result = await emitter.placeholderOnce(ds);
      if (result.ok) await applyLinearIssueSideEffects(client, ds, 'start');
      return result;
    }
    case 'worker_ready': {
      const urls = buildLinearSessionExternalUrls(ds);
      const result = await emitter.thought(ds, 'Codex started. Terminal is ready.', 'codex-ready');
      if (urls.length) await emitter.externalUrls(ds, urls);
      return result;
    }
    case 'status_update':
      return emitter.thought(ds, event.body, event.key);
    case 'final_response': {
      const result = await emitter.finalOutput(ds, event.msg);
      if (result.ok && result.action === 'delivered') {
        await applyLinearIssueSideEffects(client, ds, 'done', event.msg.content);
      }
      return result;
    }
    case 'error': {
      const result = await emitter.error(ds, event.message, event.turnKey);
      if (result.ok && result.action === 'delivered') {
        await applyLinearIssueSideEffects(client, ds, 'error');
      }
      return result;
    }
  }
}

export async function projectLinearAwaitingInput(
  input: {
    organizationId: string;
    channelIdentity: string;
    agentSessionId: string;
    control: LinearPendingControlRecord;
  },
  deps: LinearIdentityProjectorDeps,
): Promise<LinearRunProjectionResult> {
  const log = deps.logger ?? defaultLogger;
  const client = await deps.clientForIdentity({
    organizationId: input.organizationId,
    channelIdentity: input.channelIdentity,
  });
  if (!client) {
    log.warn(`[linear] ${input.control.kind} elicitation skipped: missing Linear access token`);
    return { ok: false, action: 'skipped', error: 'missing_linear_token' };
  }
  return createLinearActivityEmitter(client).selectElicitation(input.agentSessionId, input.control);
}
