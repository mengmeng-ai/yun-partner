import { app, BrowserWindow, dialog, ipcMain} from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Store, redact} from './store';
import { chatStream, DESTRUCTIVE_TOOLS} from './llm';
import { editFile, listFiles, readFile, runCommand, runPython, writeFile} from './tools';
import { TOOL2_DEFS, TOOL2_META, executeTool2 } from './tools2';
import { UndoJournal } from './undo';
import { getSystemStatus } from './monitor';
import { searchSemantic } from './semantic';
import { buildWikiGraph } from './wiki';
import { Team, createTeam, dispatch as teamDispatch, approveChange, rejectChange, runAgentTurn } from './bots';
import type { BotDef, CustomAgentDef, Subtask } from './bots';
import { listMcpTools, callMcpTool } from './mcp';
import type { McpServerConfig } from './mcp';
import { listSkills, loadSkill, installSkillFromGit, removeSkill } from './skills';
import { SchedulerStore, defaultSchedulerPath } from './scheduler';
import { getControlTree, clickControl, typeIntoControl, screenshot } from './computer';
import { setupAutoUpdater } from './updater';
import type { ChatMessage, Settings} from './types';
import { PROVIDER_DEFAULTS} from './types';

const isDev =!app.isPackaged;
let win: BrowserWindow | null = null;
let store: Store;
let unlocked = false;
let abort: AbortController | null = null;
let approvalWaiters = new Map<string, (ok: boolean) => void>();
let team: Team | null = null;
let scheduler: SchedulerStore | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

function teamFile() { return path.join(userDataDir(), 'team.json'); }
function skillsDir() { return path.join(userDataDir(), 'skills'); }
function lastSeenFile() { return path.join(userDataDir(), 'last-seen.json'); }
function saveTeam() { try { team?.saveToFile(teamFile()); } catch { /* team state is best-effort */ } }
function saveLastSeen() {
  try { fs.writeFileSync(lastSeenFile(), JSON.stringify({ at: new Date().toISOString() }), 'utf-8'); } catch { /* ignore */ }
}
function readLastSeen(): Date | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lastSeenFile(), 'utf-8')) as { at?: string };
    return raw.at ? new Date(raw.at) : null;
  } catch { return null; }
}

/** Semantic recall over memories + Wiki (TF-IDF/cosine, local, no API key). Falls back to keyword recall. */
function recallSemantic(query: string): string[] {
  try {
    const items = [
      ...store.memories.map((m) => ({ id: `m:${m.id}`, text: m.text })),
      ...store.listWiki().map((w) => ({ id: `w:${w.id}`, text: `${w.title}\n${w.body.slice(0, 2000)}` })),
    ];
    const hits = searchSemantic(query, items, 5);
    if (hits.length > 0) return hits.map((h) => h.text);
  } catch { /* fall through to keyword recall */ }
  return store.recall(query).map((m) => m.text);
}

function userDataDir() {
return app.getPath('userData');
}

function createWindow() {
win = new BrowserWindow({
width: 1280, height: 860, minWidth: 900, minHeight: 600,
title: '允允的数字伙伴',
webPreferences: {
preload: path.join(__dirname, 'preload.js'),
contextIsolation: true,
nodeIntegration: false,
sandbox: false,
},
});
if (isDev) win.loadURL('http://127.0.0.1:5173');
else win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
win.on('closed', () => { win = null;});
}

function requestApproval(summary: string): Promise<boolean> {
const id = crypto.randomUUID();
win?.webContents.send('approval:request', { id, summary});
return new Promise((resolve) => {
approvalWaiters.set(id, resolve);
setTimeout(() => { if (approvalWaiters.has(id)) { approvalWaiters.delete(id); resolve(false);}}, 5 * 60_000);
});
}

