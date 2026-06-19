import { basename } from 'node:path';
import type { LinearRepositoryConfig } from '../config.js';
import type { LinearFeedTurn } from './linear-channel.js';
import { validateWorkingDir } from './working-dir.js';

export interface LinearIssueProject {
  id?: string;
  name?: string;
  content?: string;
  description?: string;
}

export interface LinearProjectBotmuxConfig {
  repo?: string;
  repositoryFullName?: string;
  repoSelection?: 'auto' | 'select';
}

export interface LinearProjectPromptContext {
  projectId?: string;
  projectName?: string;
  background?: string;
  workbenchSummary?: string;
  truncated?: boolean;
}

export type LinearProjectConfigApplyResult =
  | { action: 'applied'; turn: LinearFeedTurn; project: LinearIssueProject; config: LinearProjectBotmuxConfig; repository: LinearRepositoryConfig & { workingDir: string } }
  | { action: 'fallback'; turn: LinearFeedTurn; reason: string; project?: LinearIssueProject; config?: LinearProjectBotmuxConfig };

const BOTMUX_SUMMARY_START = '<!-- botmux:workbench-summary:start -->';
const BOTMUX_SUMMARY_END = '<!-- botmux:workbench-summary:end -->';
const DEFAULT_PROJECT_CONTEXT_LIMIT = 6000;

export function parseLinearProjectBotmuxConfig(description: string | undefined): LinearProjectBotmuxConfig | null {
  if (!description?.trim()) return null;
  const block = findBotmuxBlock(description);
  if (!block) return null;

  const config: LinearProjectBotmuxConfig = {};
  for (const line of block.split('\n')) {
    const match = /^\s+([A-Za-z][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = unquote(match[2]);
    if (!value) continue;
    if (key === 'repo') config.repo = value;
    else if (key === 'repositoryFullName') config.repositoryFullName = value;
    else if (key === 'repoSelection' && (value === 'auto' || value === 'select')) config.repoSelection = value;
  }
  return config.repo || config.repositoryFullName || config.repoSelection ? config : null;
}

export function applyLinearProjectConfigToTurn(
  turn: LinearFeedTurn,
  project: LinearIssueProject | null | undefined,
  candidates: LinearRepositoryConfig[],
): LinearProjectConfigApplyResult {
  const turnWithProject = project ? { ...turn, issue: { ...turn.issue, project } } : turn;
  if (turn.workingDir?.trim()) return { action: 'fallback', turn: turnWithProject, reason: 'turn already has workingDir', project: project ?? undefined };
  const config = parseLinearProjectBotmuxConfig(project?.content ?? project?.description);
  if (!project || !config) return { action: 'fallback', turn: turnWithProject, reason: 'project config not found', project: project ?? undefined };
  if (config.repoSelection === 'select') return { action: 'fallback', turn: turnWithProject, reason: 'project requested select', project, config };

  const matches = validCandidates(candidates).filter(candidate => matchesProjectRepoConfig(candidate, config));
  if (matches.length !== 1) {
    return { action: 'fallback', turn: turnWithProject, reason: matches.length ? 'project config matched multiple repos' : 'project config matched no repos', project, config };
  }

  const repository = matches[0]!;
  return {
    action: 'applied',
    project,
    config,
    repository,
    turn: {
      ...turnWithProject,
      workingDir: repository.workingDir,
      promptContext: {
        originalPromptContext: turn.promptContext ?? null,
        linearProjectConfig: {
          projectId: project.id,
          projectName: project.name,
          selectedRepositoryKey: repository.key,
          repositoryFullName: repository.repositoryFullName,
        },
      },
    },
  };
}

export function buildLinearProjectPromptContext(
  project: LinearIssueProject | null | undefined,
  maxChars = DEFAULT_PROJECT_CONTEXT_LIMIT,
): LinearProjectPromptContext | null {
  if (!project) return null;
  const content = project.content ?? project.description ?? '';
  const { withoutSummary, summary } = splitBotmuxSummary(content);
  const background = stripBotmuxConfigBlocks(withoutSummary);
  const backgroundPart = truncate(normalizeProjectText(background), maxChars);
  const summaryPart = truncate(normalizeProjectText(summary), Math.floor(maxChars / 2));
  const ctx: LinearProjectPromptContext = {};
  if (project.id) ctx.projectId = project.id;
  if (project.name) ctx.projectName = project.name;
  if (backgroundPart.text) ctx.background = backgroundPart.text;
  if (summaryPart.text) ctx.workbenchSummary = summaryPart.text;
  if (backgroundPart.truncated || summaryPart.truncated) ctx.truncated = true;
  return ctx.projectId || ctx.projectName || ctx.background || ctx.workbenchSummary ? ctx : null;
}

function findBotmuxBlock(description: string): string | null {
  const blocks = fencedBlocks(description);
  for (const block of blocks.length ? blocks : [description]) {
    const lines = block.split('\n');
    const start = lines.findIndex(line => /^\s*botmux\s*:\s*$/.test(line));
    if (start === -1) continue;
    const collected = [lines[start]!];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim() && !/^\s/.test(line)) break;
      collected.push(line);
    }
    return collected.join('\n');
  }
  return null;
}

