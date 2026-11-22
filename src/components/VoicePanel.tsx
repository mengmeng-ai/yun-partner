// VoicePanel — push-to-talk (as before) + full-duplex voice (v0.3.0).
//
// Full-duplex loop, OFF by default, only in this tab:
//   mic → EnergyVAD (adaptive energy detector, see voice/vad.ts)
//     → STT: Web Speech continuous when the engine exists, otherwise
//       VAD-segmented recording → Whisper (main process, /audio/transcriptions)
//     → transcript goes into the existing chat loop as a user message
//     → LLM reply streams in via the streamText prop, sentence by sentence
//     → StreamingTts speaks each sentence as soon as it completes
//       (ElevenLabs when a key is set, system voice otherwise)
//     → VAD hears the user mid-reply → barge-in: TTS stops at once, the
//       in-flight LLM stream is cancelled, and the new turn starts.
//
// Honest limits (also in README): Web Speech recognition is usually NOT
// available inside Electron on Windows, so the Whisper path is the one
// that normally works — it needs a Whisper key in Settings. Energy VAD
// cannot tell a voice from other loud sounds. Echo: getUserMedia runs
// with echoCancellation + a higher barge-in threshold while TTS plays,
// but with loudspeakers the mic can still hear her own voice — use
// headphones. Barge-in on the Whisper path may clip the first syllable
// or two (recording only starts once speech is detected); the Web Speech
// path does not clip because recognition is continuous.

import { useEffect, useRef, useState } from 'react';
import { EnergyVAD } from '../voice/vad';
import { StreamingTts, splitSentences, DEFAULT_ELEVEN_VOICE_ID } from '../voice/tts';

export interface VoicePanelProps {
  onTranscript: (text: string) => void;
  speakText: string;
  ttsEnabled: boolean;
  onToggleTts: () => void;
  elevenKey: string;
  onElevenKey: (k: string) => void;
  elevenVoiceId: string;
  onElevenVoiceId: (id: string) => void;
  whisperKey: string;
  /** Live accumulated LLM reply text (App's streamText). Drives streaming TTS. */
  streamText: string;
  /** True while the LLM is still streaming a reply. */
  isStreaming: boolean;
  /** Send a voice turn; barge-in aware (stops the current reply first). */
  onVoiceSend: (text: string) => void;
  /** Cancel the in-flight LLM stream without sending anything. */
  onStopChat: () => void;
}

// Minimal Web Speech API shapes (not in the TS DOM lib).
interface SpeechRecognitionResultItemLike { transcript: string; isFinal: boolean }
interface SpeechRecognitionResultLike { length: number; [index: number]: SpeechRecognitionResultItemLike }
interface SpeechRecognitionEventLike { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }
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

type DuplexState = 'off' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted';
type SttMode = 'auto' | 'webspeech' | 'whisper';

