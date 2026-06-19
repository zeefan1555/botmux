import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as sessionStore from '../src/services/session-store.js';
import {
  buildLinearStartPrompt,
  createLinearFeedState,
  feedLinearTurn,
  linearRepositoryCandidatesFromScanRoots,
  linearAgentSessionAnchorId,
  linearRepoSelectControlKey,
  type LinearActivityRecord,
  type LinearFeedTurn,
} from '../src/core/linear-channel.js';
import { buildWorkerForkEnvForSession, linearActivitySourceForWorkerMessage, runtimeBotIdForSession } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { activeSessionKey } from '../src/core/types.js';
import { restoreActiveSessions } from '../src/core/session-manager.js';
import {
  claimLinearDelivery,
  buildLinearWorkbenchProjection,
  consumeLinearPendingControl,
  createLinearPendingControl,
  getLinearDelivery,
  getLinearPendingControl,
  loadLinearWorkbenchIndex,
  linearStateFileMode,
  linearPendingControlKey,
  linearTokenPathForTest,
  loadLinearOAuthToken,
  markLinearDelivery,
  saveLinearOAuthToken,
} from '../src/services/linear-state.js';
import { parseVerifiedLinearWebhook, verifyLinearWebhookSignature } from '../src/core/linear-webhook.js';
import {
  buildLinearSessionExternalUrl,
  buildLinearSessionExternalUrls,
  buildLinearTerminalExternalUrl,
  createLinearActivityEmitter,
  deliverLinearAuthElicitation,
  deliverLinearError,
  deliverLinearFinalOutput,
  deliverLinearPlaceholderOnce,
  deliverLinearSelectElicitation,
  handoffToLinearAgent,
  normalizeLinearExternalUrl,
  applyLinearIssueSideEffects,
  projectLinearAgentPlan,
  suppressStoppedLinearFinalOutput,
  updateLinearExternalUrls,
  type LinearAgentActivityClient,
  type LinearAgentSessionClient,
  type LinearIssueClient,
  type LinearSessionClient,
} from '../src/core/linear-egress.js';
import { projectLinearAwaitingInput, projectLinearRunEvent } from '../src/core/linear-run-status-projector.js';
import { applyLinearProjectConfigToTurn, buildLinearProjectPromptContext, parseLinearProjectBotmuxConfig } from '../src/core/linear-project-config.js';
import type { LinearRepositoryConfig } from '../src/config.js';

let dataDir: string;
let workingDir: string;
let previousLarkAppId: string | undefined;
let previousLarkAppSecret: string | undefined;
let previousLinearPublicBaseUrl: string | undefined;
let previousLinearPublicTerminalBaseUrl: string | undefined;

beforeEach(() => {
  previousLarkAppId = process.env.LARK_APP_ID;
  previousLarkAppSecret = process.env.LARK_APP_SECRET;
  previousLinearPublicBaseUrl = process.env.LINEAR_PUBLIC_BASE_URL;
  previousLinearPublicTerminalBaseUrl = process.env.LINEAR_PUBLIC_TERMINAL_BASE_URL;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-linear-data-'));
  workingDir = mkdtempSync(join(tmpdir(), 'botmux-linear-work-'));
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init('linear-test');
});

afterEach(() => {
  sessionStore.init();
  delete process.env.SESSION_DATA_DIR;
  if (previousLarkAppId === undefined) delete process.env.LARK_APP_ID;
  else process.env.LARK_APP_ID = previousLarkAppId;
  if (previousLarkAppSecret === undefined) delete process.env.LARK_APP_SECRET;
  else process.env.LARK_APP_SECRET = previousLarkAppSecret;
  if (previousLinearPublicBaseUrl === undefined) delete process.env.LINEAR_PUBLIC_BASE_URL;
  else process.env.LINEAR_PUBLIC_BASE_URL = previousLinearPublicBaseUrl;
  if (previousLinearPublicTerminalBaseUrl === undefined) delete process.env.LINEAR_PUBLIC_TERMINAL_BASE_URL;
  else process.env.LINEAR_PUBLIC_TERMINAL_BASE_URL = previousLinearPublicTerminalBaseUrl;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workingDir, { recursive: true, force: true });
});

function turn(overrides: Partial<LinearFeedTurn> = {}): LinearFeedTurn {
  return {
    type: 'created',
    eventId: 'evt_1',
    organizationId: 'org_1',
    issueId: 'issue_1',
    agentSessionId: 'agent_session_1',
    agentActivityId: 'activity_1',
    channelIdentity: 'linear:codex',
    runtimeBotId: 'codex-bot',
    body: 'Fix this issue',
    promptContext: { source: 'test' },
    issue: { identifier: 'ZEE-1', title: 'Linear workbench' },
    workingDir,
    ...overrides,
  };
}

function repoCandidate(overrides: Partial<LinearRepositoryConfig> = {}): LinearRepositoryConfig {
  return {
    key: 'botmux',
    hostname: 'github.com',
    repositoryFullName: 'zeefan/botmux',
    workingDir,
    displayName: 'botmux',
    ...overrides,
  };
}

