// EnergyVAD — real voice activity detection over live mic audio.
//
// How it works (no timer fakery): an AnalyserNode samples the mic signal
// every 50 ms and computes RMS energy. A noise floor is tracked as a slow
// exponential moving average of quiet frames, so the threshold adapts to
// the room. Speech starts when energy stays above the speech threshold
// for ~150 ms, and ends after ~900 ms of continuous below-threshold
// energy (hangover — pauses inside a sentence don't cut the turn off).
// Minimum speech length is 300 ms, so a cough or a click doesn't fire.
//
// Honest limit: this is an energy detector, not a neural VAD (no Silero
// ONNX model is bundled — that would need onnxruntime-web + model files
// shipped in the asar, which is a later upgrade). It cannot tell a human
// voice apart from other loud sounds; in a noisy room it will fire on
// noise. The barge-in threshold is deliberately higher while TTS is
// playing (see BARGE_IN_MULT), so speaker echo alone should not
// interrupt — but with loudspeakers and no headphones it can still
// misfire. Headphones are recommended in the UI.

export interface VadCallbacks {
  /** Energy level 0..1 for the mic meter. Called ~20x/second. */
  onLevel?: (level: number) => void;
  /** A speech segment started (user began talking). */
  onSpeechStart?: () => void;
  /** A speech segment ended after the silence hangover. */
  onSpeechEnd?: () => void;
}

export interface VadOptions {
  /** ms of continuous speech energy before onSpeechStart fires. Default 150. */
  startMs?: number;
  /** ms of continuous silence before onSpeechEnd fires. Default 900. */
  endMs?: number;
  /** Minimum speech length (ms) to count as a turn. Default 300. */
  minSpeechMs?: number;
  /** Multiplier over the noise floor for the speech threshold. Default 3.5. */
  speechMult?: number;
  /** While TTS is playing, the speech threshold is multiplied by this (echo guard). Default 6. */
  bargeInMult?: number;
}

const SAMPLE_MS = 50;

export class EnergyVAD {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private data: Uint8Array<ArrayBuffer>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private noiseFloor = 0.004;
  private speaking = false;
  private speechStartAt = 0;
  private aboveSince = 0;
  private belowSince = 0;
  private lastLevel = 0;
  private speakingWhileTts = false;

  constructor(
    stream: MediaStream,
    private cb: VadCallbacks = {},
    private opts: VadOptions = {},
  ) {
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.data = new Uint8Array(this.analyser.fftSize);
  }

  /** Call when TTS starts/stops so the echo guard can raise the threshold. */
  setTtsPlaying(playing: boolean): void {
    this.speakingWhileTts = playing;
  }

  start(): void {
    if (this.timer) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.timer = setInterval(() => this.tick(), SAMPLE_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.speaking) { this.speaking = false; this.cb.onSpeechEnd?.(); }
    void this.ctx.close().catch(() => { /* already closed */ });
  }

  private tick(): void {
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.data.length);
    // Normalised 0..1 level for the meter (log-ish scale, speech is ~0.02–0.3 RMS).
    const level = Math.min(1, Math.max(0, (Math.log10(rms + 1e-6) + 3) / 2));
    if (level !== this.lastLevel) { this.lastLevel = level; this.cb.onLevel?.(level); }

    // Track the noise floor only on quiet frames, slowly.
    const now = Date.now();
    const speechMult = this.opts.speechMult ?? 3.5;
    const mult = this.speakingWhileTts ? (this.opts.bargeInMult ?? 6) * speechMult : speechMult;
    const threshold = Math.max(this.noiseFloor * mult, 0.012);
    if (rms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
    }

    if (!this.speaking) {
      if (rms > threshold) {
        if (!this.aboveSince) this.aboveSince = now;
        if (now - this.aboveSince >= (this.opts.startMs ?? 150)) {
          this.speaking = true;
          this.speechStartAt = now;
          this.belowSince = 0;
          this.cb.onSpeechStart?.();
        }
      } else {
        this.aboveSince = 0;
      }
      return;
    }

    // Speaking: wait for sustained silence.
    if (rms > threshold * 0.6) {
      this.belowSince = 0;
    } else {
      if (!this.belowSince) this.belowSince = now;
      if (now - this.belowSince >= (this.opts.endMs ?? 900)) {
        const dur = now - this.speechStartAt;
        this.speaking = false;
        this.aboveSince = 0;
        this.belowSince = 0;
        if (dur >= (this.opts.minSpeechMs ?? 300)) this.cb.onSpeechEnd?.();
      }
    }
  }
}