function splitBotmuxSummary(content: string): { withoutSummary: string; summary: string } {
  const start = content.indexOf(BOTMUX_SUMMARY_START);
  const end = content.indexOf(BOTMUX_SUMMARY_END);
  if (start === -1 || end === -1 || end <= start) return { withoutSummary: content, summary: '' };
  return {
    withoutSummary: `${content.slice(0, start)}${content.slice(end + BOTMUX_SUMMARY_END.length)}`,
    summary: content.slice(start + BOTMUX_SUMMARY_START.length, end),
  };
}

function stripBotmuxConfigBlocks(content: string): string {
  const withoutFencedConfig = content.replace(/```(?:ya?ml|text)?\s*\n([\s\S]*?)```/g, (block, body: string) =>
    /^\s*botmux\s*:\s*$/m.test(body) ? '' : block);
  return stripPlainBotmuxConfigBlock(withoutFencedConfig);
}

function stripPlainBotmuxConfigBlock(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!/^\s*botmux\s*:\s*$/.test(line)) {
      kept.push(line);
      continue;
    }
    i += 1;
    while (i < lines.length && (!lines[i]!.trim() || /^\s/.test(lines[i]!))) i += 1;
    i -= 1;
  }
  return kept.join('\n');
}

function normalizeProjectText(text: string): string {
  return text.trim().replace(/\n{3,}/g, '\n\n');
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars).trimEnd()}\n\n[truncated]`, truncated: true };
}

function fencedBlocks(description: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:ya?ml|text)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(description))) blocks.push(match[1] ?? '');
  return blocks;
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function validCandidates(candidates: LinearRepositoryConfig[]): Array<LinearRepositoryConfig & { workingDir: string }> {
  const valid: Array<LinearRepositoryConfig & { workingDir: string }> = [];
  for (const candidate of candidates) {
    const wd = validateWorkingDir(candidate.workingDir);
    if (wd.ok) valid.push({ ...candidate, workingDir: wd.resolvedPath });
  }
  return valid;
}

function matchesProjectRepoConfig(candidate: LinearRepositoryConfig, config: LinearProjectBotmuxConfig): boolean {
  const values = [config.repositoryFullName, config.repo].filter((value): value is string => !!value?.trim());
  return values.some(value => matchesRepoValue(candidate, value.trim()));
}

function matchesRepoValue(candidate: LinearRepositoryConfig, raw: string): boolean {
  const value = raw.toLowerCase();
  const repoBase = basename(candidate.workingDir).toLowerCase();
  const displayBase = (candidate.displayName ?? '').replace(/\s+\(.+\)$/, '').toLowerCase();
  const fullName = candidate.repositoryFullName.toLowerCase();
  return candidate.key.toLowerCase() === value
    || fullName === value
    || fullName.endsWith(`/${value}`)
    || repoBase === value
    || displayBase === value;
}