describe('Linear Channel fake feed loop', () => {
  it('keys runtime sessions by AgentSession and channel identity', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(({ turn }) => `done:${turn.body}`);

    const first = await feedLinearTurn(turn(), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      currentCliVersion: () => 'test-cli',
    });
    const sameAgentSession = await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_2',
      agentActivityId: 'activity_2',
      body: 'Continue in the same agent session',
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      currentCliVersion: () => 'test-cli',
    });
    const newTopLevelSession = await feedLinearTurn(turn({
      eventId: 'evt_3',
      agentSessionId: 'agent_session_2',
      agentActivityId: 'activity_3',
      body: 'New top-level agent session',
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      currentCliVersion: () => 'test-cli',
    });
    const otherAgent = await feedLinearTurn(turn({
      eventId: 'evt_4',
      agentSessionId: 'agent_session_3',
      agentActivityId: 'activity_4',
      channelIdentity: 'linear:traex',
      runtimeBotId: 'traex-bot',
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      currentCliVersion: () => 'test-cli',
    });

    expect(first.ok && sameAgentSession.ok && newTopLevelSession.ok && otherAgent.ok).toBe(true);
    if (!first.ok || !sameAgentSession.ok || !newTopLevelSession.ok || !otherAgent.ok) throw new Error('unexpected feed failure');
    expect(first.sessionId).toBe(sameAgentSession.sessionId);
    expect(newTopLevelSession.sessionId).not.toBe(first.sessionId);
    expect(otherAgent.sessionId).not.toBe(first.sessionId);
    expect(activeSessions.size).toBe(3);
    expect(sameAgentSession.prompt).toContain('<turn_type>follow_up</turn_type>');
    expect(newTopLevelSession.prompt).toContain('<turn_type>start</turn_type>');
    expect(activeSessions.get(`${linearAgentSessionAnchorId('agent_session_1')}::linear:codex`)?.linear?.agentSessionId).toBe('agent_session_1');
    expect(activeSessions.get(`${linearAgentSessionAnchorId('agent_session_2')}::linear:codex`)?.linear?.agentSessionId).toBe('agent_session_2');
    expect(activities.map(a => a.content)).toEqual([
      'done:Fix this issue',
      'done:Continue in the same agent session',
      'done:New top-level agent session',
      'done:Fix this issue',
    ]);
  });

  it('builds a Linear-native prompt without Lark helper blocks', () => {
    const prompt = buildLinearStartPrompt(turn({ body: 'Please inspect <repo>' }), 'session_1');

    expect(prompt).toContain('<linear_channel_contract>');
    expect(prompt).toContain('<linear_context>');
    expect(prompt).toContain('<linear_issue trusted="false">');
    expect(prompt).toContain('<prompt_context trusted="false">');
    expect(prompt).toContain('<workbench_context trusted="true">');
    expect(prompt).toContain('<user_message trusted="false">');
    expect(prompt).toContain('Please inspect <repo>');
    expect(prompt).not.toContain('<botmux_routing>');
    expect(prompt).not.toContain('<botmux_reminder>');
    expect(prompt).not.toContain('available_bots');
    expect(prompt).not.toContain('open_id');
    expect(prompt).not.toContain('botmux send');
    expect(prompt).not.toContain('botmux history');
    expect(prompt).not.toContain('botmux quoted');
    expect(prompt).not.toContain('<sender');
  });

  it('injects Project background into Linear prompt without treating botmux config as instructions', () => {
    const project = {
      id: 'project_1',
      name: 'Linear Workbench',
      content: [
        '# Project Background',
        'Use Project-level product context for every issue.',
        '',
        '```yaml',
        'botmux:',
        '  repo: should-not-enter-prompt',
        '  repoSelection: auto',
        '```',
        '',
        '<!-- botmux:workbench-summary:start -->',
        '## Botmux Workbench Summary',
        '- Latest run verified repo config.',
        '<!-- botmux:workbench-summary:end -->',
      ].join('\n'),
    };

    const prompt = buildLinearStartPrompt(turn({
      issue: { identifier: 'ZEE-1', title: 'Linear workbench', project },
    }), 'session_1');

    expect(buildLinearProjectPromptContext(project)).toMatchObject({
      projectId: 'project_1',
      projectName: 'Linear Workbench',
      background: expect.stringContaining('Use Project-level product context'),
      workbenchSummary: expect.stringContaining('Latest run verified repo config'),
    });
    expect(prompt).toContain('<linear_project_context trusted="false">');
    expect(prompt).toContain('Use Project-level product context for every issue.');
    expect(prompt).toContain('Latest run verified repo config.');
    expect(prompt).not.toContain('should-not-enter-prompt');
    expect(prompt).not.toContain('repoSelection');
  });

  it('injects curated WorkbenchIndex context into Linear prompt without replaying prior raw user text', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();

    await feedLinearTurn(turn({ body: 'Prior raw terminal SECRET=abc123' }), {
      activeSessions,
      state,
      mockWorker: vi.fn(() => 'done'),
      currentCliVersion: () => 'test-cli',
    });

    const prompt = buildLinearStartPrompt(turn({
      eventId: 'evt_next',
      agentSessionId: 'agent_session_2',
      agentActivityId: 'activity_2',
      body: 'Use the workbench summary',
    }), 'session_2');

    expect(prompt).toContain('<workbench_context trusted="true">');
    expect(prompt).toContain('"agentSessionId": "agent_session_1"');
    expect(prompt).toContain('"status": "completed"');
    expect(prompt).not.toContain('SECRET=abc123');
    expect(prompt).not.toContain('Prior raw terminal');
  });

  it('requires a configured workingDir before starting the fake worker', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(() => 'should not run');

    const result = await feedLinearTurn(turn({ workingDir: undefined }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
    });
    const duplicate = await feedLinearTurn(turn({ workingDir: undefined }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
    });

    expect(result.ok).toBe(false);
    expect(duplicate).toEqual({ ok: true, action: 'duplicate', turnKey: 'evt_1', sessionId: undefined });
    expect(activeSessions.size).toBe(0);
    expect(mockWorker).not.toHaveBeenCalled();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ type: 'error', content: 'Linear agent workingDir is required' });
  });

  it('creates a repo select PendingControl when workingDir is missing but allowlisted repos exist', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(() => 'should not run');

    const result = await feedLinearTurn(turn({ workingDir: undefined }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates: [repoCandidate()],
    });

    expect(result).toMatchObject({ ok: true, action: 'awaiting_input', turnKey: 'evt_1' });
    expect(activeSessions.size).toBe(0);
    expect(mockWorker).not.toHaveBeenCalled();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      type: 'elicitation',
      content: 'Select a repository for this Linear run.',
      control: {
        kind: 'choice',
        scope: 'run',
        controlKey: 'repo_select',
        options: [{ value: 'botmux', label: 'botmux' }],
      },
    });
    expect(getLinearPendingControl(linearRepoSelectControlKey(turn()))).toMatchObject({
      status: 'pending',
      originalTurn: expect.objectContaining({ body: 'Fix this issue', agentSessionId: 'agent_session_1' }),
    });
  });

  it('builds Linear repo select candidates by scanning configured roots to depth 3', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-linear-scan-'));
    try {
      const repo = join(root, 'bytecode', 'zeefan', 'botmux');
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

      const candidates = linearRepositoryCandidatesFromScanRoots([root]);

      expect(candidates).toEqual([
        expect.objectContaining({
          hostname: 'local',
          repositoryFullName: 'local/botmux',
          workingDir: repo,
          displayName: expect.stringMatching(/^botmux/),
        }),
      ]);
      expect(candidates[0]!.key).toMatch(/^local:[a-f0-9]{10}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies Project description botmux repo config before falling back to select', () => {
    const candidate = repoCandidate({ displayName: 'botmux (main)', repositoryFullName: 'local/botmux' });
    const project = {
      id: 'project_1',
      name: 'Linear Workbench',
      description: 'Linear-native workbench for botmux/Codex agents',
      content: [
        'Project notes',
        '```yaml',
        'botmux:',
        '  repo: botmux',
        '  repoSelection: auto',
        '```',
      ].join('\n'),
    };

    expect(parseLinearProjectBotmuxConfig(project.description)).toBeNull();
    expect(parseLinearProjectBotmuxConfig(project.content)).toEqual({ repo: 'botmux', repoSelection: 'auto' });
    const result = applyLinearProjectConfigToTurn(turn({ workingDir: undefined }), project, [candidate]);

    expect(result).toMatchObject({ action: 'applied' });
    if (result.action !== 'applied') throw new Error('expected project config to apply');
    expect(result.turn.workingDir).toBe(workingDir);
    expect(result.turn.promptContext).toMatchObject({
      linearProjectConfig: {
        projectId: 'project_1',
        projectName: 'Linear Workbench',
        selectedRepositoryKey: 'botmux',
        repositoryFullName: 'local/botmux',
      },
    });
  });

  it('consumes repo select and continues the original turn in the same AgentSession', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(({ turn }) => `done:${turn.body}`);
    const repositoryCandidates = [repoCandidate()];

    await feedLinearTurn(turn({ workingDir: undefined }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates,
    });
    const selected = await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_select',
      agentActivityId: 'activity_select',
      body: 'botmux',
      workingDir: undefined,
      control: { kind: 'repo_select', selectedValue: 'botmux' },
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates,
    });

    expect(selected).toMatchObject({ ok: true, action: 'queued' });
    if (!selected.ok || selected.action !== 'queued') throw new Error('unexpected repo select result');
    const session = activeSessions.get(selected.sessionKey);
    expect(session?.workingDir).toBe(workingDir);
    expect(mockWorker).toHaveBeenCalledTimes(1);
    expect(mockWorker.mock.calls[0][0].turn.body).toBe('Fix this issue');
    expect(selected.prompt).toContain('selectedRepositoryKey');
    expect(selected.output).toBe('done:Fix this issue');
    expect(getLinearPendingControl(linearRepoSelectControlKey(turn()))).toMatchObject({ status: 'consumed', selectedValue: 'botmux' });
    expect(loadLinearWorkbenchIndex('org_1', 'issue_1')?.repoBinding).toMatchObject({
      repositoryKey: 'botmux',
      repositoryFullName: 'zeefan/botmux',
      selectedByAgentSessionId: 'agent_session_1',
    });
    expect(activities.map(a => a.type)).toEqual(['elicitation', 'response']);
  });

  it('rejects invalid or stale repo select answers without starting Codex', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(() => 'should not run');
    const repositoryCandidates = [repoCandidate()];

    await feedLinearTurn(turn({ workingDir: undefined }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates,
    });
    const result = await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_bad_select',
      agentActivityId: 'activity_bad_select',
      body: 'not-allowlisted',
      workingDir: undefined,
      control: { kind: 'repo_select', selectedValue: 'not-allowlisted' },
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates,
    });

    expect(result).toMatchObject({ ok: false, action: 'error', error: 'selected value is not a pending option' });
    expect(activeSessions.size).toBe(0);
    expect(mockWorker).not.toHaveBeenCalled();
    expect(activities.map(a => a.type)).toEqual(['elicitation', 'error']);
  });

  it('does not let issue text choose cwd directly and allows follow-up after repo select is consumed', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(({ turn }) => `done:${turn.body}`);
    const repositoryCandidates = [repoCandidate()];

    const hintedPath = await feedLinearTurn(turn({
      eventId: 'evt_hint',
      workingDir: undefined,
      body: `please use ${workingDir}`,
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates: [],
    });
    expect(hintedPath).toMatchObject({ ok: false, action: 'error', error: 'Linear agent workingDir is required' });
    expect(mockWorker).not.toHaveBeenCalled();

    await feedLinearTurn(turn({ eventId: 'evt_start', agentActivityId: 'activity_start', workingDir: undefined }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates,
    });
    await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_select',
      agentActivityId: 'activity_select',
      body: 'botmux',
      workingDir: undefined,
      control: { kind: 'repo_select', selectedValue: 'botmux' },
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates,
    });
    const followUp = await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_follow_up',
      agentActivityId: 'activity_follow_up',
      body: 'continue after repo selection',
      workingDir: undefined,
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
      repositoryCandidates,
    });

    expect(followUp).toMatchObject({ ok: true, action: 'queued' });
    expect(mockWorker).toHaveBeenCalledTimes(2);
    expect(mockWorker.mock.calls[1][0].turn.body).toBe('continue after repo selection');
  });

  it('dedupes repeated Linear events', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(() => 'done');

    await feedLinearTurn(turn(), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
    });
    const duplicate = await feedLinearTurn(turn(), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
    });

    expect(duplicate).toEqual(expect.objectContaining({ ok: true, action: 'duplicate', turnKey: 'evt_1' }));
    expect(mockWorker).toHaveBeenCalledTimes(1);
    expect(activities).toHaveLength(1);
  });

  it('records a canonical WorkbenchIndex for issue-level runs without raw logs', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const mockWorker = vi.fn(({ turn }) => `done:${turn.body}`);

    await feedLinearTurn(turn(), {
      activeSessions,
      state,
      mockWorker,
      currentCliVersion: () => 'test-cli',
    });
    await feedLinearTurn(turn({
      eventId: 'evt_2',
      agentSessionId: 'agent_session_2',
      agentActivityId: 'activity_2',
      body: 'Second run with raw terminal SECRET=abc123',
    }), {
      activeSessions,
      state,
      mockWorker,
      currentCliVersion: () => 'test-cli',
    });

    const index = loadLinearWorkbenchIndex('org_1', 'issue_1');
    expect(index).toMatchObject({
      version: 1,
      organizationId: 'org_1',
      issueId: 'issue_1',
      issueIdentifier: 'ZEE-1',
      issueTitle: 'Linear workbench',
    });
    expect(index?.runs.map(run => ({ agentSessionId: run.agentSessionId, status: run.status }))).toEqual([
      { agentSessionId: 'agent_session_1', status: 'completed' },
      { agentSessionId: 'agent_session_2', status: 'completed' },
    ]);
    const projection = buildLinearWorkbenchProjection(index!);
    expect(projection).toContain('Agent runs: 2');
    expect(projection).not.toContain('SECRET=abc123');
    expect(projection).not.toContain('raw terminal');
  });

  it('can hand Linear turns to a real worker fork boundary', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const forkWorker = vi.fn();
    const recordActivity = vi.fn();

    const first = await feedLinearTurn(turn(), {
      activeSessions,
      state,
      forkWorker,
      recordActivity,
      currentCliVersion: () => 'test-cli',
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.action !== 'queued') throw new Error('unexpected feed failure');
    const ds = activeSessions.get(first.sessionKey);
    const send = vi.fn();
    ds.worker = { killed: false, send } as any;

    await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_2',
      agentActivityId: 'activity_2',
      body: 'continue',
    }), {
      activeSessions,
      state,
      forkWorker,
      recordActivity,
      currentCliVersion: () => 'test-cli',
    });

    expect(forkWorker).toHaveBeenCalledWith(ds, first.prompt, false);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', turnId: 'activity_2' }));
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('handles Linear stop as a worker control signal, not a Codex prompt', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const activities: LinearActivityRecord[] = [];
    const mockWorker = vi.fn(({ turn }) => `done:${turn.body}`);

    const first = await feedLinearTurn(turn(), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
    });
    expect(first.ok && first.action === 'queued').toBe(true);
    if (!first.ok || first.action !== 'queued') throw new Error('unexpected start result');
    const ds = activeSessions.get(first.sessionKey)!;
    const send = vi.fn();
    ds.worker = { killed: false, send } as any;

    const stopped = await feedLinearTurn(turn({
      type: 'stop',
      eventId: 'evt_stop',
      agentActivityId: 'activity_stop',
      body: 'Stop',
      workingDir: undefined,
    }), {
      activeSessions,
      state,
      mockWorker,
      recordActivity: a => activities.push(a),
    });

    expect(stopped).toMatchObject({ ok: true, action: 'stopped', sessionId: ds.session.sessionId });
    expect(mockWorker).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'cancel_turn', turnId: 'activity_1', reason: 'Linear stop signal' });
    expect(ds.session.linear).toMatchObject({
      currentTurnId: 'activity_1',
      cancelledTurnId: 'activity_1',
      stopTurnId: 'activity_stop',
      stopState: 'sent_to_worker',
    });
    expect(activities.map(a => a.type)).toEqual(['response', 'response']);
    expect(activities[1].content).toContain('Stopped this Linear run');
  });

  it('lets a new prompt continue after a stopped Linear run', async () => {
    const activeSessions = new Map();
    const state = createLinearFeedState();
    const mockWorker = vi.fn(({ turn }) => `done:${turn.body}`);

    const first = await feedLinearTurn(turn(), { activeSessions, state, mockWorker });
    if (!first.ok || first.action !== 'queued') throw new Error('unexpected start result');
    await feedLinearTurn(turn({
      type: 'stop',
      eventId: 'evt_stop',
      agentActivityId: 'activity_stop',
      body: 'Stop',
    }), { activeSessions, state, mockWorker });
    const followUp = await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_after_stop',
      agentActivityId: 'activity_after_stop',
      body: 'continue after stop',
    }), { activeSessions, state, mockWorker });

    expect(followUp).toMatchObject({ ok: true, action: 'queued', sessionId: first.sessionId });
    expect(mockWorker).toHaveBeenCalledTimes(2);
    expect(mockWorker.mock.calls[1][0].turn.body).toBe('continue after stop');
  });

  it('restores AgentSession-scoped Linear sessions under channel identity after daemon restart', async () => {
    const session = sessionStore.createSession('linear:org:org_1', linearAgentSessionAnchorId('agent_session_1'), 'ZEE-1 Linear workbench');
    session.channel = 'linear';
    session.channelIdentity = 'linear:codex';
    session.runtimeBotId = 'codex-bot';
    session.larkAppId = 'codex-bot';
    session.scope = 'thread';
    session.workingDir = workingDir;
    session.cliSessionId = 'codex_thread_1';
    session.linear = { organizationId: 'org_1', issueId: 'issue_1', agentSessionId: 'agent_session_1' };
    sessionStore.updateSession(session);
    const activeSessions = new Map<string, DaemonSession>();

    await restoreActiveSessions(activeSessions);

    const restored = activeSessions.get(`${linearAgentSessionAnchorId('agent_session_1')}::linear:codex`);
    expect(restored?.session.sessionId).toBe(session.sessionId);
    expect(restored?.channel).toBe('linear');
    expect(restored?.channelIdentity).toBe('linear:codex');
    expect(sessionStore.getSession(session.sessionId)?.status).toBe('active');
    expect(restored && activeSessionKey(restored)).toBe(`${linearAgentSessionAnchorId('agent_session_1')}::linear:codex`);

    const forkWorker = vi.fn();
    const result = await feedLinearTurn(turn({
      type: 'prompted',
      eventId: 'evt_after_restart',
      agentActivityId: 'activity_2',
      body: 'continue after daemon restart',
    }), {
      activeSessions,
      state: createLinearFeedState(),
      forkWorker,
      currentCliVersion: () => 'test-cli',
    });

    expect(result).toMatchObject({ ok: true, action: 'queued', sessionId: session.sessionId });
    expect(result.ok && result.prompt).toContain('<turn_type>follow_up</turn_type>');
    expect(forkWorker).toHaveBeenCalledWith(restored, expect.any(String), true);
  });
});

