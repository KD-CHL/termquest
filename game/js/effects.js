// 音效 + 彩带特效
// sfx(name) 统一音效注册表：文件操作 / 进程 / 管道 / Docker / SSH / UI 事件
import { app } from './state.js';

let AC = null;
function ctx() {
  AC = AC || new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}

function beep(freq, dur, type, vol) {
  if (!app.soundOn) return;
  try {
    const ac = ctx();
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || .08, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + dur);
  } catch (e) { /* 忽略音频错误 */ }
}

// 带延迟的音（用于序列音效）
function tone(freq, dur, type, vol, delay) {
  if (!app.soundOn) return;
  try {
    const ac = ctx(), t0 = ac.currentTime + (delay || 0);
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || .06, t0);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + dur);
  } catch (e) {}
}

// 滑音（频率扫描）
function sweep(f0, f1, dur, type, vol, delay) {
  if (!app.soundOn) return;
  try {
    const ac = ctx(), t0 = ac.currentTime + (delay || 0);
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(vol || .06, t0);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + dur);
  } catch (e) {}
}

// 噪声缓冲（打击乐 / 气流声）
let noiseBuf = null;
function noise(dur, vol, filterFreq, delay) {
  if (!app.soundOn) return;
  try {
    const ac = ctx(), t0 = ac.currentTime + (delay || 0);
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = filterFreq || 3000; f.Q.value = 1.2;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol || .05, t0);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(ac.destination);
    src.start(t0); src.stop(t0 + dur);
  } catch (e) {}
}

/* ============ 基础音效（保持兼容） ============ */
export function sfxClick() { beep(600, .06, 'square', .03); }
export function sfxOk() { beep(520, .09, 'sine', .06); setTimeout(() => beep(780, .12, 'sine', .06), 90); }
export function sfxErr() { beep(180, .18, 'sawtooth', .05); }
export function sfxWin() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, .16, 'triangle', .07), i * 110)); }

/* ============ 扩展音效注册表 ============ */
const SFX = {
  // --- 文件操作 ---
  'file-create':  () => { tone(880, .05, 'sine', .05); tone(1320, .07, 'sine', .04, .05); noise(.04, .02, 6000); },
  'file-delete':  () => { sweep(600, 150, .14, 'sawtooth', .04); noise(.08, .03, 1200, .03); },
  'file-copy':    () => { tone(660, .05, 'triangle', .05); tone(660, .05, 'triangle', .04, .08); tone(990, .06, 'triangle', .04, .16); },
  'file-move':    () => { sweep(400, 900, .1, 'triangle', .05); tone(900, .05, 'sine', .03, .1); },
  'file-chmod':   () => { tone(500, .04, 'square', .03); tone(630, .04, 'square', .03, .06); tone(800, .05, 'square', .03, .12); },
  'file-write':   () => { noise(.03, .025, 5000); tone(1200, .03, 'sine', .02, .02); },

  // --- 进程 ---
  'proc-spawn':   () => { sweep(200, 700, .12, 'sine', .05); tone(700, .06, 'sine', .04, .12); },
  'proc-kill':    () => { sweep(700, 120, .2, 'sawtooth', .05); noise(.1, .03, 800, .08); },
  'proc-fork':    () => { tone(440, .06, 'triangle', .05); tone(550, .06, 'triangle', .05, .07); tone(660, .08, 'triangle', .04, .14); },

  // --- 管道 / 文本 ---
  'pipe-whoosh':  () => { noise(.18, .04, 2500); sweep(300, 1200, .15, 'sine', .03); },
  'pipe-tick':    () => { tone(1400, .025, 'square', .025); },
  'text-grep':    () => { tone(1000, .03, 'square', .03); tone(1000, .03, 'square', .025, .06); tone(1500, .05, 'square', .03, .12); },

  // --- Docker ---
  'docker-start': () => { sweep(120, 600, .35, 'sawtooth', .04); tone(600, .1, 'sine', .04, .35); noise(.15, .02, 400, .1); },
  'docker-stop':  () => { sweep(600, 100, .3, 'sawtooth', .04); noise(.1, .02, 600, .15); },
  'docker-build': () => { for (let i = 0; i < 5; i++) tone(300 + i * 80, .05, 'square', .025, i * .09); tone(1200, .1, 'sine', .05, .5); },
  'docker-image': () => { tone(784, .08, 'sine', .05); tone(1175, .12, 'sine', .05, .09); },
  'docker-pull':  () => { for (let i = 0; i < 4; i++) { noise(.06, .03, 2000 + i * 500, i * .12); } tone(880, .08, 'sine', .04, .5); },

  // --- SSH / 网络 ---
  'ssh-handshake': () => { tone(520, .07, 'sine', .05); tone(780, .07, 'sine', .05, .1); tone(1040, .1, 'sine', .05, .2); },
  'ssh-transfer':  () => { for (let i = 0; i < 6; i++) tone(900 + (i % 3) * 200, .035, 'square', .025, i * .07); },
  'net-connect':   () => { sweep(300, 900, .15, 'sine', .04); tone(900, .08, 'sine', .04, .15); },
  'net-error':     () => { tone(300, .1, 'sawtooth', .04); tone(250, .12, 'sawtooth', .04, .12); },

  // --- UI 事件 ---
  'ui-tab':        () => { tone(700, .04, 'sine', .035); tone(900, .05, 'sine', .03, .04); },
  'ui-unlock':     () => { sweep(500, 1500, .2, 'sine', .04); tone(1500, .15, 'sine', .03, .2); tone(2000, .2, 'sine', .02, .3); },
  'ui-star':       () => { tone(1047, .06, 'sine', .05); tone(1568, .1, 'sine', .04, .07); },
  'ui-achievement': () => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, .14, 'triangle', .055, i * .1)); noise(.2, .015, 8000, .5); },
  'ui-deny':       () => { tone(200, .12, 'square', .04); tone(160, .15, 'square', .04, .13); },
  'ui-open':       () => { sweep(400, 800, .08, 'sine', .03); },
  'ui-close':      () => { sweep(800, 400, .08, 'sine', .03); },

  // --- 错误变体 ---
  'err-file':       () => { tone(350, .08, 'sawtooth', .04); tone(280, .1, 'sawtooth', .035, .09); },
  'err-permission': () => { tone(150, .15, 'square', .05); tone(150, .1, 'square', .04, .18); },
  'err-network':    () => { sweep(800, 200, .25, 'sine', .04); noise(.12, .025, 1000, .1); },
  'err-syntax':     () => { tone(400, .05, 'square', .04); tone(300, .07, 'square', .04, .07); },
};

