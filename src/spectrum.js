import { spawn } from 'child_process';
import { getBinaryPaths } from './installer.js';

// ponytail: a real spectrum (FFT), not an animation. ffmpeg -re decodes realtime (16kB/s),
// Node grabs the newest 16ms window → 12 log bands. No new deps, no new binaries.
export const SPEC_SR = 16000;
export const SPEC_N = 256;
export const SPEC_BARS = 12;
const NEED = SPEC_N * 2; // byte PCM s16le mono

// Radix-2 Cooley-Tukey, power-of-2 input length. Returns first-half magnitudes.
export function fftMag(samples) {
  const n = samples.length;
  const re = Float64Array.from(samples);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const t = re[i]; re[i] = re[j]; re[j] = t;
      const u = im[i]; im[i] = im[j]; im[j] = u;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2];
        const bi = im[i + k + len / 2];
        const vr = br * cwr - bi * cwi;
        const vi = br * cwi + bi * cwr;
        re[i + k] = ar + vr;
        im[i + k] = ai + vi;
        re[i + k + len / 2] = ar - vr;
        im[i + k + len / 2] = ai - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const mag = new Array(n / 2);
  for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / n;
  return mag;
}

export class SpectrumAnalyzer {
  constructor() {
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.smooth = null; // last frame (frozen while paused, null before any data)
    this.url = null;
    this.offset = 0;
    this._wantRun = false;
    this._lastData = 0;
    this._lastFrame = null;
    this._lastMove = 0;
    this._lastRefresh = 0;
  }

  start(url, offsetSec = 0) {
    this.stop();
    this.url = url;
    this.offset = offsetSec;
    this._wantRun = true;
    this._lastData = 0; // grace period until the first data arrives
    const { ffmpegPath } = getBinaryPaths();
    // -ss before -i: analysis decodes from the song position (in sync with mpv)
    const args = ['-re', '-nostats', '-loglevel', 'error'];
    if (offsetSec > 0) args.push('-ss', String(Math.floor(offsetSec)));
    args.push('-i', url, '-ac', '1', '-ar', String(SPEC_SR), '-f', 's16le', '-');
    this.proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc.stdout.on('data', (d) => {
      // always the newest 16ms window — no backlog, no lag
      this.buf = Buffer.concat([this.buf, d]);
      if (this.buf.length > NEED) this.buf = this.buf.subarray(this.buf.length - NEED);
      this._lastData = Date.now();
    });
    this.proc.on('error', () => {});
  }

  stop() {
    this._wantRun = false;
    if (this.proc) {
      try { this.proc.kill();       } catch { /* ignore */ }
      this.proc = null;
    }
  }

  // Returns twelve 0..1 values, or the last frame/null when no fresh data exists.
  levels() {
    // ponytail: watchdog — dead/stuck analysis (>3s without data) restarts itself
    if (this._wantRun && this._lastData > 0 && Date.now() - this._lastData > 3000) {
      this.start(this.url, this.offset);
      return this.smooth;
    }
    if (!this.proc || this.buf.length < NEED) return this.smooth;
    const s = new Float64Array(SPEC_N);
    for (let i = 0; i < SPEC_N; i++) {
      const v = this.buf.readInt16LE(i * 2) / 32768;
      s[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEC_N)); // Hann
    }
    const mag = fftMag(s);
    const nyq = SPEC_SR / 2;
    const fmin = 60;
    const bands = new Array(SPEC_BARS).fill(0);
    for (let b = 0; b < SPEC_BARS; b++) {
      const f0 = fmin * Math.pow(nyq / fmin, b / SPEC_BARS);
      const f1 = fmin * Math.pow(nyq / fmin, (b + 1) / SPEC_BARS);
      const k0 = Math.max(1, Math.floor((f0 * SPEC_N) / SPEC_SR));
      const k1 = Math.min(mag.length - 1, Math.ceil((f1 * SPEC_N) / SPEC_SR));
      let m = 0;
      for (let k = k0; k <= k1; k++) m = Math.max(m, mag[k]);
      bands[b] = m;
    }
    const peak = Math.max(...bands, 1e-9);
    const norm = bands.map((m) => Math.log10(1 + 9 * (m / peak))); // per-frame auto-gain: always lively
    this.smooth = !this.smooth ? norm : norm.map((v, i) => Math.max(v, this.smooth[i] * 0.9));

    // ponytail: stuck-but-alive — values unmoved for 1s while not silent = restart.
    // Silence is exempt (stillness is the correct display). 5s cooldown so network stalls don't spam.
    const prev = this._lastFrame;
    this._lastFrame = this.smooth;
    const now = Date.now();
    const moved = !prev || this.smooth.some((v, i) => Math.abs(v - prev[i]) > 0.02);
    if (moved) {
      this._lastMove = now;
    } else if (peak > 0.05 && now - this._lastMove > 1000 && now - this._lastRefresh > 5000) {
      this._lastRefresh = now;
      this.start(this.url, this.offset);
    }
    return this.smooth;
  }
}
