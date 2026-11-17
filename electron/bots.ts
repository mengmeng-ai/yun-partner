// Employee BOT team engine — Phase 3, clean-room implementation.
// Pure logic + JSON persistence helpers. No Electron APIs, no LLM calls here:
// the coordinator wires the real LLM later via runAgentTurn() (see below).
// Safety rule (from public Aivy docs): a worker's file change NEVER lands
// on disk by itself — it goes to the pending-approval queue and only lands
// after the checker (or the owner) approves it via approveChange().

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, Settings } from './types';

// ---------------------------------------------------------------------------
// Limits (public docs: 5 residents, +20 custom max, 5 skills each,
// 5 parallel per agent, 10 team-wide)
// ---------------------------------------------------------------------------
export const MAX_CUSTOM_AGENTS = 20;
export const MAX_SKILLS_PER_AGENT = 5;
export const AGENT_PARALLEL_CAP = 5;
export const TEAM_PARALLEL_CAP = 10;

export type BotRole = 'scout' | 'analyst' | 'worker' | 'checker' | 'monitor';

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error';

export interface BotDef {
  id: string;
  name: string;
  role: BotRole;
  title: string;
  systemPrompt: string;
  /** Tool allow-list. Names must exist in the coordinator's tool registry;
   *  web_search / file_diff / global_search / system_monitor are declared
   *  here for the coordinator to implement — this file never calls tools. */
  tools: string[];
  maxParallel: number;
}

export const BOT_DEFS: BotDef[] = [
  {
    id: 'scout',
    name: '小探',
    role: 'scout',
    title: '侦察员',
    systemPrompt:
      '你是小探，员工团队的侦察员。你只负责查资料：联网搜索、读文件、全盘搜索。' +
      '你不改任何文件，不跑任何命令。把找到的资料整理成要点，注明来源，交给分析师。' +
      '找不到就直说找不到，不要编造。',
    tools: ['web_search', 'file_read', 'global_search'],
    maxParallel: AGENT_PARALLEL_CAP,
  },
  {
    id: 'analyst',
    name: '分析师',
    role: 'analyst',
    title: '分析师',
    systemPrompt:
      '你是分析师，员工团队的规划者。你只负责理思路：把任务拆成步骤、排优先级、指出风险。' +
      '你不写文件、不改代码、不跑命令。输出一份清晰的执行计划，交给阿工执行。',
    tools: [],
    maxParallel: AGENT_PARALLEL_CAP,
  },
  {
    id: 'worker',
    name: '阿工',
    role: 'worker',
    title: '执行员',
    systemPrompt:
      '你是阿工，员工团队的执行员。你负责动手改文件、跑命令、跑 Python。' +
      '重要规则：你提出的每一个文件改动都只是“建议”，必须先放进待审批队列，' +
      '等核对员（或主人）批准后才能真正落地。你自己绝不直接写盘。' +
      '改动要小步、可回滚，并写清楚改了什么、为什么改。',
    tools: ['file_write', 'file_edit', 'run_command', 'run_python'],
    maxParallel: AGENT_PARALLEL_CAP,
  },
  {
    id: 'checker',
    name: '核对员',
    role: 'checker',
    title: '核对员',
    systemPrompt:
      '你是核对员，员工团队的质检员。你只负责核对：读回改动后的文件、对比 Diff、' +
      '全盘搜索确认没有漏改和误改。你批准或驳回阿工的改动，并写清楚理由。' +
      '你不自己改文件。没有核对通过的改动，一律不准落地。',
    tools: ['file_read', 'file_diff', 'global_search'],
    maxParallel: AGENT_PARALLEL_CAP,
  },
  {
    id: 'monitor',
    name: '监控员',
    role: 'monitor',
    title: '监控员',
    systemPrompt:
      '你是监控员，员工团队的瞭望员。你负责盯变化：系统 CPU / 内存 / 磁盘 / 进程，' +
      '以及指定文件的 mtime 变化。发现异常立刻汇报，不自己动手修。',
    tools: ['system_monitor', 'file_list'],
    maxParallel: AGENT_PARALLEL_CAP,
  },
];

/** Custom agent recruited by the owner (max 20, max 5 skills each). */
export interface CustomAgentDef {
  id: string;
  name: string;
  role: string; // free-form job title, e.g. '翻译'
  persona: string; // personality / instructions, becomes part of the system prompt
  skills: string[]; // tool names, max MAX_SKILLS_PER_AGENT
  model?: string; // optional per-agent model override; default = main model
}

export interface AgentCardState {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentTask: string | null;
  progress: number; // 0..100, real only — set by the coordinator from subtask state
  filesTouched: string[];
  log: string[];
}