const STATE_LABEL: Record<DuplexState, string> = {
  off: '全双工已关',
  idle: '在听，等你开口…',
  listening: '听到你在说话…',
  thinking: '她在想…',
  speaking: '她在说话（你开口就能打断）',
  muted: '已静音（听不到你）',
};

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('读取录音失败'));
    r.readAsDataURL(blob);
  });
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export default function VoicePanel({
  onTranscript,
  speakText,
  ttsEnabled,
  onToggleTts,
  elevenKey,
  onElevenKey,
  elevenVoiceId,
  onElevenVoiceId,
  whisperKey,
  streamText,
  isStreaming,
  onVoiceSend,
  onStopChat,
}: VoicePanelProps) {
  // --- push-to-talk (unchanged behaviour) ---
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [lastHeard, setLastHeard] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = getRecognitionCtor() !== null;

  // --- full-duplex ---
  const [duplex, setDuplex] = useState(false);
  const [duplexState, setDuplexState] = useState<DuplexState>('off');
  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [sttMode, setSttMode] = useState<SttMode>('auto');
  const [activeEngine, setActiveEngine] = useState<'webspeech' | 'whisper' | 'none'>('none');
  const [transcribing, setTranscribing] = useState(false);
  const [duplexError, setDuplexError] = useState('');

  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<EnergyVAD | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recActiveRef = useRef(false);
  const duplexRecRef = useRef<SpeechRecognitionLike | null>(null);
  const recErrorsRef = useRef(0);
  const ttsRef = useRef<StreamingTts | null>(null);
  const ttsBufferRef = useRef('');
  const consumedRef = useRef(0);
  const ttsSpeakingRef = useRef(false);

  // Refs mirroring state for use inside VAD / recognition callbacks.
  const duplexRef = useRef(false);
  const mutedRef = useRef(false);
  const stateRef = useRef<DuplexState>('off');
  const streamingRef = useRef(false);
  const ttsEnabledRef = useRef(ttsEnabled);
  duplexRef.current = duplex;
  mutedRef.current = muted;
  streamingRef.current = isStreaming;
  ttsEnabledRef.current = ttsEnabled;
  const setState = (s: DuplexState) => { stateRef.current = s; setDuplexState(s); };

  function getTts(): StreamingTts {
    if (!ttsRef.current) {
      ttsRef.current = new StreamingTts(elevenKey, elevenVoiceId || DEFAULT_ELEVEN_VOICE_ID, {
        onSpeaking: (speaking) => {
          ttsSpeakingRef.current = speaking;
          vadRef.current?.setTtsPlaying(speaking);
          if (speaking) setState('speaking');
          else if (stateRef.current === 'speaking') setState(streamingRef.current ? 'thinking' : 'idle');
        },
        onError: (m) => setDuplexError(m),
      });
    }
    return ttsRef.current;
  }

  // Key / voice changed: rebuild the TTS engine next time it is used.
  useEffect(() => {
    ttsRef.current?.stop();
    ttsRef.current = null;
  }, [elevenKey, elevenVoiceId]);

  // --- streaming TTS consumption: feed LLM deltas into the sentence queue ---
  useEffect(() => {
    if (!duplexRef.current) return;
    if (streamText.length < consumedRef.current) {
      // New turn started (App cleared streamText): reset the consumer.
      consumedRef.current = 0;
      ttsBufferRef.current = '';
      getTts().reset();
    }
    const chunk = streamText.slice(consumedRef.current);
    consumedRef.current = streamText.length;
    if (chunk) {
      ttsBufferRef.current += chunk;
      const [sentences, rest] = splitSentences(ttsBufferRef.current);
      ttsBufferRef.current = rest;
      if (sentences.length > 0) {
        if (ttsEnabledRef.current) {
          const tts = getTts();
          tts.reset();
          for (const s of sentences) tts.enqueue(s);
          setState('speaking');
        } else {
          setState('thinking');
        }
      } else if (streamText.length > 0) {
        setState('thinking');
      }
    }
    if (!isStreaming && ttsBufferRef.current.trim()) {
      const tail = ttsBufferRef.current.trim();
      ttsBufferRef.current = '';
      if (ttsEnabledRef.current) {
        const tts = getTts();
        tts.reset();
        tts.enqueue(tail);
      }
      if (stateRef.current === 'thinking') setState('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamText, isStreaming]);

  function speak(text: string) {
    if (!text.trim()) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    window.speechSynthesis.speak(u);
  }

  // Read the assistant's latest reply aloud when TTS is on (push-to-talk mode).
  useEffect(() => {
    if (!duplex && ttsEnabled && speakText.trim()) speak(speakText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakText, ttsEnabled, duplex]);

  // --- shared transcript handling ---
  function handleFinalTranscript(text: string) {
    const t = text.trim();
    if (!t || mutedRef.current) return;
    setLastHeard(t);
    setInterim('');
    if (duplexRef.current) {
      if (ttsSpeakingRef.current || streamingRef.current) interrupt();
      setState('thinking');
      onVoiceSend(t);
    } else {
      onTranscript(t);
    }
  }

  /** Barge-in: stop TTS + cancel the LLM stream, then listen. */
  function interrupt() {
    getTts().stop();
    ttsBufferRef.current = '';
    consumedRef.current = streamText.length;
    onStopChat();
    setState('listening');
  }

  // --- Whisper segmented recording ---
  function startSegment() {
    const stream = streamRef.current;
    if (!stream || recActiveRef.current || mutedRef.current) return;
    const mimeType = pickMimeType();
    try {
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) recChunksRef.current.push(e.data); };
      rec.onstop = () => {
        recActiveRef.current = false;
        const blob = new Blob(recChunksRef.current, { type: mimeType || 'audio/webm' });
        recChunksRef.current = [];
        if (blob.size < 1000) return; // too short to be speech
        void transcribeSegment(blob);
      };
      rec.start(250);
      recActiveRef.current = true;
      recorderRef.current = rec;
    } catch {
      setDuplexError('录音启动失败：浏览器不支持 MediaRecorder');
    }
  }

  function stopSegment() {
    if (recActiveRef.current && recorderRef.current?.state !== 'inactive') {
      try { recorderRef.current?.stop(); } catch { recActiveRef.current = false; }
    }
  }

  async function transcribeSegment(blob: Blob) {
    if (mutedRef.current) return;
    setTranscribing(true);
    try {
      const b64 = await blobToB64(blob);
      const { text } = await window.api.transcribeVoice(b64, blob.type || 'audio/webm');
      if (text) handleFinalTranscript(text);
    } catch (e) {
      setDuplexError(`语音识别失败：${(e as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  }

  // --- Web Speech continuous recognition (duplex mode) ---
  function startDuplexRecognition() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
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
      if (interimText) setInterim(interimText);
      if (finalText.trim()) {
        setInterim('');
        handleFinalTranscript(finalText.trim());
      }
    };
    rec.onerror = (e) => {
      recErrorsRef.current += 1;
      if (recErrorsRef.current >= 3) {
        setDuplexError(`网页语音识别反复出错（${e.error}），已自动切到 Whisper（需要在设置里填 Whisper Key）或检查网络`);
        return;
      }
      // 'no-speech' / 'aborted' are routine; restart is handled by onend.
      if (e.error !== 'no-speech' && e.error !== 'aborted') setDuplexError(`语音识别出错：${e.error}`);
    };
    rec.onend = () => {
      duplexRecRef.current = null;
      // Continuous recognition stops on its own sometimes — restart while duplex is on.
      if (duplexRef.current && !mutedRef.current && recErrorsRef.current < 3) {
        window.setTimeout(() => {
          if (duplexRef.current && !mutedRef.current && !duplexRecRef.current) startDuplexRecognition();
        }, 300);
      }
    };
    duplexRecRef.current = rec;
    try { rec.start(); } catch { /* already started */ }
  }

  function stopDuplexRecognition() {
    try { duplexRecRef.current?.stop(); } catch { /* already stopped */ }
    duplexRecRef.current = null;
  }

  // --- full-duplex lifecycle ---
  async function startDuplex() {
    setDuplexError('');
    setError('');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      setDuplexError(`打不开麦克风：${(e as Error).message}。请在系统设置里允许这个应用用麦克风。`);
      return;
    }
    streamRef.current = stream;
    duplexRef.current = true;
    setDuplex(true);
    setState('idle');

    // Pick the STT engine: explicit choice wins; auto prefers Web Speech
    // when it exists (rare in Electron), otherwise Whisper.
    const useWebSpeech = sttMode === 'webspeech' || (sttMode === 'auto' && supported);
    const useWhisper = !useWebSpeech && (sttMode === 'whisper' || sttMode === 'auto');
    if (useWebSpeech && !supported) {
      setDuplexError('这台电脑没有网页语音识别，已切到 Whisper（需要在设置里填 Whisper Key）');
    }
    if (useWhisper && !whisperKey.trim()) {
      setDuplexError('Whisper 需要 Key：去“设置”里填 Whisper Key（或把模型厂商切到 OpenAI 并填 Key），否则只能等网页语音识别。');
    }
    setActiveEngine(useWebSpeech ? 'webspeech' : useWhisper ? 'whisper' : 'none');
    if (useWebSpeech) startDuplexRecognition();

    const vad = new EnergyVAD(stream, {
      onLevel: (level) => setMicLevel(level),
      onSpeechStart: () => {
        if (mutedRef.current) return;
        if (ttsSpeakingRef.current || streamingRef.current) {
          // Barge-in: cut her off, then capture the rest of this turn
          // (Whisper path: start recording now — the first syllable or
          // two of the interruption may be clipped, see header note).
          interrupt();
          if (!useWebSpeech) startSegment();
          return;
        }
        setState('listening');
        if (!useWebSpeech) startSegment();
      },
      onSpeechEnd: () => {
        if (mutedRef.current) return;
        if (!useWebSpeech) stopSegment();
        if (stateRef.current === 'listening') setState('idle');
      },
    });
    vadRef.current = vad;
    vad.start();
  }

  function stopDuplex() {
    duplexRef.current = false;
    setDuplex(false);
    setState('off');
    setActiveEngine('none');
    setMicLevel(0);
    setInterim('');
    stopDuplexRecognition();
    stopSegment();
    vadRef.current?.stop();
    vadRef.current = null;
    getTts().stop();
    ttsBufferRef.current = '';
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // Tear everything down when the panel unmounts (tab switch / close).
  useEffect(() => () => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    stopDuplexRecognition();
    vadRef.current?.stop();
    getTts().stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (next) {
      stopSegment();
      setState('muted');
    } else {
      setState('idle');
    }
  }

  // --- push-to-talk (unchanged) ---
  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) { setError('浏览器不支持语音识别'); return; }
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
    rec.onerror = (e) => { setError(`语音识别出错：${e.error}`); setListening(false); };
    rec.onend = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch { setError('语音识别启动失败'); setListening(false); }
  }

  function stopListening() {
    try { recRef.current?.stop(); } catch { /* already stopped */ }
    setListening(false);
  }

  const ttsEngineLabel = elevenKey.trim() ? 'ElevenLabs' : '系统语音';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2>语音</h2>

      {/* ---------- full-duplex ---------- */}
      <div style={{ border: '1px solid #2a3a4d', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>全双工语音</strong>
          <span style={{ fontSize: 12, color: duplex ? '#7ee2a8' : '#8fa1b5' }}>
            {duplex ? '已开启' : '已关闭（默认）'}
          </span>
          {duplex ? (
            <button className="danger" onClick={stopDuplex}>■ 关闭全双工</button>
          ) : (
            <button className="primary" onClick={() => { void startDuplex(); }}>🎤 开启全双工</button>
          )}
          {duplex && (
            <button onClick={toggleMute}>{muted ? '🔇 已静音，点一下恢复' : '🔊 静音'}</button>
          )}
          {duplex && duplexState === 'speaking' && (
            <button onClick={interrupt}>打断她</button>
          )}
        </div>

        <p style={{ fontSize: 13, color: '#8fa1b5', margin: 0 }}>
          开着就能一直聊：你说话她就回，她说话时你开口就能打断。麦克风只在你开着全双工的时候用，关掉就停。
          建议戴耳机——用扬声器时，她自己的声音可能被麦克风收到。
        </p>

        {duplex && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, minWidth: 200 }}>● {STATE_LABEL[duplexState]}{transcribing ? '（识别中…）' : ''}</span>
              <div style={{ flex: 1, height: 8, background: '#1a2634', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${Math.round(micLevel * 100)}%`, height: '100%', background: duplexState === 'speaking' ? '#e5484d' : '#2f6fed', transition: 'width 80ms linear' }} />
              </div>
              <span style={{ fontSize: 12, color: '#8fa1b5' }}>麦克风音量</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13 }}>
                识别方式
                <select value={sttMode} onChange={(e) => setSttMode(e.target.value as SttMode)} style={{ marginLeft: 6 }}>
                  <option value="auto">自动</option>
                  <option value="webspeech">网页语音</option>
                  <option value="whisper">Whisper</option>
                </select>
              </label>
              <span style={{ fontSize: 12, color: '#8fa1b5' }}>
                当前：{activeEngine === 'webspeech' ? '网页语音（连续识别）' : activeEngine === 'whisper' ? 'Whisper（按句话分段识别）' : '未就绪'}
                {' · '}朗读：{ttsEngineLabel}
                {activeEngine === 'webspeech' ? ' · Electron 里网页语音通常不可用，不行就切 Whisper' : ''}
              </span>
            </div>
            {interim && <p style={{ color: '#8fa1b5', margin: 0 }}>听到一半：{interim}</p>}
            {lastHeard && <p style={{ margin: 0 }}>刚才听到：{lastHeard}</p>}
            {duplexError && <p style={{ color: '#e5484d', margin: 0 }}>{duplexError}</p>}
          </>
        )}
      </div>

      {/* ---------- push-to-talk (unchanged) ---------- */}
      <p style={{ fontSize: 13, color: '#8fa1b5', margin: 0 }}>
        点按说话（全双工关着的时候用）。
      </p>
      {!supported ? (
        <p>浏览器不支持语音识别</p>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {listening ? (
            <button className="danger" onClick={stopListening}>■ 停止说话</button>
          ) : (
            <button className="primary" onClick={startListening} disabled={duplex}>🎤 点按说话</button>
          )}
          <span style={{ fontSize: 13 }}>{listening ? '正在听…' : '点一下开始说话'}</span>
        </div>
      )}
      {error && <p style={{ color: '#e5484d' }}>{error}</p>}
      {!duplex && interim && <p style={{ color: '#8fa1b5' }}>{interim}</p>}
      {!duplex && lastHeard && <p>刚才听到：{lastHeard}</p>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label>
          <input type="checkbox" checked={ttsEnabled} onChange={onToggleTts} /> 朗读回复（{ttsEngineLabel}）
        </label>
        <button onClick={() => speak(speakText)} disabled={!speakText.trim()}>朗读最新回复</button>
      </div>

      <div>
        <label>ElevenLabs Key（可选，填了全双工就用 ElevenLabs 朗读）</label>
        <input
          type="password"
          value={elevenKey}
          onChange={(e) => onElevenKey(e.target.value)}
          placeholder="sk-…（留空用系统语音）"
        />
        <label>ElevenLabs 音色 ID（可空，默认用她定的那个）</label>
        <input
          value={elevenVoiceId}
          onChange={(e) => onElevenVoiceId(e.target.value)}
          placeholder={DEFAULT_ELEVEN_VOICE_ID}
        />
        <p style={{ fontSize: 12, color: '#8fa1b5' }}>
          {elevenKey
            ? 'Key 已填：全双工朗读走 ElevenLabs（按句流式，还没说完就开始念）。'
            : '不填 Key 就只用系统语音。Key 只存你电脑本地，不会上传。'}
          {!whisperKey.trim() && ' Whisper 没填 Key 时，全双工识别只能靠网页语音——Electron 里它通常不可用，记得去设置里填 Whisper Key。'}
        </p>
      </div>
    </div>
  );
}
