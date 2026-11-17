// TeamPanel — employee BOT team UI (Phase 3).
// Pure presentational component: every button calls a prop. It never talks
// to the main process directly; the coordinator wires the props to IPC.

import { useState } from 'react';

export interface TeamAgentCard {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'working' | 'waiting' | 'error';
  progress: number; // 0..100
  currentTask: string | null;
  filesTouched: string[];
}

export interface TeamPendingItem {
  id: string;
  agent: string;
  summary: string;
}

export interface TeamPanelProps {
  agents: TeamAgentCard[];
  pending: TeamPendingItem[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDispatch: (text: string) => void;
}

const STATUS_LABEL: Record<TeamAgentCard['status'], string> = {
  idle: '空闲',
  working: '工作中',
  waiting: '等待中',
  error: '出错',
};

export default function TeamPanel({ agents, pending, onApprove, onReject, onDispatch }: TeamPanelProps) {
  const [text, setText] = useState('');

  function dispatch() {
    const t = text.trim();
    if (!t) return;
    onDispatch(t);
    setText('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <h2>员工 BOT 团队</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && dispatch()}
            placeholder="派个任务给团队，比如：查一下豆包最新模型，写个总结"
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={dispatch}>派发</button>
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
        {agents.map((a) => (
          <div key={a.id} style={{ border: '1px solid #2a3648', borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{a.name}</strong>
              <span style={{ fontSize: 12, color: '#8fa1b5' }}>{STATUS_LABEL[a.status]}</span>
            </div>
            <div style={{ fontSize: 12, color: '#8fa1b5' }}>{a.role}</div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {a.currentTask ? a.currentTask : '没有进行中的任务'}
            </div>
            <div style={{ height: 6, background: '#223', borderRadius: 3, marginTop: 6, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(0, Math.min(100, a.progress))}%`, height: '100%', background: '#2f6fed' }} />
            </div>
            <div style={{ fontSize: 12, color: '#8fa1b5', marginTop: 4 }}>{a.progress}%</div>
            {a.filesTouched.length > 0 && (
              <div style={{ fontSize: 12, marginTop: 4 }}>改动文件：{a.filesTouched.join('、')}</div>
            )}
          </div>
        ))}
        {agents.length === 0 && <p>还没有员工。</p>}
      </section>

      <section>
        <h2>待审批的改动（未批准不会落地）</h2>
        {pending.length === 0 ? (
          <p>没有待审批的改动。</p>
        ) : (
          <ul>
            {pending.map((p) => (
              <li key={p.id} style={{ marginBottom: 8 }}>
                <strong>{p.agent}</strong>：{p.summary}
                <span style={{ display: 'inline-flex', gap: 6, marginLeft: 8 }}>
                  <button className="primary" onClick={() => onApprove(p.id)}>批准落地</button>
                  <button className="danger" onClick={() => onReject(p.id)}>驳回</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