export type SubtaskStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Subtask {
  id: string;
  title: string;
  role: BotRole | string;
  agentId: string | null; // assigned when started
  status: SubtaskStatus;
  createdAt: string;
  result?: string;
}

export type PendingChangeOp = 'write' | 'edit' | 'delete' | 'command';
export type PendingChangeStatus = 'pending' | 'approved' | 'rejected';

export interface PendingChange {
  id: string;
  agentId: string;
  agentName: string;
  op: PendingChangeOp;
  relPath: string | null; // null for pure commands
  summary: string;
  /** Proposed content / command text. Stored, NEVER applied by this module. */
  content: string;
  status: PendingChangeStatus;
  createdAt: string;
  decidedAt: string | null;
  reason?: string;
}

// ---------------------------------------------------------------------------
// System-prompt builders (pure — no LLM call)
// ---------------------------------------------------------------------------

export function buildAgentSystemPrompt(agent: BotDef | CustomAgentDef): string {
  if ('systemPrompt' in agent) return agent.systemPrompt;
  const skills = agent.skills.length > 0 ? `可用技能：${agent.skills.join('、')}。` : '没有配技能，只负责出主意。';
  return (
    `你是${agent.name}，岗位是${agent.role}。${agent.persona} ` +
    `${skills}你只能用上面列出的技能；文件改动一律先提交审批，不能直接落地。`
  );
}

// ---------------------------------------------------------------------------
// Task splitting — deterministic keyword heuristic, documented as such.
// The main agent (coordinator) may replace splitTask() with an LLM plan;
// this fallback keeps dispatch() usable with no LLM at all.
// ---------------------------------------------------------------------------

const ROLE_KEYWORDS: { role: BotRole; words: string[] }[] = [
  { role: 'scout', words: ['查', '搜索', '找资料', '搜', '调研', '看看', '了解'] },
  { role: 'analyst', words: ['分析', '计划', '规划', '思路', '拆解', '评估', '怎么'] },
  { role: 'worker', words: ['写', '改', '创建', '新建', '实现', '做', '修', '加', '删'] },
  { role: 'checker', words: ['检查', '核对', '验证', '测试', '确认', '对一下'] },
  { role: 'monitor', words: ['监控', '盯', '观察', '留意', '变化', '体检'] },
];

function classifySentence(sentence: string): BotRole {
  for (const { role, words } of ROLE_KEYWORDS) {
    if (words.some((w) => sentence.includes(w))) return role;
  }
  return 'analyst';
}

