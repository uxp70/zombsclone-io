// Procedural WebAudio SFX — no assets needed
export class SoundFX {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* noop */ }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  tone(freq, dur, type = 'square', vol = 0.15, slide = 0) {
    if (!this.enabled) return;
    const ctx = this.ensure(); if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + dur);
  }
  noise(dur = 0.12, vol = 0.2, low = 400) {
    if (!this.enabled) return;
    const ctx = this.ensure(); if (!ctx) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = low;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(ctx.destination); src.start();
  }
  shoot(kind) {
    if (kind === 'shotgun') { this.noise(0.22, 0.5, 900); this.tone(120, 0.18, 'sawtooth', 0.25, -60); }
    else if (kind === 'sniper') { this.noise(0.3, 0.4, 2000); this.tone(300, 0.25, 'sawtooth', 0.2, -220); }
    else if (kind === 'smg' || kind === 'lmg') { this.noise(0.07, 0.25, 1400); this.tone(220, 0.06, 'square', 0.12, -40); }
    else if (kind === 'ar' || kind === 'burst') { this.noise(0.1, 0.3, 1200); this.tone(180, 0.09, 'sawtooth', 0.16, -60); }
    else { this.noise(0.08, 0.25, 1000); this.tone(200, 0.07, 'square', 0.13, -50); }
  }
  hit() { this.tone(700, 0.06, 'square', 0.1, 200); }
  hurt() { this.tone(160, 0.15, 'sawtooth', 0.2, -60); }
  pickup() { this.tone(520, 0.07, 'sine', 0.18, 260); }
  heal() { this.tone(440, 0.3, 'sine', 0.15, 220); }
  reload() { this.tone(300, 0.08, 'square', 0.1); setTimeout(() => this.tone(420, 0.08, 'square', 0.1), 120); }
  chest() { this.noise(0.15, 0.3, 700); this.tone(180, 0.15, 'triangle', 0.2, 80); }
  gas() { this.tone(90, 0.4, 'sawtooth', 0.08, -20); }
  win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, 'triangle', 0.2), i * 140)); }
  fanfare() { [659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'triangle', 0.18), i * 90)); }
  boom() { this.noise(0.4, 0.5, 500); this.tone(90, 0.4, 'sawtooth', 0.3, -50); }
  death() { this.tone(300, 0.5, 'sawtooth', 0.2, -240); }
  ui() { this.tone(600, 0.05, 'sine', 0.12); }
}
export const sfx = new SoundFX();
