// VoicePanel — standard voice chat UI (Phase 3).
// Mode label, stated honestly: "标准语音（点按说话），全双工打断未实现".
// Speech recognition via the Web Speech API (SpeechRecognition /
// webkitSpeechRecognition); TTS via speechSynthesis. Both are browser APIs:
// in Electron they work when the Chromium engine exposes them, and this
// component shows a clear fallback state when it does not.
// ElevenLabs: an optional key field only. The key is stored via the prop
// callback; actual ElevenLabs synthesis is NOT wired here — until the
// coordinator wires it, reading aloud still uses the system voice, and the
// UI says so. Nothing is faked.

import { useEffect, useRef, useState } from 'react';

export interface VoicePanelProps {
  onTranscript: (text: string) => void;
  speakText: string;
  ttsEnabled: boolean;
  onToggleTts: () => void;
  elevenKey: string;
  onElevenKey: (k: string) => void;
}

// Minimal Web Speech API shapes (not in the TS DOM lib).
interface SpeechRecognitionResultItemLike {
  transcript: string;
  isFinal: boolean;
}
interface SpeechRecognitionResultLike {
  length: number;
  [index: number]: SpeechRecognitionResultItemLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export default function VoicePanel({
  onTranscript,
  speakText,
  ttsEnabled,
  onToggleTts,
  elevenKey,
  onElevenKey,
}: VoicePanelProps) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [lastHeard, setLastHeard] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = getRecognitionCtor() !== null;

  function speak(text: string) {
    if (!text.trim()) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    window.speechSynthesis.speak(u);
  }

  // Read the assistant's latest reply aloud when TTS is on.
  useEffect(() => {
    if (ttsEnabled && speakText.trim()) speak(speakText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakText, ttsEnabled]);

  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('浏览器不支持语音识别');
      return;
    }
    setError('');
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let finalText = '';
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        for (let j = 0; j < res.length; j++) {
          const alt = res[j];
          if (alt.isFinal) finalText += alt.transcript;
          else interimText += alt.transcript;
        }
      }
      setInterim(interimText);
      if (finalText.trim()) {
        setLastHeard(finalText.trim());
        setInterim('');
        onTranscript(finalText.trim());
      }
    };
    rec.onerror = (e) => {
      setError(`语音识别出错：${e.error}`);
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError('语音识别启动失败');
      setListening(false);
    }
  }

  function stopListening() {
    try {
      recRef.current?.stop();
    } catch {
      // already stopped
    }
    setListening(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2>语音</h2>
      <p style={{ fontSize: 13, color: '#8fa1b5', margin: 0 }}>
        标准语音（点按说话），全双工打断未实现。
      </p>

      {!supported ? (
        <p>浏览器不支持语音识别</p>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {listening ? (
            <button className="danger" onClick={stopListening}>■ 停止说话</button>
          ) : (
            <button className="primary" onClick={startListening}>🎤 点按说话</button>
          )}
          <span style={{ fontSize: 13 }}>{listening ? '正在听…' : '点一下开始说话'}</span>
        </div>
      )}
      {error && <p style={{ color: '#e5484d' }}>{error}</p>}
      {interim && <p style={{ color: '#8fa1b5' }}>{interim}</p>}
      {lastHeard && <p>刚才听到：{lastHeard}</p>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label>
          <input type="checkbox" checked={ttsEnabled} onChange={onToggleTts} /> 朗读回复（系统语音）
        </label>
        <button onClick={() => speak(speakText)} disabled={!speakText.trim()}>朗读最新回复</button>
      </div>

      <div>
        <label>ElevenLabs Key（可选，默认关闭）</label>
        <input
          type="password"
          value={elevenKey}
          onChange={(e) => onElevenKey(e.target.value)}
          placeholder="sk-…（留空不用）"
        />
        <p style={{ fontSize: 12, color: '#8fa1b5' }}>
          {elevenKey
            ? 'Key 已填写，但 ElevenLabs 语音尚未接线：当前朗读仍用系统语音。'
            : '不填 Key 就只用系统语音。Key 只存你电脑本地，不会上传。'}
        </p>
      </div>
    </div>
  );
}
