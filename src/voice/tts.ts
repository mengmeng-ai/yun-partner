// StreamingTts — sentence-chunked text-to-speech for full-duplex voice.
//
// The LLM reply streams in; this module splits it into sentences as they
// complete and speaks each one as soon as it is ready — it never waits
// for the full reply. Sentences queue in order; stop() cancels the queue,
// the in-flight ElevenLabs request, and any system speech immediately
// (this is what barge-in calls).
//
// ElevenLabs path: POST /v1/text-to-speech/{voice_id}/stream per sentence.
// System path: speechSynthesis per sentence. Which one is used depends on
// whether an ElevenLabs key is configured; the caller picks and reports it.

export const DEFAULT_ELEVEN_VOICE_ID = 'rwqMGOiqHoMg2K6ItclK';

/** Split off complete sentences from the tail of a buffer. Returns [sentences, remainder]. */
export function splitSentences(buffer: string): [string[], string] {
  const sentences: string[] = [];
  // A sentence ends at a Chinese or English terminal mark. English marks
  // need a following space / quote / end so "3.5" or "Dr." don't split.
  const re = /[^。！？!?；;]+(?:[。！？；;]+|(?:[.!?])(?=\s|["'”’）】」]|$))/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
    lastEnd = m.index + m[0].length;
  }
  return [sentences, buffer.slice(lastEnd)];
}

export type TtsEngine = 'elevenlabs' | 'system';

export interface StreamingTtsCallbacks {
  /** True while a sentence is actually audible. Drives the speaking state + VAD echo guard. */
  onSpeaking?: (speaking: boolean) => void;
  onError?: (message: string) => void;
}

export class StreamingTts {
  private queue: string[] = [];
  private running = false;
  private stopped = false;
  private fetchCtrl: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private engine: TtsEngine;

  constructor(
    private elevenKey: string,
    private voiceId: string,
    private cb: StreamingTtsCallbacks = {},
  ) {
    this.engine = elevenKey.trim() ? 'elevenlabs' : 'system';
  }

  getEngine(): TtsEngine { return this.engine; }

  /** Queue a sentence (or several). Playback starts if idle. */
  enqueue(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.queue.push(t);
    void this.pump();
  }

  /** Is anything queued or playing? */
  get busy(): boolean { return this.running || this.queue.length > 0; }

  /** Stop everything now: clear the queue, abort the fetch, stop the audio. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.fetchCtrl?.abort();
    this.fetchCtrl = null;
    if (this.audio) { this.audio.pause(); this.audio.src = ''; this.audio = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.running = false;
    this.cb.onSpeaking?.(false);
  }

  /** Resume after a stop() (a new reply starts). */
  reset(): void {
    this.stopped = false;
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    const sentence = this.queue.shift();
    if (!sentence) return;
    this.running = true;
    this.cb.onSpeaking?.(true);
    try {
      if (this.engine === 'elevenlabs') await this.speakEleven(sentence);
      else await this.speakSystem(sentence);
    } catch (err) {
      if (!this.stopped) this.cb.onError?.(`语音合成失败：${(err as Error).message}`);
    } finally {
      this.running = false;
      if (!this.stopped && this.queue.length > 0) void this.pump();
      else this.cb.onSpeaking?.(false);
    }
  }

  private async speakEleven(sentence: string): Promise<void> {
    const voiceId = (this.voiceId || DEFAULT_ELEVEN_VOICE_ID).trim();
    this.fetchCtrl = new AbortController();
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.elevenKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sentence,
          model_id: 'eleven_v4',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: this.fetchCtrl.signal,
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`ElevenLabs HTTP ${res.status}：${t.slice(0, 120)}`);
    }
    const buf = await res.arrayBuffer();
    if (this.stopped) return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    try {
      await this.playAudio(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private playAudio(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      this.audio = a;
      a.onended = () => { if (this.audio === a) this.audio = null; resolve(); };
      a.onerror = () => { if (this.audio === a) this.audio = null; reject(new Error('音频播放失败')); };
      a.play().catch((e: unknown) => reject(new Error(`音频播放失败：${(e as Error).message}`)));
    });
  }

  private speakSystem(sentence: string): Promise<void> {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(sentence);
      u.lang = 'zh-CN';
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }
}