export function splitTask(taskText: string): { title: string; role: BotRole }[] {
  const text = taskText.trim();
  if (!text) return [];
  const sentences = text
    .split(/[。；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  if (sentences.length <= 1) {
    // Single instruction: run the standard pipeline for build-type work,
    // otherwise a single research subtask.
    const isBuild = /写|改|创建|新建|实现|做|修|加/.test(text);
    if (!isBuild) return [{ title: text, role: 'scout' }];
    return [
      { title: `查资料：${text}`, role: 'scout' },
      { title: `定计划：${text}`, role: 'analyst' },
      { title: `执行：${text}`, role: 'worker' },
      { title: `核对：${text}`, role: 'checker' },
    ];
  }
  return sentences.map((s) => ({ title: s, role: classifySentence(s) }));
}

// ---------------------------------------------------------------------------
// runAgentTurn — the exact signature the coordinator must wire.
// The coordinator supplies `chat`: a function that performs ONE LLM
// chat-completion call (streaming optional) and returns text + tool calls.
// This function itself never calls a model and never executes a tool: it
// builds the system prompt, calls the supplied chat fn, and filters any
// tool call outside the agent's allow-list into `blockedToolCalls`
// (returned, never executed). The coordinator executes allowed tool calls
// and, for worker file changes, must route them through proposeChange().
// ---------------------------------------------------------------------------

export interface AgentTurnRequest {
  agent: BotDef | CustomAgentDef;
  messages: ChatMessage[];
  settings: Settings;
}

export type LlmChatFn = (
  messages: ChatMessage[],
  opts: { model: string; temperature: number; tools: string[] },
) => Promise<{ text: string; toolCalls: { name: string; args: Record<string, unknown> }[] }>;

export interface AgentTurnResult {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  blockedToolCalls: { name: string; args: Record<string, unknown> }[];
}

export async function runAgentTurn(req: AgentTurnRequest, chat: LlmChatFn): Promise<AgentTurnResult> {
  const agent = req.agent;
  const allowed: string[] = 'tools' in agent ? agent.tools : agent.skills;
  const model = ('model' in agent && agent.model) || req.settings.model;
  const system: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'system',
    content: buildAgentSystemPrompt(agent),
    createdAt: new Date().toISOString(),
  };
  const { text, toolCalls } = await chat([system, ...req.messages], {
    model,
    temperature: req.settings.temperature,
    tools: allowed,
  });
  const ok: AgentTurnResult['toolCalls'] = [];
  const blocked: AgentTurnResult['blockedToolCalls'] = [];
  for (const tc of toolCalls) {
    (allowed.includes(tc.name) ? ok : blocked).push(tc);
  }
  return { text, toolCalls: ok, blockedToolCalls: blocked };
}

// ---------------------------------------------------------------------------
// Team — agents, queue, caps, approvals, custom agents, JSON persistence
// ---------------------------------------------------------------------------

export interface TeamSnapshot {
  version: 1;
  customAgents: CustomAgentDef[];
  queue: Subtask[];
  pendingApprovals: PendingChange[];
  cards: AgentCardState[];
}

export class Team {
  readonly agents: BotDef[] = BOT_DEFS;
  customAgents: CustomAgentDef[] = [];
  queue: Subtask[] = [];
  pendingApprovals: PendingChange[] = [];
  cards: Map<string, AgentCardState> = new Map();

  constructor() {
    for (const def of BOT_DEFS) {
      this.cards.set(def.id, {
        id: def.id,
        name: def.name,
        role: def.title,
        status: 'idle',
        currentTask: null,
        progress: 0,
        filesTouched: [],
        log: [],
      });
    }
  }

  cardList(): AgentCardState[] {
    return [...this.cards.values()];
  }

  runningCount(): number {
    return this.queue.filter((t) => t.status === 'running').length;
  }

  runningCountFor(agentId: string): number {
    return this.queue.filter((t) => t.status === 'running' && t.agentId === agentId).length;
  }

  /** Split a task and enqueue the subtasks. Overflow waits in the queue. */
  dispatch(taskText: string): Subtask[] {
    const parts = splitTask(taskText);
    const created: Subtask[] = parts.map((p) => ({
      id: crypto.randomUUID(),
      title: p.title,
      role: p.role,
      agentId: null,
      status: 'queued',
      createdAt: new Date().toISOString(),
    }));
    this.queue.push(...created);
    this.tryStart();
    return created;
  }

  /**
   * Start queued subtasks while caps allow. A subtask is claimed by the
   * resident agent of its role (custom agents are picked by the coordinator
   * via assignSubtask(); this method only starts resident-role subtasks).
   * Returns the subtasks that were started.
   */
  tryStart(): Subtask[] {
    const started: Subtask[] = [];
    for (const task of this.queue) {
      if (task.status !== 'queued') continue;
      if (this.runningCount() >= TEAM_PARALLEL_CAP) break;
      const agent = this.agents.find((a) => a.role === task.role);
      if (!agent) continue; // custom-role subtask: coordinator assigns it
      if (this.runningCountFor(agent.id) >= agent.maxParallel) continue;
      task.status = 'running';
      task.agentId = agent.id;
      const card = this.cards.get(agent.id);
      if (card) {
        card.status = 'working';
        card.currentTask = task.title;
        card.progress = 0;
        card.log.push(`开始：${task.title}`);
      }
      started.push(task);
    }
    return started;
  }

  /** Coordinator calls this when an agent finishes a subtask. */
  completeSubtask(id: string, ok: boolean, result = '', filesTouched: string[] = []): Subtask | null {
    const task = this.queue.find((t) => t.id === id);
    if (!task) return null;
    task.status = ok ? 'done' : 'failed';
    task.result = result;
    if (task.agentId) {
      const card = this.cards.get(task.agentId);
      if (card) {
        card.progress = ok ? 100 : card.progress;
        card.filesTouched = [...new Set([...card.filesTouched, ...filesTouched])];
        card.log.push(`${ok ? '完成' : '失败'}：${task.title}${result ? ` — ${result}` : ''}`);
        if (this.runningCountFor(task.agentId) === 0) {
          card.status = 'idle';
          card.currentTask = null;
        }
      }
    }
    this.queue = this.queue.filter((t) => t.status === 'queued' || t.status === 'running');
    this.tryStart();
    return task;
  }

  /** Assign a queued subtask to a custom agent (coordinator's choice). */
  assignSubtask(subtaskId: string, customAgentId: string): boolean {
    const task = this.queue.find((t) => t.id === subtaskId && t.status === 'queued');
    const agent = this.customAgents.find((a) => a.id === customAgentId);
    if (!task || !agent) return false;
    if (this.runningCount() >= TEAM_PARALLEL_CAP) return false;
    if (this.runningCountFor(customAgentId) >= AGENT_PARALLEL_CAP) return false;
    task.status = 'running';
    task.agentId = customAgentId;
    return true;
  }

  // --- pending approvals: worker changes land ONLY via approveChange() ---
  proposeChange(input: {
    agentId: string;
    op: PendingChangeOp;
    relPath: string | null;
    summary: string;
    content: string;
  }): PendingChange {
    const agent = this.agents.find((a) => a.id === input.agentId)
      ?? this.customAgents.find((a) => a.id === input.agentId);
    const change: PendingChange = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      agentName: agent?.name ?? input.agentId,
      op: input.op,
      relPath: input.relPath,
      summary: input.summary,
      content: input.content,
      status: 'pending',
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    this.pendingApprovals.push(change);
    return change;
  }

  /**
   * Approve a pending change. Returns the change so the COORDINATOR can
   * apply it to disk. This module never writes the file itself.
   */
  approveChange(id: string, reason = ''): PendingChange | null {
    const change = this.pendingApprovals.find((c) => c.id === id && c.status === 'pending');
    if (!change) return null;
    change.status = 'approved';
    change.decidedAt = new Date().toISOString();
    if (reason) change.reason = reason;
    return change;
  }

  rejectChange(id: string, reason = ''): PendingChange | null {
    const change = this.pendingApprovals.find((c) => c.id === id && c.status === 'pending');
    if (!change) return null;
    change.status = 'rejected';
    change.decidedAt = new Date().toISOString();
    if (reason) change.reason = reason;
    return change;
  }

  pendingList(): PendingChange[] {
    return this.pendingApprovals.filter((c) => c.status === 'pending');
  }

  // --- custom agents ---
  addCustomAgent(def: Omit<CustomAgentDef, 'id'> & { id?: string }): { ok: boolean; detail: string; agent?: CustomAgentDef } {
    if (this.customAgents.length >= MAX_CUSTOM_AGENTS) {
      return { ok: false, detail: `最多只能再招 ${MAX_CUSTOM_AGENTS} 位，已满` };
    }
    if (!def.name.trim() || !def.role.trim()) {
      return { ok: false, detail: '名字和岗位不能为空' };
    }
    if (def.skills.length > MAX_SKILLS_PER_AGENT) {
      return { ok: false, detail: `每人最多配 ${MAX_SKILLS_PER_AGENT} 项技能` };
    }
    if (this.customAgents.some((a) => a.name === def.name.trim())
      || this.agents.some((a) => a.name === def.name.trim())) {
      return { ok: false, detail: '已经有同名的员工了' };
    }
    const agent: CustomAgentDef = {
      id: def.id ?? crypto.randomUUID(),
      name: def.name.trim(),
      role: def.role.trim(),
      persona: def.persona,
      skills: [...def.skills],
      model: def.model,
    };
    this.customAgents.push(agent);
    this.cards.set(agent.id, {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: 'idle',
      currentTask: null,
      progress: 0,
      filesTouched: [],
      log: [],
    });
    return { ok: true, detail: '已招入', agent };
  }

  removeCustomAgent(id: string): boolean {
    const idx = this.customAgents.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.customAgents.splice(idx, 1);
    this.cards.delete(id);
    return true;
  }

  // --- JSON persistence (plain JSON, no Electron APIs) ---
  snapshot(): TeamSnapshot {
    return {
      version: 1,
      customAgents: this.customAgents,
      queue: this.queue,
      pendingApprovals: this.pendingApprovals,
      cards: this.cardList(),
    };
  }

  static restore(snap: TeamSnapshot): Team {
    const team = new Team();
    team.customAgents = snap.customAgents ?? [];
    team.queue = snap.queue ?? [];
    team.pendingApprovals = snap.pendingApprovals ?? [];
    for (const c of team.customAgents) {
      if (!team.cards.has(c.id)) {
        team.cards.set(c.id, {
          id: c.id, name: c.name, role: c.role, status: 'idle',
          currentTask: null, progress: 0, filesTouched: [], log: [],
        });
      }
    }
    for (const saved of snap.cards ?? []) {
      const card = team.cards.get(saved.id);
      if (card) Object.assign(card, saved, { status: saved.status === 'working' ? 'waiting' as AgentStatus : saved.status });
    }
    return team;
  }

  saveToFile(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.snapshot(), null, 2), 'utf-8');
  }

  static loadFromFile(filePath: string): Team | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      return Team.restore(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TeamSnapshot);
    } catch {
      return null;
    }
  }
}

/** Convenience: a fresh team with the 5 residents. */
export function createTeam(): Team {
  return new Team();
}

/** Convenience: dispatch a task on a team (same as team.dispatch). */
export function dispatch(team: Team, taskText: string): Subtask[] {
  return team.dispatch(taskText);
}

/** Standalone approval helpers for the coordinator (operate on a Team). */
export function approveChange(team: Team, id: string, reason = ''): PendingChange | null {
  return team.approveChange(id, reason);
}

export function rejectChange(team: Team, id: string, reason = ''): PendingChange | null {
  return team.rejectChange(id, reason);
}