async function executeTool(name: string, args: Record<string, unknown>, settings: Settings): Promise<string> {
const ws = settings.workspace;
switch (name) {
case 'file_list': return JSON.stringify(listFiles(ws, String(args.relPath?? '.')));
case 'file_read': return readFile(ws, String(args.relPath));
case 'file_write': writeFile(ws, String(args.relPath), String(args.content?? '')); return `已写入 ${args.relPath}`;
case 'file_edit': editFile(ws, String(args.relPath), String(args.oldText?? ''), String(args.newText?? '')); return `已修改 ${args.relPath}`;
case 'run_command': { const r = await runCommand(ws, String(args.command)); return `退出码 ${r.code}\n${r.stdout}\n${r.stderr}`;}
case 'run_python': { const r = await runPython(ws, String(args.code)); return `退出码 ${r.code}\n${r.stdout}\n${r.stderr}`;}
case 'save_memory': store.addMemory(String(args.text), (args.tags as string[])?? []); return '已记进长期记忆';
case 'save_wiki': { const p = store.saveWiki(String(args.title), `# ${args.title}\n\n${args.body}`); return `已保存 Wiki 页：${p.title}`;}
default: {
  // Phase-1 tools (25): file copy/move/delete, paged read, diff, docs,
  // web search/fetch, global search, monitor, undo, winget/npm/pip.
  if (TOOL2_DEFS.some((d) => d.function.name === name)) {
    return executeTool2(name, args, { workspace: ws, userDataDir: userDataDir() });
  }
  throw new Error(`未知工具：${name}`);
}
}
}

/** Non-streaming LLM call for employee-bot turns (honours the agent's allow-list + model override). */
function teamLlmChat(settings: Settings) {
  return async (
    messages: ChatMessage[],
    opts: { model: string; temperature: number; tools: string[] },
  ): Promise<{ text: string; toolCalls: { name: string; args: Record<string, unknown> }[] }> => {
    const s: Settings = { ...settings, model: opts.model || settings.model, temperature: opts.temperature };
    const { text, toolCalls } = await chatStream(s, messages, {
      signal: new AbortController().signal,
      onEvent: () => { /* team turns are non-streaming; result comes from the return value */ },
      useTools: opts.tools.length > 0,
      toolNames: opts.tools,
    });
    return { text, toolCalls };
  };
}

/** Apply an approved employee change to disk (checker + owner both said yes). */
async function applyApprovedChange(change: { op: string; relPath: string | null; content: string }): Promise<string> {
  const ws = store.settings.workspace;
  const args = JSON.parse(change.content || '{}') as Record<string, unknown>;
  const journal = new UndoJournal(userDataDir());
  const snap = (rel: string) => {
    try { journal.recordChange(rel, readFile(ws, rel), `员工改动：${change.op}`); } catch { /* new file: nothing to snapshot */ }
  };
  switch (change.op) {
    case 'write': {
      const rel = String(change.relPath ?? args.relPath ?? '');
      snap(rel);
      writeFile(ws, rel, String(args.content ?? ''));
      return `已写入 ${rel}`;
    }
    case 'edit': {
      const rel = String(change.relPath ?? args.relPath ?? '');
      snap(rel);
      editFile(ws, rel, String(args.oldText ?? ''), String(args.newText ?? ''));
      return `已修改 ${rel}`;
    }
    case 'delete': {
      const rel = String(change.relPath ?? args.relPath ?? '');
      snap(rel);
      const { safeJoin } = await import('./tools');
      fs.rmSync(safeJoin(ws, rel), { recursive: true, force: true });
      return `已删除 ${rel}`;
    }
    case 'command': {
      const r = await runCommand(ws, String(args.command ?? ''));
      return `退出码 ${r.code}\n${r.stdout}\n${r.stderr}`;
    }
    default: throw new Error(`不支持的员工改动：${change.op}`);
  }
}

function emitTeam() {
  if (!team || !win || win.isDestroyed()) return;
  try {
    win.webContents.send('team:update', {
      agents: team.cardList(),
      customAgents: team.customAgents,
      queue: team.queue,
      pending: team.pendingList(),
    });
  } catch { /* renderer gone */ }
}