describe('Linear worker boundary', () => {
  function daemonSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
    const session = {
      sessionId: 'session_1',
      chatId: 'linear:org:org_1',
      rootMessageId: 'linear:issue:issue_1',
      title: 'Linear workbench',
      status: 'active' as const,
      createdAt: '2026-06-18T00:00:00.000Z',
      channel: 'linear' as const,
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      linear: { organizationId: 'org_1', issueId: 'issue_1', agentSessionId: 'agent_session_1' },
    };
    return {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      channel: 'linear',
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      linear: session.linear,
      larkAppId: 'codex-bot',
      chatId: session.chatId,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 0,
      cliVersion: 'test',
      lastMessageAt: 0,
      hasHistory: false,
      workingDir,
      ...overrides,
    };
  }

  it('uses runtimeBotId for Linear runtime config but strips Lark env', () => {
    process.env.LARK_APP_ID = 'ambient-app';
    process.env.LARK_APP_SECRET = 'ambient-secret';
    const ds = daemonSession();

    const env = buildWorkerForkEnvForSession(ds, { larkAppId: 'lark-runtime-app', larkAppSecret: 'lark-secret' }, '/tmp/botmux-bin:/usr/bin');

    expect(runtimeBotIdForSession(ds)).toBe('codex-bot');
    expect(env.BOTMUX_CHANNEL).toBe('linear');
    expect(env.BOTMUX_CHANNEL_IDENTITY).toBe('linear:codex');
    expect(env.BOTMUX_LINEAR_ISSUE_ID).toBe('issue_1');
    expect(env.BOTMUX_LINEAR_AGENT_SESSION_ID).toBe('agent_session_1');
    expect(env.LARK_APP_ID).toBeUndefined();
    expect(env.LARK_APP_SECRET).toBeUndefined();
    expect(env.BOTMUX_LARK_APP_ID).toBeUndefined();
  });

  it('keeps existing Lark worker env behavior', () => {
    const ds = daemonSession({
      channel: undefined,
      channelIdentity: undefined,
      runtimeBotId: undefined,
      linear: undefined,
      larkAppId: 'lark-app',
      session: {
        ...daemonSession().session,
        channel: undefined,
        channelIdentity: undefined,
        runtimeBotId: undefined,
        linear: undefined,
        larkAppId: 'lark-app',
      },
    });

    const env = buildWorkerForkEnvForSession(ds, { larkAppId: 'lark-app', larkAppSecret: 'lark-secret' }, '/tmp/botmux-bin:/usr/bin');

    expect(runtimeBotIdForSession(ds)).toBe('lark-app');
    expect(env.BOTMUX_CHANNEL).toBe('lark');
    expect(env.BOTMUX_CHANNEL_IDENTITY).toBe('lark-app');
    expect(env.LARK_APP_ID).toBe('lark-app');
    expect(env.LARK_APP_SECRET).toBe('lark-secret');
  });
});