// 统一音效入口：sfx('file-create') / sfx('docker-start') ...
export function sfx(name) {
  if (!app.soundOn) return;
  const fn = SFX[name];
  if (fn) try { fn(); } catch (e) {}
}

// 注册自定义音效（模块可扩展）
export function registerSfx(name, fn) { SFX[name] = fn; }

export function toggleSound() {
  app.soundOn = !app.soundOn;
  document.getElementById('soundBtn').textContent = app.soundOn ? '🔊' : '🔇';
  if (app.soundOn) sfxClick();
}

/* ============ 彩带 ============ */
const cv = document.getElementById('confetti');
const cx = cv ? cv.getContext('2d') : null;
let parts = [], confettiRunning = false;

function sizeCv() { if (cv) { cv.width = innerWidth; cv.height = innerHeight; } }
addEventListener('resize', sizeCv);
sizeCv();

export function confettiBurst() {
  if (!cx) return;
  const colors = ['#3fb950', '#2dd4bf', '#58a6ff', '#bc8cff', '#f0883e', '#d29922', '#f778ba'];
  for (let i = 0; i < 130; i++) parts.push({
    x: innerWidth / 2, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 13, vy: Math.random() * -11 - 3, g: 0.32,
    s: Math.random() * 7 + 4, c: colors[i % colors.length],
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, life: 90
  });
  if (!confettiRunning) { confettiRunning = true; requestAnimationFrame(confettiTick); }
}

function confettiTick() {
  cx.clearRect(0, 0, cv.width, cv.height);
  parts = parts.filter(p => p.life > 0);
  for (const p of parts) {
    p.x += p.vx; p.y += p.vy; p.vy += p.g; p.r += p.vr; p.life--;
    cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r);
    cx.globalAlpha = Math.min(1, p.life / 40);
    cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); cx.restore();
  }
  if (parts.length) requestAnimationFrame(confettiTick);
  else { confettiRunning = false; cx.clearRect(0, 0, cv.width, cv.height); }
}