/** Run one employee subtask end-to-end. Mutating calls go to the approval queue, never straight to disk. */
async function runTeamSubtask(sub: Subtask): Promise<void> {
  if (!team) return;
  const settings = store.settings;
  const agent: BotDef | CustomAgentDef | undefined =
    team.agents.find((a) => a.id === sub.agentId) ?? team.customAgents.find((a) => a.id === sub.agentId);
  if (!agent) { team.completeSubtask(sub.id, false, '找不到对应的员工'); saveTeam(); emitTeam(); return; }
  try {
    const { text, toolCalls } = await runAgentTurn(
      {
        agent,
        messages: [{ id: crypto.randomUUID(), role: 'user', content: `任务：${sub.title}\n只做这件事，做完用一句话汇报结果。`, createdAt: new Date().toISOString() }],
        settings,
      },
      teamLlmChat(settings),
    );
    const touched: string[] = [];
    const notes: string[] = [text];
    for (const tc of toolCalls) {
      if (DESTRUCTIVE_TOOLS.has(tc.name)) {
        // Worker file/command changes need checker + owner approval before landing.
        const rel = typeof tc.args.relPath === 'string' ? tc.args.relPath : null;
        const op = tc.name === 'file_edit' ? 'edit' : tc.name === 'file_delete' ? 'delete'
          : (tc.name === 'run_command' || tc.name === 'run_python' || tc.name === 'npm_install' || tc.name === 'pip_install' || tc.name === 'winget_install' || tc.name === 'process_kill' || tc.name === 'undo_change') ? 'command' : 'write';
        team.proposeChange({ agentId: agent.id, op, relPath: rel, summary: `${agent.name} 想执行 ${tc.name}：${redact(JSON.stringify(tc.args)).slice(0, 200)}`, content: JSON.stringify(tc.args) });
        notes.push(`已提交审批：${tc.name}`);
        if (rel) touched.push(rel);
        continue;
      }
      try {
        const out = await executeTool(tc.name, tc.args, settings);
        notes.push(`${tc.name}：${out.slice(0, 500)}`);
      } catch (err) {
        notes.push(`${tc.name} 失败：${(err as Error).message}`);
      }
    }
    team.completeSubtask(sub.id, true, notes.filter(Boolean).join('\n').slice(0, 2000), touched);
  } catch (err) {
    team.completeSubtask(sub.id, false, (err as Error).message);
  }
  saveTeam();
  emitTeam();
  // Start the next queued subtask, if any.
  const next = team.tryStart();
  for (const s of next) void runTeamSubtask(s);
}