describe('Linear local state and webhook normalization', () => {
  it('stores OAuth tokens under isolated 0600 local JSON files', () => {
    const key = { organizationId: 'org_1', clientId: 'client_1', channelIdentity: 'linear:codex' };
    const otherKey = { ...key, channelIdentity: 'linear:traex' };

    saveLinearOAuthToken(key, {
      access_token: 'access_1',
      refresh_token: 'refresh_1',
      expires_at: Date.now() + 3_600_000,
    });

    expect(loadLinearOAuthToken(key)?.access_token).toBe('access_1');
    expect(loadLinearOAuthToken(otherKey)).toBeNull();
    expect(linearStateFileMode(linearTokenPathForTest(key))).toBe(0o600);
  });

  it('tracks delivery idempotency locally', () => {
    expect(claimLinearDelivery('delivery_1')).toBe(true);
    expect(claimLinearDelivery('delivery_1')).toBe(false);

    markLinearDelivery('delivery_1', 'delivered', { activityId: 'activity_1' });

    expect(getLinearDelivery('delivery_1')).toMatchObject({
      key: 'delivery_1',
      status: 'delivered',
      activityId: 'activity_1',
    });
  });

  it('creates and consumes typed Linear PendingControl records', () => {
    const key = linearPendingControlKey({
      organizationId: 'org_1',
      issueId: 'issue_1',
      agentSessionId: 'agent_session_1',
      turnId: 'turn_1',
      kind: 'choice',
      controlKey: 'repo',
    });
    const record = createLinearPendingControl({
      key,
      kind: 'choice',
      scope: 'run',
      organizationId: 'org_1',
      issueId: 'issue_1',
      agentSessionId: 'agent_session_1',
      turnId: 'turn_1',
      controlKey: 'repo',
      question: 'Choose repo',
      options: [{ value: 'botmux', label: 'botmux' }],
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(record).toMatchObject({ status: 'pending', expiresAt: 61_000 });
    expect(createLinearPendingControl({ ...record, question: 'Duplicate ignored', now: 2_000 })).toMatchObject({ question: 'Choose repo' });
    expect(consumeLinearPendingControl(key, { selectedValue: 'wrong' }, 2_000)).toMatchObject({ ok: false, action: 'invalid' });
    expect(consumeLinearPendingControl(key, { selectedValue: 'botmux' }, 2_000)).toMatchObject({ ok: true, action: 'consumed' });
    expect(consumeLinearPendingControl(key, { selectedValue: 'botmux' }, 3_000)).toMatchObject({ ok: true, action: 'duplicate' });
    expect(getLinearPendingControl(key)).toMatchObject({ status: 'consumed', selectedValue: 'botmux' });
  });

  it('expires pending controls and supports free-text answers', () => {
    const expiredKey = linearPendingControlKey({
      organizationId: 'org_1',
      agentSessionId: 'agent_session_1',
      turnId: 'turn_1',
      kind: 'approval',
      controlKey: 'dangerous-op',
    });
    createLinearPendingControl({
      key: expiredKey,
      kind: 'approval',
      scope: 'turn',
      organizationId: 'org_1',
      agentSessionId: 'agent_session_1',
      turnId: 'turn_1',
      controlKey: 'dangerous-op',
      question: 'Approve?',
      options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }],
      now: 1_000,
      ttlMs: 1,
    });
    expect(consumeLinearPendingControl(expiredKey, { selectedValue: 'approve' }, 2_000)).toMatchObject({ ok: false, action: 'expired' });

    const freeTextKey = linearPendingControlKey({
      organizationId: 'org_1',
      agentSessionId: 'agent_session_1',
      turnId: 'turn_2',
      kind: 'free_text',
      controlKey: 'branch-name',
    });
    createLinearPendingControl({
      key: freeTextKey,
      kind: 'free_text',
      scope: 'turn',
      organizationId: 'org_1',
      agentSessionId: 'agent_session_1',
      turnId: 'turn_2',
      controlKey: 'branch-name',
      question: 'Branch name?',
      now: 1_000,
      ttlMs: 60_000,
    });
    expect(consumeLinearPendingControl(freeTextKey, { answerText: 'feature/linear' }, 2_000)).toMatchObject({
      ok: true,
      action: 'consumed',
      record: { answerText: 'feature/linear' },
    });
  });

  it('verifies Linear webhooks and normalizes AgentSessionEvent payloads', () => {
    const secret = 'linear-secret';
    const now = Date.now();
    const raw = JSON.stringify({
      webhookTimestamp: now,
      organizationId: 'org_1',
      action: 'prompted',
      promptContext: { source: 'linear' },
      agentSession: {
        id: 'agent_session_1',
        comment: { body: 'Please continue' },
        issue: {
          id: 'issue_1',
          identifier: 'ZEE-1',
          title: 'Issue workbench',
          description: 'Issue description',
        },
      },
    });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');

    expect(verifyLinearWebhookSignature(raw, signature, secret)).toBe(true);
    const parsed = parseVerifiedLinearWebhook(raw, {
      'Linear-Signature': signature,
      'Linear-Delivery': 'delivery_1',
    }, secret, {
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      workingDir,
    }, now);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.turn).toMatchObject({
      type: 'prompted',
      eventId: 'delivery_1',
      organizationId: 'org_1',
      issueId: 'issue_1',
      agentSessionId: 'agent_session_1',
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      body: 'Please continue',
      workingDir,
      issue: { identifier: 'ZEE-1', title: 'Issue workbench' },
    });
  });

  it('uses agentActivity.body for same AgentSession follow-up prompts', () => {
    const secret = 'linear-secret';
    const now = Date.now();
    const raw = JSON.stringify({
      webhookTimestamp: now,
      organizationId: 'org_1',
      action: 'prompted',
      prompt: 'Original top-level prompt',
      body: 'Original top-level mention',
      promptContext: null,
      agentActivity: {
        id: 'activity_2',
        content: {
          type: 'prompt',
          body: 'FOLLOW-UP-BODY-20260619',
        },
      },
      agentSession: {
        id: 'agent_session_1',
        comment: { body: 'Original top-level mention' },
        issue: {
          id: 'issue_1',
          identifier: 'ZEE-1',
          title: 'Issue workbench',
          description: 'Issue description',
        },
      },
    });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');

    const parsed = parseVerifiedLinearWebhook(raw, {
      'Linear-Signature': signature,
      'Linear-Delivery': 'delivery_2',
    }, secret, {
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      workingDir,
    }, now);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.turn).toMatchObject({
      type: 'prompted',
      eventId: 'delivery_2',
      agentActivityId: 'activity_2',
      body: 'FOLLOW-UP-BODY-20260619',
    });
  });

  it('normalizes Linear stop signal as a control turn', () => {
    const secret = 'linear-secret';
    const now = Date.now();
    const raw = JSON.stringify({
      webhookTimestamp: now,
      organizationId: 'org_1',
      action: 'prompted',
      agentActivity: {
        id: 'activity_stop',
        signal: 'stop',
        content: {
          type: 'prompt',
          body: 'Stop this run',
        },
      },
      agentSession: {
        id: 'agent_session_1',
        issue: {
          id: 'issue_1',
          identifier: 'ZEE-1',
          title: 'Issue workbench',
        },
      },
    });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');

    const parsed = parseVerifiedLinearWebhook(raw, {
      'Linear-Signature': signature,
      'Linear-Delivery': 'delivery_stop',
    }, secret, {
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      workingDir,
    }, now);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.turn).toMatchObject({
      type: 'stop',
      eventId: 'delivery_stop',
      agentActivityId: 'activity_stop',
      body: 'Stop this run',
    });
  });

  it('does not treat Linear comment or activity data as an AgentSession', () => {
    const secret = 'linear-secret';
    const now = Date.now();
    const raw = JSON.stringify({
      webhookTimestamp: now,
      organizationId: 'org_1',
      action: 'create',
      data: {
        id: 'comment_1',
        body: 'Agent response',
        issue: { id: 'issue_1', identifier: 'ZEE-1', title: 'Issue workbench' },
      },
    });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');

    expect(parseVerifiedLinearWebhook(raw, {
      'Linear-Signature': signature,
      'Linear-Delivery': 'delivery_comment',
    }, secret, {
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      workingDir,
    }, now)).toMatchObject({ ok: false, status: 400, error: 'unsupported Linear webhook payload' });
  });

  it('rejects invalid or stale Linear webhooks', () => {
    const secret = 'linear-secret';
    const now = Date.now();
    const raw = JSON.stringify({ webhookTimestamp: now - 120_000 });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');

    expect(parseVerifiedLinearWebhook(raw, { 'Linear-Signature': 'bad' }, secret, {
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
    }, now)).toMatchObject({ ok: false, status: 401 });
    expect(parseVerifiedLinearWebhook(raw, { 'Linear-Signature': signature }, secret, {
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
    }, now)).toMatchObject({ ok: false, status: 401, error: 'stale Linear webhook timestamp' });
  });
});

