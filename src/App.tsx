import { useEffect, useRef, useState } from 'react';
import IdePanel from './components/IdePanel';
import PreviewPanel, { detectKind } from './components/PreviewPanel';
import TeamPanel from './components/TeamPanel';
import VoicePanel from './components/VoicePanel';
import BrowserPanel from './components/BrowserPanel';
import UpdateBanner, { UPDATE_DATA_NOTE } from './components/UpdateBanner';

type Msg = { id: string; role: string; content: string };
type Tab = 'chat' | 'ide' | 'team' | 'voice' | 'browser' | 'memory' | 'settings' | 'soul';

const TAB_LABELS: Record<Tab, string> = {
  chat: '对话', ide: 'IDE', team: '员工队', voice: '语音', browser: '浏览器',
  memory: '记忆 / Wiki', settings: '设置', soul: '灵魂',
};

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini' },
  { id: 'ollama', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' },
  { id: 'custom', label: '自定义 (OpenAI 兼容)', baseUrl: '', model: '' },
];

const DOC_EXTS = new Set(['pdf', 'docx', 'xlsx', 'xls', 'pptx']);

function newTabId() { return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export default function App() {
  const [lock, setLock] = useState<{ hasLock: boolean; unlocked: boolean } | null>(null);
  const [pw, setPw] = useState('');
  const [tab, setTab] = useState<Tab>('chat');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [settings, setSettings] = useState<any>(null);
  const [soul, setSoul] = useState('');
  const [profile, setProfile] = useState<any>(null);
  const [memories, setMemories] = useState<any[]>([]);
  const [wiki, setWiki] = useState<any[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [preview, setPreview] = useState({ name: '', content: '在左边对话框里让她读写文件，或点左侧文件列表，内容会显示在这里。' });
  const [models, setModels] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<{ id: string; summary: string } | null>(null);
  const [memText, setMemText] = useState('');
  // IDE
  const [ideName, setIdeName] = useState('');
  const [ideContent, setIdeContent] = useState('');
  const [ideEntries, setIdeEntries] = useState<any[]>([]);
  // Team
  const [teamData, setTeamData] = useState<any>(null);
  const [caName, setCaName] = useState('');
  const [caRole, setCaRole] = useState('');
  const [caPersona, setCaPersona] = useState('');
  const [caSkills, setCaSkills] = useState('');
  // Voice
  const [ttsEnabled, setTtsEnabled] = useState(false);
  // Browser
  const [browserTabs, setBrowserTabs] = useState([{ id: 'tab-0', url: 'https://www.bing.com', title: '新标签页' }]);
  const [browserActive, setBrowserActive] = useState('tab-0');
  // Memory semantic + wiki graph
  const [semQuery, setSemQuery] = useState('');
  const [semResults, setSemResults] = useState<any[]>([]);
  const [wikiGraph, setWikiGraph] = useState<any>(null);
  // Settings extras
  const [updateStatus, setUpdateStatus] = useState<any>({ state: 'idle' });
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [mcpName, setMcpName] = useState('');
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio');
  const [mcpCmd, setMcpCmd] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [skills, setSkills] = useState<any[]>([]);
  const [skillUrl, setSkillUrl] = useState('');
  const [schedTasks, setSchedTasks] = useState<any[]>([]);
  const [schedTitle, setSchedTitle] = useState('');
  const [schedHour, setSchedHour] = useState(9);
  const [schedMinute, setSchedMinute] = useState(0);
  const [schedPayload, setSchedPayload] = useState('');
  const [sysStatus, setSysStatus] = useState<any>(null);
  const [dueNotes, setDueNotes] = useState<any[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { refreshAll(); }, []);
  useEffect(() => {
    window.api.onChatDelta((t) => setStreamText((s) => s + t));
    window.api.onChatDone(() => { setStreaming(false); setStreamText(''); refreshHistory(); });
    window.api.onApproval((r) => setApproval(r));
    window.api.onTeamUpdate(() => { void refreshTeam(); });
    window.api.onSchedulerDue((t: any) => { setDueNotes((n) => [...n, { kind: '提醒', ...t }]); });
    window.api.onSchedulerMissed((list: any) => { setDueNotes((n) => [...n, ...(Array.isArray(list) ? list.map((t: any) => ({ kind: '错过', ...t })) : [])]); });
    window.api.onUpdaterStatus((s: any) => { setUpdateStatus(s); });
    window.api.getUpdaterStatus().then((s: any) => { if (s) setUpdateStatus(s); }).catch(() => { /* updater not ready */ });
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, streamText]);

  async function refreshAll() {
    const [l, s, so, p, h] = await Promise.all([
      window.api.lockStatus(), window.api.getSettings(), window.api.getSoul(),
      window.api.getProfile(), window.api.getHistory(),
    ]);
    setLock(l); setSettings(s); setSoul(so); setProfile(p);
    setMsgs(h.filter((m: Msg) => m.role !== 'system'));
    setMemories(await window.api.listMemory());
    setWiki(await window.api.listWiki());
    setMcpServers(s?.mcpServers ?? []);
    try { setFiles(await window.api.listFiles('.')); } catch { /* workspace may not exist yet */ }
  }
  async function refreshHistory() { const h = await window.api.getHistory(); setMsgs(h.filter((m: Msg) => m.role !== 'system')); }

  async function refreshTeam() {
    try { const t = await window.api.teamList(); if (t) setTeamData(t); } catch { /* team not ready */ }
  }
  async function refreshIdeEntries() {
    try {
      const list = await window.api.listUndo();
      setIdeEntries(list.map((u: any) => ({ id: u.id, name: u.relPath, time: u.createdAt, summary: u.preview || '改动' })));
    } catch { /* ignore */ }
  }
  async function refreshScheduler() { try { setSchedTasks(await window.api.schedulerList()); } catch { /* ignore */ } }
  async function refreshSkills() { try { setSkills(await window.api.skillsList()); } catch { /* ignore */ } }

  function switchTab(t: Tab) {
    setTab(t);
    if (t === 'team') void refreshTeam();
    if (t === 'ide') { void refreshIdeEntries(); }
    if (t === 'settings') { void refreshScheduler(); void refreshSkills(); }
    if (t === 'memory') { void refreshAll(); }
  }

  async function sendDirect(text: string) {
    const t = text.trim();
    if (!t || streaming) return;
    if (!settings?.apiKey && settings?.provider !== 'ollama') { setNotice('先在“设置”里填 API Key'); setTab('settings'); return; }
    setInput(''); setStreaming(true); setStreamText('');
    setMsgs((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: t }]);
    try { await window.api.sendChat(t); } catch (e) { setNotice(`发送失败：${(e as Error).message}`); setStreaming(false); }
  }
  async function send() { await sendDirect(input); }

  async function openFile(name: string) {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    try {
      if (DOC_EXTS.has(ext)) {
        const text = await window.api.callTool2('doc_read', { relPath: name });
        setPreview({ name, content: typeof text === 'string' ? text : JSON.stringify(text) });
      } else {
        const content = await window.api.readFile(name);
        setPreview({ name, content });
      }
    } catch (e) { setPreview({ name, content: `打不开：${(e as Error).message}` }); }
  }

  async function openIdeFile(name: string) {
    try {
      const content = await window.api.readFile(name);
      setIdeName(name); setIdeContent(content);
    } catch (e) { setNotice(`打不开 ${name}：${(e as Error).message}`); }
  }
  async function saveIdeFile(name: string, content: string) {
    try {
      await window.api.writeFile(name, content);
      setNotice(`已保存 ${name}（可撤回，见时间线）`);
      setFiles(await window.api.listFiles('.'));
      await refreshIdeEntries();
    } catch (e) { setNotice(`保存失败：${(e as Error).message}`); }
  }

  if (lock && lock.hasLock && !lock.unlocked) {
    return (
      <div className="app"><div className="lock">
        <h2>🔒 主人密码</h2>
        <p>输入密码解锁。未解锁时只能聊天，不能动你的文件和电脑。</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && window.api.lockUnlock(pw).then((ok) => ok ? refreshAll() : setNotice('密码不对'))}
          placeholder="输入主人密码" autoFocus />
        <button className="primary" onClick={() => window.api.lockUnlock(pw).then((ok) => ok ? refreshAll() : setNotice('密码不对'))}>解锁</button>
        {notice && <p>{notice}</p>}
      </div></div>
    );
  }

  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');

  return (
    <div className="app">
      <header>
        <h1>🌙 允允的数字伙伴</h1>
        <span style={{ fontSize: 12, color: '#8fa1b5' }}>{settings ? `${settings.provider} · ${settings.model}` : ''}{lock?.unlocked ? ' · 已解锁' : ''}</span>
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button key={t} onClick={() => switchTab(t)} style={tab === t ? { background: '#2f6fed' } : undefined}>
              {TAB_LABELS[t]}
            </button>
          ))}
          {lock?.hasLock && <button onClick={() => window.api.lockLock().then(refreshAll)}>锁定</button>}
        </nav>
      </header>

      {tab === 'chat' && (
        <div className="main">
          <div className="chat">
            {dueNotes.length > 0 && (
              <div style={{ background: '#3a2f10', padding: 8, borderRadius: 6, marginBottom: 8 }}>
                {dueNotes.map((d, i) => <div key={i}>⏰ {d.kind}：{d.title}{d.payload ? ` — ${d.payload}` : ''}</div>)}
                <button onClick={() => setDueNotes([])}>知道了</button>
              </div>
            )}
            <div className="messages">
              {msgs.map((m) => <div key={m.id} className={`msg ${m.role}`}>{m.content}</div>)}
              {streaming && <div className="msg assistant">{streamText || '想想…'}</div>}
              <div ref={bottomRef} />
            </div>
            <div className="hint">工具只能碰设置里的工作区；删 / 改 / 跑命令会先弹框问你。{!lock?.unlocked && lock?.hasLock ? '（当前未解锁：纯聊天，不调工具）' : ''}</div>
            <div className="composer">
              <input value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="跟她说句话…" disabled={streaming} />
              {streaming
                ? <button className="danger" onClick={() => window.api.stopChat()}>停止</button>
                : <button className="primary" onClick={send}>发送</button>}
              <button onClick={() => window.api.clearHistory().then(refreshHistory)}>清空记录</button>
            </div>
          </div>
          <div className="preview">
            <header><strong>预览台 — {preview.name || '未打开文件'}</strong>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8fa1b5' }}>工作区文件：{files.join(', ') || '（空）'}</span>
            </header>
            <div style={{ padding: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {files.map((f) => <button key={f} onClick={() => openFile(f)}>{f}</button>)}
              <button onClick={async () => setFiles(await window.api.listFiles('.'))}>刷新</button>
            </div>
            <PreviewPanel name={preview.name} content={preview.content} kind={preview.name ? detectKind(preview.name) : 'text'} />
            <p style={{ fontSize: 12, color: '#8fa1b5', padding: '0 8px' }}>PDF / Word / Excel / PPT 显示的是提取的文字，不是原版式。</p>
          </div>
        </div>
      )}

      {tab === 'ide' && (
        <div className="panel">
          <IdePanel
            files={files}
            onOpenFile={(n) => { void openIdeFile(n); }}
            onSave={(n, c) => { void saveIdeFile(n, c); }}
            initialContent={ideContent}
            initialName={ideName}
            entries={ideEntries}
            onRestore={async (id) => {
              try { await window.api.restoreUndo(id); setNotice('已撤回，可去 IDE 重新打开查看'); await refreshIdeEntries(); } catch (e) { setNotice(`撤回失败：${(e as Error).message}`); }
            }}
          />
          <p style={{ fontSize: 12, color: '#8fa1b5' }}>保存前会先看 Diff，确认才落盘；改动记在时间线里，48 小时内可见，7 天内可撤回。</p>
        </div>
      )}

      {tab === 'team' && (
        <div className="panel">
          <TeamPanel
            agents={(teamData?.agents ?? []).map((a: any) => ({ id: a.id, name: a.name, role: a.role, status: a.status, progress: a.progress ?? 0, currentTask: a.currentTask ?? null, filesTouched: a.filesTouched ?? [] }))}
            pending={(teamData?.pending ?? []).map((c: any) => ({ id: c.id, agent: c.agentName ?? c.agentId, summary: c.summary }))}
            onApprove={async (id) => { try { const r = await window.api.teamApprove(id); setNotice(`已批准并落地：${r}`); } catch (e) { setNotice(`批准失败：${(e as Error).message}`); } await refreshTeam(); }}
            onReject={async (id) => { await window.api.teamReject(id); await refreshTeam(); }}
            onDispatch={async (text) => { try { await window.api.teamDispatch(text); setNotice('已派给员工队'); } catch (e) { setNotice(`派发失败：${(e as Error).message}`); } await refreshTeam(); }}
          />
          <h3>招新员工（最多再加 20 位，每人最多 5 项技能）</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={caName} onChange={(e) => setCaName(e.target.value)} placeholder="名字" />
            <input value={caRole} onChange={(e) => setCaRole(e.target.value)} placeholder="岗位，比如：翻译" />
            <input value={caPersona} onChange={(e) => setCaPersona(e.target.value)} placeholder="人设 / 做法" />
            <input value={caSkills} onChange={(e) => setCaSkills(e.target.value)} placeholder="技能（逗号隔开，如 file_read,web_search）" />
            <button className="primary" onClick={async () => {
              if (!caName.trim()) { setNotice('先给新员工起个名字'); return; }
              const r = await window.api.teamCustomAdd({ name: caName.trim(), role: caRole.trim() || '助手', persona: caPersona.trim(), skills: caSkills.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 5) });
              if (!r?.ok) { setNotice(`招新失败：${r?.detail ?? '未知错误'}`); return; }
              setNotice(`已招到 ${caName.trim()}`); setCaName(''); setCaRole(''); setCaPersona(''); setCaSkills('');
              await refreshTeam();
            }}>招进来</button>
          </div>
          {(teamData?.customAgents ?? []).length > 0 && (
            <ul>{teamData.customAgents.map((a: any) => (
              <li key={a.id}>{a.name}（{a.role}）<button onClick={async () => { await window.api.teamCustomRemove(a.id); await refreshTeam(); }}>开除</button></li>
            ))}</ul>
          )}
          <p style={{ fontSize: 12, color: '#8fa1b5' }}>员工改文件要先过核对员和你的批准才落地；阿工默认不能自己跑命令。</p>
        </div>
      )}

      {tab === 'voice' && (
        <div className="panel">
          <VoicePanel
            onTranscript={(text) => { void sendDirect(text); }}
            speakText={lastAssistant?.content ?? ''}
            ttsEnabled={ttsEnabled}
            onToggleTts={() => setTtsEnabled((v) => !v)}
            elevenKey={settings?.elevenLabsKey ?? ''}
            onElevenKey={(k) => { if (settings) setSettings({ ...settings, elevenLabsKey: k }); }}
          />
          <p style={{ fontSize: 12, color: '#8fa1b5' }}>标准语音：点按说话，不是全双工——说话时打断不了她。ElevenLabs Key 填在上面，只存你电脑本地。</p>
        </div>
      )}

      {tab === 'browser' && (
        <div className="panel" style={{ height: '100%' }}>
          <BrowserPanel
            tabs={browserTabs}
            activeId={browserActive}
            onNavigate={(id, url) => { setBrowserTabs((ts) => ts.map((t) => t.id === id ? { ...t, url, title: url } : t)); }}
            onNewTab={() => { const id = newTabId(); setBrowserTabs((ts) => [...ts, { id, url: 'https://www.bing.com', title: '新标签页' }]); setBrowserActive(id); }}
            onCloseTab={(id) => {
              setBrowserTabs((ts) => {
                const next = ts.filter((t) => t.id !== id);
                if (next.length === 0) return [{ id: newTabId(), url: 'https://www.bing.com', title: '新标签页' }];
                if (browserActive === id) setBrowserActive(next[0].id);
                return next;
              });
            }}
          />
        </div>
      )}

      {tab === 'memory' && (
        <div className="panel">
          <h2>长期记忆（语义找回，本地 TF-IDF）</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={memText} onChange={(e) => setMemText(e.target.value)} placeholder="记一件事，比如：允允喜欢紫色键盘" />
            <button className="primary" onClick={async () => { if (!memText.trim()) return; await window.api.addMemory(memText, []); setMemText(''); setMemories(await window.api.listMemory()); }}>记下来</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input value={semQuery} onChange={(e) => setSemQuery(e.target.value)} placeholder="按意思找记忆，比如：她喜欢什么颜色" />
            <button onClick={async () => { if (!semQuery.trim()) return; setSemResults(await window.api.semanticRecall(semQuery)); }}>语义找找</button>
          </div>
          {semResults.length > 0 && (
            <ul>{semResults.map((r: any, i: number) => <li key={i}>{r.text} <span style={{ color: '#8fa1b5' }}>（{Math.round((r.score ?? 0) * 100)}%）</span></li>)}</ul>
          )}
          <ul>{memories.map((m) => <li key={m.id}>{m.text} <button onClick={async () => { await window.api.deleteMemory(m.id); setMemories(await window.api.listMemory()); }}>删</button></li>)}</ul>
          <h2>Wiki 笔记</h2>
          <button onClick={async () => { setWikiGraph(await window.api.wikiGraph()); }}>检查 Wiki（孤立 / 矛盾 / 过期）</button>
          {wikiGraph && (
            <div>
              <p>孤立页（没被引用）：{wikiGraph.orphans?.length ?? 0} — {(wikiGraph.orphans ?? []).join('、') || '无'}</p>
              <p>疑似矛盾（启发式，请人工核对）：{(wikiGraph.contradictions ?? []).join('；') || '无'}</p>
              <p>过期页（90 天没更新）：{(wikiGraph.stale ?? []).join('、') || '无'}</p>
            </div>
          )}
          <ul>{wiki.map((w) => <li key={w.id}><strong>{w.title}</strong><pre style={{ whiteSpace: 'pre-wrap' }}>{w.body.slice(0, 400)}</pre></li>)}</ul>
          {wiki.length === 0 && <p>还没有 Wiki 页。聊天里让她“把这件事记成 Wiki”就会出现。</p>}
        </div>
      )}

      {tab === 'soul' && (
        <div className="panel">
          <h2>灵魂 — 她的性格、称呼、说话方式</h2>
          <p>改完点保存，下次对话就生效。名字、性格都由你定。</p>
          <textarea value={soul} onChange={(e) => setSoul(e.target.value)} />
          <button className="primary" onClick={async () => { await window.api.saveSoul(soul); setNotice('灵魂已保存'); }}>保存灵魂</button>
          <h3>画像</h3>
          {profile && <>
            <label>名字</label><input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            <label>昵称</label><input value={profile.nickname} onChange={(e) => setProfile({ ...profile, nickname: e.target.value })} />
            <label>叫她</label><input value={profile.callMe} onChange={(e) => setProfile({ ...profile, callMe: e.target.value })} />
            <label>备注</label><input value={profile.notes} onChange={(e) => setProfile({ ...profile, notes: e.target.value })} />
            <button className="primary" onClick={async () => { await window.api.saveProfile(profile); setNotice('画像已保存'); }}>保存画像</button>
          </>}
          {notice && <p>{notice}</p>}
        </div>
      )}

      {tab === 'settings' && settings && (
        <div className="panel">
          <h2>设置</h2>
          <h3>自动更新</h3>
          <UpdateBanner
            status={updateStatus}
            onCheck={async () => { try { setUpdateStatus(await window.api.checkUpdate()); } catch (e) { setNotice(`检查更新失败：${(e as Error).message}`); } }}
            onDownload={async () => { try { setUpdateStatus(await window.api.downloadUpdate()); } catch (e) { setNotice(`下载失败：${(e as Error).message}`); } }}
            onInstall={async () => { try { await window.api.installUpdate(); } catch (e) { setNotice(`安装失败：${(e as Error).message}`); } }}
          />
          <p style={{ fontSize: 12, color: '#8fa1b5' }}>{UPDATE_DATA_NOTE}</p>
          <label>模型厂商</label>
          <select value={settings.provider} onChange={(e) => {
            const p = PROVIDERS.find((x) => x.id === e.target.value)!;
            setSettings({ ...settings, provider: p.id, baseUrl: p.baseUrl, model: p.model });
          }}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <label>接口地址 Base URL</label>
          <input value={settings.baseUrl} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} />
          <label>模型名</label>
          <input value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} />
          <button onClick={async () => { try { const m = await window.api.listModels(); setModels(m); setNotice(`找到 ${m.length} 个模型`); } catch (e) { setNotice(`获取失败：${(e as Error).message}`); } }}>获取模型列表</button>
          {models.length > 0 && <select onChange={(e) => setSettings({ ...settings, model: e.target.value })} value={settings.model}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>}
          <label>API Key（只存你电脑本地，不会上传、不会打进日志）</label>
          <input type="password" value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder="sk-…" />
          <label>ElevenLabs Key（语音合成用，不填就用系统语音，可空）</label>
          <input type="password" value={settings.elevenLabsKey ?? ''} onChange={(e) => setSettings({ ...settings, elevenLabsKey: e.target.value })} placeholder="sk-…（可选）" />
          <label>工作区（工具只能碰这里）</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={settings.workspace} readOnly />
            <button onClick={async () => { const w = await window.api.pickWorkspace(); if (w) setSettings({ ...settings, workspace: w }); }}>选择文件夹</button>
          </div>
          <div style={{ marginTop: 16 }}>
            <button className="primary" onClick={async () => { await window.api.saveSettings(settings); setNotice('设置已保存'); }}>保存设置</button>
          </div>
          <h3>主人密码</h3>
          <p>首次设置后，每次启动都要输入密码解锁才能用工具；不解锁只能聊天。</p>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="新密码（留空不改）" />
          <button onClick={async () => { if (!pw) return; await window.api.lockSet(pw); setPw(''); setNotice('主人密码已设置'); refreshAll(); }}>设置 / 修改密码</button>

          <h3>MCP 服务器（按需连接，用时连、做完断，不开机自连）</h3>
          <ul>{mcpServers.map((s: any, i: number) => (
            <li key={i}>{s.name}（{s.transport}{s.url ? ` · ${s.url}` : ''}{s.command ? ` · ${s.command} ${(s.args ?? []).join(' ')}` : ''}）
              <button onClick={async () => { try { const tools = await window.api.mcpListTools(s); setNotice(`${s.name} 有 ${tools.length} 个工具：${tools.map((t: any) => t.name).join('、')}`); } catch (e) { setNotice(`连不上 ${s.name}：${(e as Error).message}`); } }}>连一下看看</button>
              <button onClick={async () => { const next = mcpServers.filter((_, j) => j !== i); setMcpServers(next); await window.api.mcpSaveServers(next); }}>删</button>
            </li>
          ))}</ul>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="名字" />
            <select value={mcpTransport} onChange={(e) => setMcpTransport(e.target.value as 'stdio' | 'http')}>
              <option value="stdio">stdio（本地命令）</option>
              <option value="http">Streamable HTTP</option>
            </select>
            {mcpTransport === 'stdio'
              ? <input value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} placeholder="命令，比如 npx -y @modelcontextprotocol/server-filesystem" />
              : <input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="地址，比如 http://127.0.0.1:3000/mcp" />}
            <button onClick={async () => {
              if (!mcpName.trim()) { setNotice('先给 MCP 服务器起个名字'); return; }
              const srv: any = mcpTransport === 'stdio'
                ? { name: mcpName.trim(), transport: 'stdio', command: mcpCmd.trim().split(/\s+/)[0], args: mcpCmd.trim().split(/\s+/).slice(1) }
                : { name: mcpName.trim(), transport: 'http', url: mcpUrl.trim() };
              const next = [...mcpServers, srv];
              setMcpServers(next); await window.api.mcpSaveServers(next);
              setMcpName(''); setMcpCmd(''); setMcpUrl(''); setNotice(`已登记 ${srv.name}`);
            }}>登记</button>
          </div>

          <h3>技能（本地文件夹，贴 Git 地址安装）</h3>
          <ul>{skills.map((s: any) => (
            <li key={s.name}>{s.name}{s.untrusted ? '（来路不明，先别信）' : ''}{s.originUrl ? ` · ${s.originUrl}` : ''}
              <button onClick={async () => { try { const loaded = await window.api.skillsLoad(s.name); setNotice(`${s.name}：${loaded.prompt.slice(0, 200)}`); } catch (e) { setNotice(`读不到：${(e as Error).message}`); } }}>看看</button>
              <button onClick={async () => { await window.api.skillsRemove(s.name); await refreshSkills(); }}>删</button>
            </li>
          ))}</ul>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={skillUrl} onChange={(e) => setSkillUrl(e.target.value)} placeholder="Git 地址，比如 https://github.com/xxx/skill.git" />
            <button onClick={async () => {
              if (!skillUrl.trim()) return;
              const r = await window.api.skillsInstall(skillUrl.trim());
              setNotice(r?.ok ? `已安装技能：${r.name ?? skillUrl}` : `安装失败：${r?.detail ?? r?.error ?? '未知错误'}`);
              setSkillUrl(''); await refreshSkills();
            }}>安装技能</button>
          </div>

          <h3>定时任务（本地提醒，到点会弹出来）</h3>
          <ul>{schedTasks.map((t: any) => (
            <li key={t.id}>{t.title} — {t.schedule?.hour !== undefined ? `每天 ${t.schedule.hour}:${String(t.schedule.minute).padStart(2, '0')}` : `每 ${t.schedule?.intervalMinutes} 分钟`}（{t.enabled ? '开' : '关'}{t.missed ? `，错过 ${t.missed} 次` : ''}）
              <button onClick={async () => { await window.api.schedulerSetEnabled(t.id, !t.enabled); await refreshScheduler(); }}>{t.enabled ? '关掉' : '打开'}</button>
              <button onClick={async () => { await window.api.schedulerRemove(t.id); await refreshScheduler(); }}>删</button>
            </li>
          ))}</ul>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={schedTitle} onChange={(e) => setSchedTitle(e.target.value)} placeholder="提醒什么，比如：喝水" />
            <input type="number" value={schedHour} onChange={(e) => setSchedHour(Number(e.target.value))} style={{ width: 60 }} placeholder="时" />
            <span>:</span>
            <input type="number" value={schedMinute} onChange={(e) => setSchedMinute(Number(e.target.value))} style={{ width: 60 }} placeholder="分" />
            <input value={schedPayload} onChange={(e) => setSchedPayload(e.target.value)} placeholder="提醒内容（可空）" />
            <button onClick={async () => {
              if (!schedTitle.trim()) { setNotice('先写提醒标题'); return; }
              await window.api.schedulerAdd({ title: schedTitle.trim(), schedule: { hour: schedHour, minute: schedMinute }, action: 'remind', payload: schedPayload.trim() });
              setSchedTitle(''); setSchedPayload(''); await refreshScheduler();
            }}>加一个</button>
          </div>

          <h3>电脑体检</h3>
          <button onClick={async () => { try { setSysStatus(await window.api.getSystemStatus()); } catch (e) { setNotice(`查不到：${(e as Error).message}`); } }}>查一下</button>
          {sysStatus && (
            <p>CPU 负载 {sysStatus.cpuLoad ?? '?'} · 内存 {Math.round((sysStatus.freeMem ?? 0) / 1024 / 1024)}MB 可用 / {Math.round((sysStatus.totalMem ?? 0) / 1024 / 1024)}MB 总 · 磁盘 {(sysStatus.disks ?? []).map((d: any) => `${d.path ?? d.mount ?? ''} 剩 ${Math.round((d.free ?? 0) / 1024 / 1024 / 1024)}GB`).join('，')} · 进程 {(sysStatus.processes ?? []).length} 个</p>
          )}
          <h3>电脑操作（Windows 专属）</h3>
          <p style={{ fontSize: 12, color: '#8fa1b5' }}>在 Windows 上能认窗口、读控件、按控件名点和打字，做完会再读一遍核对。Linux 上会直接告诉你“仅支持 Windows”。聊天里让她操作电脑也会走这套。</p>
          {notice && <p>{notice}</p>}
        </div>
      )}

      {approval && (
        <div className="approval"><div>
          <h3>要不要让她动手？</h3>
          <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{approval.summary}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" onClick={() => { window.api.respondApproval(approval.id, true); setApproval(null); }}>允许</button>
            <button className="danger" onClick={() => { window.api.respondApproval(approval.id, false); setApproval(null); }}>拒绝</button>
          </div>
        </div></div>
      )}
    </div>
  );
}