app.whenReady().then(() => {
store = new Store(userDataDir());
team = Team.loadFromFile(teamFile()) ?? createTeam();
scheduler = new SchedulerStore(defaultSchedulerPath(userDataDir()));
createWindow();
setupAutoUpdater(win!);
// Scheduler: check due tasks every minute; reminders surface as renderer events.
const checkScheduler = () => {
  if (!scheduler) return;
  const { due } = scheduler.checkDue(new Date());
  for (const t of due) {
    scheduler.markRun(t.id);
    win?.webContents.send('scheduler:due', t);
  }
};
schedulerTimer = setInterval(checkScheduler, 60_000);
if (typeof schedulerTimer === 'object' && schedulerTimer !== null) (schedulerTimer as unknown as { unref?: () => void }).unref?.();
checkScheduler();

ipcMain.handle('lock:status', () => ({ hasLock: store.hasLock, unlocked}));
ipcMain.handle('lock:set', (_e, password: string) => { store.setPassword(password); unlocked = true; return true;});
ipcMain.handle('lock:unlock', (_e, password: string) => {
  unlocked = store.verifyPassword(password);
  if (unlocked && scheduler) {
    const last = readLastSeen();
    if (last) {
      const missed = scheduler.missedSince(last, new Date());
      if (missed.length > 0) win?.webContents.send('scheduler:missed', missed);
    }
  }
  return unlocked;
});
ipcMain.handle('lock:lock', () => { unlocked = false; saveLastSeen(); return true;});

ipcMain.handle('settings:get', () => ({...store.settings, apiKey: store.settings.apiKey}));
ipcMain.handle('settings:save', (_e, s: Settings) => {
if (s.provider && PROVIDER_DEFAULTS[s.provider] &&!s.baseUrl) s.baseUrl = PROVIDER_DEFAULTS[s.provider].baseUrl;
store.saveSettings(s);
return true;
});
ipcMain.handle('settings:pick-workspace', async () => {
const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory']});
return r.canceled? null: r.filePaths[0];
});

ipcMain.handle('soul:get', () => store.soul);
ipcMain.handle('soul:save', (_e, text: string) => { store.saveSoul(text); return true;});
ipcMain.handle('profile:get', () => store.profile);
ipcMain.handle('profile:save', (_e, p) => { store.saveProfile(p); return true;});
ipcMain.handle('memory:list', () => store.memories);
ipcMain.handle('memory:add', (_e, text: string, tags: string[]) => { store.addMemory(text, tags); return true;});
ipcMain.handle('memory:delete', (_e, id: string) => { store.deleteMemory(id); return true;});
ipcMain.handle('memory:recall', (_e, q: string) => store.recall(q));
ipcMain.handle('wiki:list', () => store.listWiki());
ipcMain.handle('wiki:save', (_e, title: string, body: string) => store.saveWiki(title, body));
ipcMain.handle('history:get', () => store.history);
ipcMain.handle('history:clear', () => { store.saveHistory([]); return true;});

ipcMain.handle('models:list', async () => {
const { listModels} = await import('./llm');
return listModels(store.settings);
});

ipcMain.handle('files:list', (_e, relPath: string) => listFiles(store.settings.workspace, relPath));
ipcMain.handle('files:read', (_e, relPath: string) => readFile(store.settings.workspace, relPath));
// ---- Phase 1: extra tools (25) ----
ipcMain.handle('tools2:list', () => ({ defs: TOOL2_DEFS, meta: TOOL2_META }));
ipcMain.handle('tools2:call', async (_e, name: string, args: Record<string, unknown>) => {
  if (TOOL2_META[name]?.needsApproval) {
    if (!unlocked) throw new Error('未解锁：这个操作要先输主人密码');
    const ok = await requestApproval(`要执行 ${name}：${redact(JSON.stringify(args)).slice(0, 300)}`);
    if (!ok) throw new Error('已取消');
  }
  return executeTool2(name, args, { workspace: store.settings.workspace, userDataDir: userDataDir() });
});

// ---- System monitor / undo / wiki graph / semantic recall ----
ipcMain.handle('system:status', () => getSystemStatus());
ipcMain.handle('undo:list', () => new UndoJournal(userDataDir()).listChanges());
ipcMain.handle('undo:restore', (_e, id: string) => new UndoJournal(userDataDir()).restore(store.settings.workspace, id));
ipcMain.handle('wiki:graph', () => buildWikiGraph(store.listWiki()));
ipcMain.handle('memory:semantic', (_e, q: string) => recallSemantic(q));
ipcMain.handle('files:write', (_e, relPath: string, content: string) => {
  if (!unlocked) throw new Error('未解锁：写文件要先输主人密码');
  const journal = new UndoJournal(userDataDir());
  try { journal.recordChange(relPath, readFile(store.settings.workspace, relPath), 'IDE 保存'); } catch { /* new file */ }
  writeFile(store.settings.workspace, relPath, content);
  return true;
});

// ---- Employee team ----
ipcMain.handle('team:list', () => team ? { agents: team.cardList(), customAgents: team.customAgents, queue: team.queue, pending: team.pendingList() } : null);
ipcMain.handle('team:dispatch', (_e, text: string) => {
  if (!team) throw new Error('员工队还没初始化');
  if (!store.settings.apiKey && store.settings.provider !== 'ollama') throw new Error('先在设置里填 API Key');
  const created = teamDispatch(team, text);
  saveTeam();
  emitTeam();
  for (const s of team.queue.filter((t) => t.status === 'running')) void runTeamSubtask(s);
  return created;
});
ipcMain.handle('team:approve', async (_e, id: string) => {
  if (!team) throw new Error('员工队还没初始化');
  const change = approveChange(team, id);
  if (!change) throw new Error('找不到这条待审批');
  const result = await applyApprovedChange(change);
  saveTeam(); emitTeam();
  return result;
});
ipcMain.handle('team:reject', (_e, id: string) => {
  if (!team) throw new Error('员工队还没初始化');
  const ok = !!rejectChange(team, id);
  saveTeam(); emitTeam();
  return ok;
});
ipcMain.handle('team:custom-add', (_e, def: { name: string; role: string; persona: string; skills: string[]; model?: string }) => {
  if (!team) throw new Error('员工队还没初始化');
  const r = team.addCustomAgent(def);
  if (r.ok) { saveTeam(); emitTeam(); }
  return r;
});
ipcMain.handle('team:custom-remove', (_e, id: string) => {
  if (!team) return false;
  const ok = team.removeCustomAgent(id);
  if (ok) { saveTeam(); emitTeam(); }
  return ok;
});

// ---- MCP (on-demand only, never auto-connected) ----
ipcMain.handle('mcp:list-servers', () => store.settings.mcpServers ?? []);
ipcMain.handle('mcp:save-servers', (_e, servers: McpServerConfig[]) => {
  store.saveSettings({ ...store.settings, mcpServers: servers });
  return true;
});
ipcMain.handle('mcp:list-tools', async (_e, config: McpServerConfig) => listMcpTools(config));
ipcMain.handle('mcp:call-tool', async (_e, config: McpServerConfig, name: string, args: Record<string, unknown>) => callMcpTool(config, name, args));

// ---- Skills ----
ipcMain.handle('skills:list', () => listSkills(skillsDir()));
ipcMain.handle('skills:load', (_e, name: string) => loadSkill(skillsDir(), name));
ipcMain.handle('skills:install', async (_e, gitUrl: string) => installSkillFromGit(gitUrl, skillsDir()));
ipcMain.handle('skills:remove', (_e, name: string) => removeSkill(skillsDir(), name));

// ---- Scheduler ----
ipcMain.handle('scheduler:list', () => scheduler?.list() ?? []);
ipcMain.handle('scheduler:add', (_e, input: { title: string; schedule: { minute: number; hour: number } | { intervalMinutes: number }; action: 'remind' | 'run'; payload: string }) => scheduler?.add(input) ?? null);
ipcMain.handle('scheduler:remove', (_e, id: string) => scheduler?.remove(id) ?? false);
ipcMain.handle('scheduler:set-enabled', (_e, id: string, enabled: boolean) => scheduler?.setEnabled(id, enabled) ?? false);
ipcMain.handle('scheduler:due', () => scheduler?.checkDue(new Date()) ?? { due: [], missed: [] });

// ---- Computer operation (Windows UIA; Linux returns Windows-only) ----
ipcMain.handle('computer:tree', () => getControlTree());
ipcMain.handle('computer:click', (_e, name: string) => clickControl(name));
ipcMain.handle('computer:type', (_e, name: string, text: string) => typeIntoControl(name, text));
ipcMain.handle('computer:screenshot', () => screenshot());

ipcMain.on('approval:respond', (_e, id: string, ok: boolean) => {
approvalWaiters.get(id)?.(ok);
approvalWaiters.delete(id);
});

ipcMain.handle('chat:send', async (_e, userText: string) => {
const settings = store.settings;
if (!settings.apiKey && settings.provider!== 'ollama') throw new Error('先在设置里填 API Key');
const history = store.history;
const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: userText, createdAt: new Date().toISOString()};
history.push(userMsg);

const profile = store.profile;
const recalledTexts = recallSemantic(userText);
const system: ChatMessage = {
id: 'system', role: 'system',
content: `${store.soul}\n\n名字：${profile.name}，昵称：${profile.nickname}，叫她：${profile.callMe}。${profile.notes}\n\n${recalledTexts.map((t) => `- ${t}`).join('\n') || '（暂无）'}\n你只能操作设置里的工作区，删/改/跑命令前必须经过工具确认；不知道就说不知道，别编。`,
createdAt: new Date().toISOString(),
};

const messages: ChatMessage[] = [system,...history.slice(-30)];
let assistantText = '';
abort = new AbortController();
try {
for (let step = 0; step < 8; step++) {
const { text, toolCalls} = await chatStream(settings, messages, {
signal: abort.signal,
useTools: unlocked, // locked state: chat-only, no tools
onEvent: (ev) => {
if (ev.type === 'delta' && ev.text) { assistantText += ev.text; win?.webContents.send('chat:delta', ev.text);}
},
});
assistantText = text || assistantText;
if (toolCalls.length === 0) break;
// Execute tool calls (destructive ones need approval first).
for (const tc of toolCalls) {
if (DESTRUCTIVE_TOOLS.has(tc.name)) {
const ok = await requestApproval(`要执行 ${tc.name}：${redact(JSON.stringify(tc.args)).slice(0, 300)}`);
if (!ok) { messages.push({ id: crypto.randomUUID(), role: 'tool', content: `工具 ${tc.name} 被用户拒绝`, createdAt: new Date().toISOString()}); continue;}
}
try {
const result = await executeTool(tc.name, tc.args, settings);
messages.push({ id: crypto.randomUUID(), role: 'tool', content: `\n${result.slice(0, 8000)}`, createdAt: new Date().toISOString()});
} catch (err) {
messages.push({ id: crypto.randomUUID(), role: 'tool', content: `${(err as Error).message}`, createdAt: new Date().toISOString()});
}
}
// After tool results, ask the model to continue / summarise.
const cont = await chatStream(settings, messages, {
signal: abort.signal, useTools: false,
onEvent: (ev) => { if (ev.type === 'delta' && ev.text) { assistantText += ev.text; win?.webContents.send('chat:delta', ev.text);}},
});
assistantText = cont.text || assistantText;
break;
}
} catch (err) {
if ((err as Error).name === 'AbortError') assistantText += '\n（已停止）';
else throw err;
} finally {
abort = null;
}
const asst: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: assistantText, createdAt: new Date().toISOString()};
history.push(asst);
store.saveHistory(history);
win?.webContents.send('chat:done', asst);
return asst;
});

ipcMain.handle('chat:stop', () => { abort?.abort(); return true;});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow();});
});

app.on('window-all-closed', () => { saveLastSeen(); if (process.platform!== 'darwin') app.quit();});