describe('Linear egress', () => {
  function egressSession(): DaemonSession {
    const session = {
      sessionId: 'session_egress',
      chatId: 'linear:org:org_1',
      rootMessageId: 'linear:issue:issue_1',
      title: 'Linear workbench',
      status: 'active' as const,
      createdAt: '2026-06-18T00:00:00.000Z',
      channel: 'linear' as const,
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      linear: { organizationId: 'org_1', issueId: 'issue_1', agentSessionId: 'agent_session_1' },
    };
    return {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      channel: 'linear',
      channelIdentity: 'linear:codex',
      runtimeBotId: 'codex-bot',
      linear: session.linear,
      larkAppId: 'codex-bot',
      chatId: session.chatId,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 0,
      cliVersion: 'test',
      lastMessageAt: 0,
      hasHistory: false,
      workingDir,
    };
  }

  function fakeClient(): LinearAgentActivityClient & LinearSessionClient & LinearIssueClient & LinearAgentSessionClient & { calls: any[]; externalUrlCalls: any[]; planCalls: any[]; issueCalls: any[]; commentCalls: any[]; sessionIssueCalls: any[]; sessionCommentCalls: any[] } {
    const calls: any[] = [];
    const externalUrlCalls: any[] = [];
    const planCalls: any[] = [];
    const issueCalls: any[] = [];
    const commentCalls: any[] = [];
    const sessionIssueCalls: any[] = [];
    const sessionCommentCalls: any[] = [];
    return {
      calls,
      externalUrlCalls,
      planCalls,
      issueCalls,
      commentCalls,
      sessionIssueCalls,
      sessionCommentCalls,
      async createAgentActivity(input) {
        calls.push(input);
        return { id: `activity_${calls.length}` };
      },
      async updateAgentSessionExternalUrls(input) {
        externalUrlCalls.push(input);
        return { externalUrls: input.externalUrls };
      },
      async updateAgentSessionPlan(input) {
        planCalls.push(input);
      },
      async updateIssue(input) {
        issueCalls.push(input);
      },
      async createIssueComment(input) {
        commentCalls.push(input);
        return { id: `comment_${commentCalls.length}` };
      },
      async getIssueProject() {
        return null;
      },
      async createAgentSessionOnIssue(input) {
        sessionIssueCalls.push(input);
        return { id: `agent_session_issue_${sessionIssueCalls.length}`, url: 'https://linear.app/test/agent-session/issue' };
      },
      async createAgentSessionOnComment(input) {
        sessionCommentCalls.push(input);
        return { id: `agent_session_comment_${sessionCommentCalls.length}`, url: 'https://linear.app/test/agent-session/comment' };
      },
    };
  }

  it('delivers placeholder, response, and error activities with retry-safe keys', async () => {
    const ds = egressSession();
    const client = fakeClient();

    expect(await deliverLinearPlaceholderOnce(ds, client)).toMatchObject({ ok: true, action: 'delivered', activityId: 'activity_1' });
    expect(await deliverLinearPlaceholderOnce(ds, client)).toMatchObject({ ok: true, action: 'duplicate' });
    expect(await deliverLinearFinalOutput(ds, {
      type: 'final_output',
      content: 'Final answer',
      lastUuid: 'uuid_1',
      turnId: 'turn_1',
    }, client)).toMatchObject({ ok: true, action: 'delivered', activityId: 'activity_2' });
    expect(await deliverLinearFinalOutput(ds, {
      type: 'final_output',
      content: 'Final answer again',
      lastUuid: 'uuid_1',
      turnId: 'turn_1',
    }, client)).toMatchObject({ ok: true, action: 'duplicate' });
    expect(await deliverLinearError(ds, 'Worker failed', client, 'turn_2')).toMatchObject({ ok: true, action: 'delivered', activityId: 'activity_3' });

    expect(client.calls).toEqual([
      { agentSessionId: 'agent_session_1', content: { type: 'thought', body: 'Accepted. Starting Codex.' } },
      { agentSessionId: 'agent_session_1', content: { type: 'response', body: 'Final answer' } },
      { agentSessionId: 'agent_session_1', content: { type: 'error', body: 'Worker failed' } },
    ]);
    expect(ds.session.linear?.lastResponseActivityId).toBe('activity_2');
    expect(loadLinearWorkbenchIndex('org_1', 'issue_1')?.runs[0]).toMatchObject({
      agentSessionId: 'agent_session_1',
      sessionId: 'session_egress',
      status: 'error',
      lastTurnId: 'turn_2',
      lastActivityId: 'activity_3',
    });
  });

  it('routes only semantic worker results to Linear activity', () => {
    expect(linearActivitySourceForWorkerMessage({
      type: 'screen_update',
      content: 'terminal redraw',
      status: 'working',
    })).toBeNull();
    expect(linearActivitySourceForWorkerMessage({
      type: 'final_output',
      content: 'Final answer',
      lastUuid: 'uuid_1',
      turnId: 'turn_1',
    })).toBe('response');
    expect(linearActivitySourceForWorkerMessage({
      type: 'final_output',
      content: '   ',
      lastUuid: 'uuid_empty',
      turnId: 'turn_empty',
    })).toBeNull();
    expect(linearActivitySourceForWorkerMessage({
      type: 'error',
      message: 'Worker failed',
    })).toBe('error');
  });

  it('exposes a thin LinearActivityEmitter over the durable egress boundary', async () => {
    const ds = egressSession();
    const client = fakeClient();
    const emitter = createLinearActivityEmitter(client);

    expect(await emitter.placeholderOnce(ds, 'Accepted')).toMatchObject({ ok: true, action: 'delivered' });
    expect(await emitter.finalOutput(ds, {
      type: 'final_output',
      content: 'Final answer',
      lastUuid: 'uuid_3',
      turnId: 'turn_3',
    })).toMatchObject({ ok: true, action: 'delivered' });
    expect(await emitter.error(ds, 'Worker failed', 'turn_4')).toMatchObject({ ok: true, action: 'delivered' });

    expect(client.calls.map(call => call.content.type)).toEqual(['thought', 'response', 'error']);
  });

  it('projects Linear run events through the status projector', async () => {
    const ds = egressSession();
    const client = fakeClient();
    const clientForSession = vi.fn(async () => client);

    await expect(projectLinearRunEvent(ds, { type: 'accepted' }, { clientForSession }))
      .resolves.toMatchObject({ ok: true, action: 'delivered' });
    await expect(projectLinearRunEvent(ds, { type: 'worker_ready' }, { clientForSession }))
      .resolves.toMatchObject({ ok: true, action: 'delivered' });
    await expect(projectLinearRunEvent(ds, { type: 'status_update', body: 'Reading code', key: 'phase:read-code' }, { clientForSession }))
      .resolves.toMatchObject({ ok: true, action: 'delivered' });
    await expect(projectLinearRunEvent(ds, {
      type: 'final_response',
      msg: { type: 'final_output', content: 'Final answer', lastUuid: 'uuid_5', turnId: 'turn_5' },
    }, { clientForSession })).resolves.toMatchObject({ ok: true, action: 'delivered' });
    await expect(projectLinearRunEvent(ds, { type: 'error', message: 'Worker failed', turnKey: 'turn_6' }, { clientForSession }))
      .resolves.toMatchObject({ ok: true, action: 'delivered' });

    expect(client.calls.map(call => call.content)).toEqual([
      { type: 'thought', body: 'Accepted. Starting Codex.' },
      { type: 'thought', body: 'Codex started. Terminal is ready.' },
      { type: 'thought', body: 'Reading code' },
      { type: 'response', body: 'Final answer' },
      { type: 'error', body: 'Worker failed' },
    ]);
    expect(client.externalUrlCalls).toHaveLength(0);
  });

  it('adds safe read-only externalUrls when the Linear worker becomes ready', async () => {
    process.env.LINEAR_PUBLIC_TERMINAL_BASE_URL = 'https://terminal.example.com';
    const ds = egressSession();
    const client = fakeClient();

    await expect(projectLinearRunEvent(ds, { type: 'worker_ready' }, { clientForSession: async () => client }))
      .resolves.toMatchObject({ ok: true, action: 'delivered' });

    expect(client.calls[0]?.content).toEqual({
      type: 'thought',
      body: 'Codex started. Terminal is ready.',
    });
    expect(client.externalUrlCalls).toEqual([
      {
        agentSessionId: 'agent_session_1',
        externalUrls: [
          { label: 'Read-only terminal', url: 'https://terminal.example.com/s/session_egress' },
        ],
      },
    ]);
  });

  it('projects awaiting-input elicitation outside daemon route logic', async () => {
    const client = fakeClient();
    const clientForIdentity = vi.fn(async () => client);
    const control = createLinearPendingControl({
      key: linearPendingControlKey({
        organizationId: 'org_1',
        issueId: 'issue_1',
        agentSessionId: 'agent_session_1',
        kind: 'choice',
        controlKey: 'repo_select',
      }),
      kind: 'choice',
      scope: 'run',
      organizationId: 'org_1',
      issueId: 'issue_1',
      agentSessionId: 'agent_session_1',
      controlKey: 'repo_select',
      question: 'Select repository',
      options: [{ value: 'botmux', label: 'botmux' }],
    });

    await expect(projectLinearAwaitingInput({
      organizationId: 'org_1',
      channelIdentity: 'linear:codex',
      agentSessionId: 'agent_session_1',
      control,
    }, { clientForIdentity })).resolves.toMatchObject({ ok: true, action: 'delivered' });

    expect(clientForIdentity).toHaveBeenCalledWith({
      organizationId: 'org_1',
      channelIdentity: 'linear:codex',
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: 'agent_session_1',
      content: { type: 'elicitation', body: 'Select repository' },
      signal: 'select',
    });
  });

  it('delivers select elicitation with options and a stable delivery key', async () => {
    const client = fakeClient();
    const control = createLinearPendingControl({
      key: linearPendingControlKey({
        organizationId: 'org_1',
        issueId: 'issue_1',
        agentSessionId: 'agent_session_1',
        kind: 'choice',
        controlKey: 'repo_select',
      }),
      kind: 'choice',
      scope: 'run',
      organizationId: 'org_1',
      issueId: 'issue_1',
      agentSessionId: 'agent_session_1',
      controlKey: 'repo_select',
      question: 'Select repository',
      options: [{ value: 'botmux', label: 'botmux' }],
    });

    expect(await deliverLinearSelectElicitation('agent_session_1', control, client)).toMatchObject({ ok: true, action: 'delivered' });
    expect(await deliverLinearSelectElicitation('agent_session_1', control, client)).toMatchObject({ ok: true, action: 'duplicate' });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      agentSessionId: 'agent_session_1',
      content: { type: 'elicitation', body: 'Select repository' },
      signal: 'select',
      signalMetadata: { options: [{ value: 'botmux', label: 'botmux' }] },
    });
  });

  it('delivers auth elicitation without collecting credentials in Linear', async () => {
    const client = fakeClient();
    const authUrl = 'https://botmux.example.com/linear/oauth/authorize?agentSessionId=agent_session_1';

    expect(await deliverLinearAuthElicitation('agent_session_1', authUrl, client, 'Linear')).toMatchObject({ ok: true, action: 'delivered' });
    expect(await deliverLinearAuthElicitation('agent_session_1', authUrl, client, 'Linear')).toMatchObject({ ok: true, action: 'duplicate' });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      agentSessionId: 'agent_session_1',
      content: { type: 'elicitation', body: 'Please authenticate to continue.' },
      signal: 'auth',
      signalMetadata: { url: authUrl, providerName: 'Linear' },
    });
    expect(JSON.stringify(client.calls[0])).not.toContain('access_token');
    expect(JSON.stringify(client.calls[0])).not.toContain('refresh_token');
  });

  it('suppresses final output that arrives after a Linear stop for the cancelled turn', () => {
    const ds = egressSession();
    ds.linear = { ...ds.linear!, currentTurnId: 'turn_1', cancelledTurnId: 'turn_1', stopState: 'sent_to_worker' };
    ds.session.linear = ds.linear;

    expect(suppressStoppedLinearFinalOutput(ds, {
      type: 'final_output',
      content: 'late output',
      lastUuid: 'uuid_late',
      turnId: 'turn_1',
    })).toBe(true);
    expect(ds.session.linear?.stopState).toBe('stopped');
    expect(suppressStoppedLinearFinalOutput(ds, {
      type: 'final_output',
      content: 'new output',
      lastUuid: 'uuid_new',
      turnId: 'turn_2',
    })).toBe(false);
  });

  it('keeps Linear issue side effects disabled by default and applies them only when configured', async () => {
    const ds = egressSession();
    const client = fakeClient();

    await expect(applyLinearIssueSideEffects(client, ds, 'start', undefined, {})).resolves.toEqual([]);
    expect(client.issueCalls).toHaveLength(0);
    expect(client.commentCalls).toHaveLength(0);

    await expect(applyLinearIssueSideEffects(client, ds, 'start', undefined, {
      statusOnStartId: 'state_start',
      delegateSelfId: 'delegate_bot',
    })).resolves.toEqual(['status:start', 'delegate:self']);
    await expect(applyLinearIssueSideEffects(client, ds, 'done', 'Final summary', {
      statusOnDoneId: 'state_done',
      commentMirrorEnabled: true,
    })).resolves.toEqual(['status:done', 'comment:mirror']);
    await expect(applyLinearIssueSideEffects(client, ds, 'error', undefined, {
      statusOnErrorId: 'state_error',
    })).resolves.toEqual(['status:error']);

    expect(client.issueCalls).toEqual([
      { issueId: 'issue_1', stateId: 'state_start', delegateId: 'delegate_bot' },
      { issueId: 'issue_1', stateId: 'state_done', delegateId: undefined },
      { issueId: 'issue_1', stateId: 'state_error', delegateId: undefined },
    ]);
    expect(client.commentCalls).toEqual([{ issueId: 'issue_1', body: 'Final summary' }]);
  });

  it('creates a visible handoff receipt and official target AgentSession on the receipt comment', async () => {
    const ds = egressSession();
    const sourceClient = fakeClient();
    const targetClient = fakeClient();
    const roster = [{
      key: 'traex',
      channelIdentity: 'linear:traex',
      runtimeBotId: 'traex-bot',
      displayName: 'Fan Traex',
    }];

    const result = await handoffToLinearAgent({
      sourceClient,
      targetClient,
      ds,
      targetAgentKey: 'traex',
      roster,
      context: {
        task: 'Review this implementation and continue the issue.',
        summary: 'Source result is ready. secret=abc123 and /Users/bytedance/private should not leak.',
        repositoryFullName: 'zeefan/botmux',
        sourceRunUrl: 'https://botmux.example.com/#/sessions',
      },
    });
    const duplicate = await handoffToLinearAgent({
      sourceClient,
      targetClient,
      ds,
      targetAgentKey: 'traex',
      roster,
      context: {
        task: 'Review this implementation and continue the issue.',
        summary: 'Source result is ready. secret=abc123 and /Users/bytedance/private should not leak.',
        repositoryFullName: 'zeefan/botmux',
        sourceRunUrl: 'https://botmux.example.com/#/sessions',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'delivered',
      commentId: 'comment_1',
      targetAgentSessionId: 'agent_session_comment_1',
    });
    expect(duplicate).toMatchObject({
      ok: true,
      action: 'duplicate',
      commentId: 'comment_1',
      targetAgentSessionId: 'agent_session_comment_1',
    });
    expect(sourceClient.commentCalls).toHaveLength(1);
    expect(sourceClient.commentCalls[0].issueId).toBe('issue_1');
    expect(sourceClient.commentCalls[0].body).toContain('Botmux handoff to Fan Traex');
    expect(sourceClient.commentCalls[0].body).toContain('Review this implementation');
    expect(sourceClient.commentCalls[0].body).toContain('zeefan/botmux');
    expect(sourceClient.commentCalls[0].body).not.toContain('abc123');
    expect(sourceClient.commentCalls[0].body).not.toContain('/Users/bytedance');
    expect(targetClient.sessionCommentCalls).toEqual([{ commentId: 'comment_1' }]);
    expect(targetClient.sessionIssueCalls).toHaveLength(0);
  });

  it('does not create a handoff when the target agent is absent from the roster', async () => {
    const ds = egressSession();
    const sourceClient = fakeClient();
    const targetClient = fakeClient();

    await expect(handoffToLinearAgent({
      sourceClient,
      targetClient,
      ds,
      targetAgentKey: 'missing-agent',
      roster: [],
      context: { task: 'Continue this issue.' },
    })).resolves.toMatchObject({ ok: false, action: 'skipped', error: 'unknown Linear agent: missing-agent' });

    expect(sourceClient.commentCalls).toHaveLength(0);
    expect(targetClient.sessionCommentCalls).toHaveLength(0);
  });

  it('builds Linear externalUrls only from explicit safe public base URLs', () => {
    const ds = egressSession();

    process.env.LINEAR_PUBLIC_BASE_URL = '';
    expect(buildLinearSessionExternalUrl(ds)).toBeNull();

    process.env.LINEAR_PUBLIC_BASE_URL = 'https://botmux.example.com';
    expect(buildLinearSessionExternalUrl(ds)).toEqual({
      key: 'dashboard-session',
      label: 'Botmux session',
      url: 'https://botmux.example.com/#/sessions?sessionId=session_egress',
    });

    process.env.LINEAR_PUBLIC_BASE_URL = 'https://localhost:7891/?t=secret';
    expect(buildLinearSessionExternalUrl(ds)).toBeNull();

    process.env.LINEAR_PUBLIC_BASE_URL = 'https://botmux.example.com';
    process.env.LINEAR_PUBLIC_TERMINAL_BASE_URL = '';
    expect(buildLinearTerminalExternalUrl(ds)).toBeNull();

    process.env.LINEAR_PUBLIC_TERMINAL_BASE_URL = 'https://terminal.example.com';
    expect(buildLinearTerminalExternalUrl(ds)).toEqual({
      key: 'terminal-readonly',
      label: 'Read-only terminal',
      url: 'https://terminal.example.com/s/session_egress',
    });

    expect(buildLinearSessionExternalUrls(ds).map(u => u.key)).toEqual(['terminal-readonly']);
  });

  it('rejects local, non-https, and token-bearing externalUrls', () => {
    expect(normalizeLinearExternalUrl('https://botmux.example.com/#/sessions?sessionId=session_egress')).toEqual({
      ok: true,
      url: 'https://botmux.example.com/#/sessions?sessionId=session_egress',
    });
    expect(normalizeLinearExternalUrl('http://botmux.example.com')).toMatchObject({ ok: false });
    expect(normalizeLinearExternalUrl('https://127.0.0.1:7891/#/sessions')).toMatchObject({ ok: false });
    expect(normalizeLinearExternalUrl('https://192.168.1.2/#/sessions')).toMatchObject({ ok: false });
    expect(normalizeLinearExternalUrl('file:///tmp/session')).toMatchObject({ ok: false });
    expect(normalizeLinearExternalUrl('https://botmux.example.com/?token=write')).toMatchObject({ ok: false });
    expect(normalizeLinearExternalUrl('https://botmux.example.com/?t=dashboard')).toMatchObject({ ok: false });
  });

  it('merges externalUrls by key and dedupes delivery', async () => {
    const ds = egressSession();
    const client = fakeClient();

    expect(await updateLinearExternalUrls(ds, client, [
      { key: 'dashboard-session', label: 'Botmux session', url: 'https://botmux.example.com/#/sessions?sessionId=session_egress' },
      { key: 'pr:1', label: 'Pull request', url: 'https://github.com/example/repo/pull/1' },
    ])).toMatchObject({ ok: true, action: 'delivered' });

    expect(await updateLinearExternalUrls(ds, client, [
      { key: 'dashboard-session', label: 'Botmux session', url: 'https://botmux.example.com/#/sessions?sessionId=session_egress' },
    ])).toMatchObject({ ok: true, action: 'duplicate' });

    expect(await updateLinearExternalUrls(ds, client, [
      { key: 'dashboard-session', label: 'Botmux session', url: 'https://botmux.example.com/#/sessions-v2' },
    ])).toMatchObject({ ok: true, action: 'delivered' });

    expect(client.externalUrlCalls).toHaveLength(2);
    expect(client.externalUrlCalls[1]).toMatchObject({
      agentSessionId: 'agent_session_1',
      externalUrls: [
        { label: 'Botmux session', url: 'https://botmux.example.com/#/sessions-v2' },
        { label: 'Pull request', url: 'https://github.com/example/repo/pull/1' },
      ],
    });
    expect(ds.session.linear?.externalUrls?.map(u => u.key)).toEqual(['dashboard-session', 'pr:1']);
  });

  it('projects Agent Plan only when explicitly enabled and dedupes updates', async () => {
    const ds = egressSession();
    const client = fakeClient();
    const plan = [
      { content: 'Inspect current implementation', status: 'completed' as const },
      { content: 'Run verification with token=abc and /Users/bytedance/private', status: 'inProgress' as const },
    ];

    expect(await projectLinearAgentPlan(ds, client, plan, false)).toMatchObject({
      ok: false,
      action: 'skipped',
      error: 'Linear Agent Plan projection is disabled',
    });
    expect(client.planCalls).toHaveLength(0);

    expect(await projectLinearAgentPlan(ds, client, plan, true)).toMatchObject({ ok: true, action: 'delivered' });
    expect(await projectLinearAgentPlan(ds, client, plan, true)).toMatchObject({ ok: true, action: 'duplicate' });

    expect(client.planCalls).toHaveLength(1);
    expect(client.planCalls[0]).toEqual({
      agentSessionId: 'agent_session_1',
      plan: [
        { content: 'Inspect current implementation', status: 'completed' },
        { content: 'Run verification with token=[redacted] and [local-path]', status: 'inProgress' },
      ],
    });
  });
});
