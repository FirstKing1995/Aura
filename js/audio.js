/**
 * ============================================================================
 *  AURA — Áudio
 * ============================================================================
 *  Tudo aqui é SINTETIZADO em tempo real com a Web Audio API. Nenhum .mp3,
 *  nenhum .wav, nenhum byte extra para o GitHub Pages servir — o que importa
 *  num jogo que precisa abrir rápido no 4G.
 *
 *  Arquitetura de barramentos:
 *
 *      vozes ──┬─► sfxBus ──┐
 *              │            ├─► compressor (limiter) ──► master ──► saída
 *      trilha ─┴─► musicBus ┘         ▲
 *                                     │
 *              send ──► convolver (reverb gerado por ruído decaído)
 *
 *  A trilha é um sequenciador com "lookahead": um setInterval barato acorda a
 *  cada 25ms e agenda no relógio de alta precisão do AudioContext o que vai
 *  tocar nos próximos 220ms. É o padrão clássico — o jitter do setTimeout
 *  nunca chega no áudio.
 *
 *  A música é ADAPTATIVA: `setIntensity(0..1)` acende camadas conforme a
 *  partida esquenta (território disputado, Núcleo sem ar, poucas peças).
 *
 *  Regras da casa:
 *    · navegadores exigem gesto do usuário -> `unlock()` no primeiro toque
 *    · em aba oculta a trilha pausa sozinha
 *    · teto de vozes simultâneas, para não engasgar celular fraco
 *    · se a Web Audio não existir, TUDO vira no-op silencioso (nunca quebra)
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG.AUDIO;
  const Storage = root.AuraUtils.Storage;

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

  /* ================================================================== */
  /* Utilidades musicais                                                */
  /* ================================================================== */

  /** Grau da escala -> Hz. Graus acima de 7 sobem de oitava automaticamente. */
  function degreeToHz(degree, octave) {
    const scale = CFG.SCALE;
    const len = scale.length - 1;                 // o último é a oitava
    let oct = octave || 0;
    let d = degree;
    while (d < 0) { d += len; oct--; }
    while (d >= len) { d -= len; oct++; }
    const semis = scale[d] + oct * 12;
    return CFG.ROOT_HZ * Math.pow(2, semis / 12);
  }

  /* ================================================================== */
  /* Engine                                                             */
  /* ================================================================== */

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.supported = typeof window !== 'undefined' &&
        !!(window.AudioContext || window.webkitAudioContext);

      this.muted = Storage.get('audio:muted', !CFG.ENABLED_BY_DEFAULT);
      this.volumes = {
        master: Storage.get('audio:master', CFG.MASTER),
        music:  Storage.get('audio:music',  CFG.MUSIC),
        sfx:    Storage.get('audio:sfx',    CFG.SFX)
      };

      this.voices = 0;
      this.music = { playing: false, mood: 'menu', intensity: 0, timer: null, nextTime: 0, step: 0 };
      this._noise = null;
      this._drone = null;
    }

    /* ----------------------------- ciclo de vida ------------------- */

    /** Chamado no primeiro gesto do usuário. Idempotente. */
    unlock() {
      if (!this.supported) return false;
      if (!this.ctx) this._build();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    }

    get ready() { return !!this.ctx && this.ctx.state === 'running'; }

    _build() {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ctx = this.ctx = new Ctor();

      // limiter suave: evita clipping quando um cerco captura 6 peças de uma vez
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 24;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.22;

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volumes.master;

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.volumes.sfx;

      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.volumes.music;

      // reverb por convolução, com resposta impulsiva gerada na hora
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._impulse(2.4, 2.6);
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.9;

      this.sfxBus.connect(limiter);
      this.musicBus.connect(limiter);
      this.reverb.connect(this.reverbGain);
      this.reverbGain.connect(limiter);
      limiter.connect(this.master);
      this.master.connect(ctx.destination);

      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend().catch(() => {});
        else if (!this.muted) this.ctx.resume().catch(() => {});
      });
    }

    /** Resposta impulsiva sintética: ruído com decaimento exponencial. */
    _impulse(seconds, decay) {
      const ctx = this.ctx;
      const rate = ctx.sampleRate;
      const len = Math.floor(rate * seconds);
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const t = i / len;
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        }
      }
      return buf;
    }

    _noiseBuffer() {
      if (this._noise) return this._noise;
      const ctx = this.ctx;
      const len = Math.floor(ctx.sampleRate * 1.2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._noise = buf;
      return buf;
    }

    /* ----------------------------- mixer --------------------------- */

    setMuted(muted) {
      this.muted = !!muted;
      Storage.set('audio:muted', this.muted);
      if (!this.ctx) return this.muted;
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, now, 0.05);
      if (this.muted) this.ctx.suspend().catch(() => {});
      else this.ctx.resume().catch(() => {});
      return this.muted;
    }

    toggleMuted() { return this.setMuted(!this.muted); }

    setVolume(bus, value) {
      const v = clamp01(value);
      this.volumes[bus] = v;
      Storage.set('audio:' + bus, v);
      if (!this.ctx) return;
      const node = bus === 'master' ? this.master : bus === 'music' ? this.musicBus : this.sfxBus;
      const target = (bus === 'master' && this.muted) ? 0 : v;
      node.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
    }

    /* ----------------------------- vozes --------------------------- */

    _budget() {
      if (this.voices >= CFG.MAX_VOICES) return false;
      this.voices++;
      return true;
    }

    _release(node, at) {
      const ms = Math.max(0, (at - this.ctx.currentTime) * 1000) + 60;
      setTimeout(() => { this.voices = Math.max(0, this.voices - 1); try { node.disconnect(); } catch (e) {} }, ms);
    }

    /**
     * Voz básica: oscilador -> filtro opcional -> envelope -> barramento.
     * Retorna o nó de ganho para quem quiser encadear algo.
     */
    _tone(opts) {
      if (!this.ready || !this._budget()) return null;
      const ctx = this.ctx;
      const t = opts.at || ctx.currentTime;
      const dur = opts.dur || 0.25;
      const bus = opts.bus || this.sfxBus;

      const osc = ctx.createOscillator();
      osc.type = opts.type || 'triangle';
      osc.frequency.setValueAtTime(opts.freq, t);
      if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.glideTo), t + dur * (opts.glide || 0.9));
      if (opts.detune) osc.detune.setValueAtTime(opts.detune, t);

      const gain = ctx.createGain();
      const peak = opts.peak === undefined ? 0.25 : opts.peak;
      const attack = opts.attack === undefined ? 0.008 : opts.attack;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
      if (opts.hold) gain.gain.setValueAtTime(Math.max(0.0002, peak), t + attack + opts.hold);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      let tail = osc;
      if (opts.filter) {
        const f = ctx.createBiquadFilter();
        f.type = opts.filter.type || 'lowpass';
        f.frequency.setValueAtTime(opts.filter.freq, t);
        if (opts.filter.sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, opts.filter.sweepTo), t + dur);
        f.Q.value = opts.filter.q === undefined ? 1 : opts.filter.q;
        osc.connect(f); tail = f;
      }
      tail.connect(gain);
      gain.connect(bus);
      if (opts.send) {
        const send = ctx.createGain();
        send.gain.value = opts.send;
        gain.connect(send);
        send.connect(this.reverb);
      }

      osc.start(t);
      osc.stop(t + dur + 0.05);
      this._release(gain, t + dur);
      return gain;
    }

    /** Percussão e texturas: ruído filtrado com envelope curto. */
    _noiseHit(opts) {
      if (!this.ready || !this._budget()) return null;
      const ctx = this.ctx;
      const t = opts.at || ctx.currentTime;
      const dur = opts.dur || 0.2;

      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer();
      src.loop = true;
      src.playbackRate.value = opts.rate || 1;

      const filter = ctx.createBiquadFilter();
      filter.type = opts.type || 'bandpass';
      filter.frequency.setValueAtTime(opts.freq || 1800, t);
      if (opts.sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(60, opts.sweepTo), t + dur);
      filter.Q.value = opts.q === undefined ? 1.2 : opts.q;

      const gain = ctx.createGain();
      const peak = opts.peak === undefined ? 0.2 : opts.peak;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + (opts.attack || 0.004));
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      src.connect(filter); filter.connect(gain);
      gain.connect(opts.bus || this.sfxBus);
      if (opts.send) {
        const send = ctx.createGain();
        send.gain.value = opts.send;
        gain.connect(send); send.connect(this.reverb);
      }

      src.start(t);
      src.stop(t + dur + 0.05);
      this._release(gain, t + dur);
      return gain;
    }

    /* ================================================================ */
    /* Banco de efeitos                                                 */
    /* ================================================================ */

    play(name, opts) {
      if (!this.supported || this.muted) return;
      if (!this.ctx) return;                     // ainda não houve gesto
      if (this.ctx.state !== 'running') return;
      const fn = SFX[name];
      if (fn) { try { fn(this, opts || {}); } catch (e) { /* áudio nunca derruba o jogo */ } }
    }

    /* ================================================================ */
    /* Trilha procedural                                                */
    /* ================================================================ */

    startMusic(mood) {
      if (!this.supported || !this.ctx) return;
      this.music.mood = mood || 'menu';
      if (this.music.playing) return;
      this.music.playing = true;
      this.music.step = 0;
      this.music.nextTime = this.ctx.currentTime + 0.12;
      this._startDrone();
      this.music.timer = setInterval(() => this._scheduler(), CFG.LOOKAHEAD_MS);
    }

    stopMusic() {
      this.music.playing = false;
      if (this.music.timer) { clearInterval(this.music.timer); this.music.timer = null; }
      this._stopDrone();
    }

    setMood(mood) {
      if (this.music.mood === mood) return;
      this.music.mood = mood;
      this.music.step = 0;
    }

    setIntensity(value) { this.music.intensity = clamp01(value); }

    _startDrone() {
      if (!this.ready || this._drone) return;
      const ctx = this.ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.gain.setTargetAtTime(0.11, ctx.currentTime, 1.6);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      filter.Q.value = 0.8;

      // LFO lento no corte: a "respiração" da trilha
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.055;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 190;
      lfo.connect(lfoGain); lfoGain.connect(filter.frequency);

      const oscs = [];
      [0, -0.02, 7].forEach((offset, k) => {
        const o = ctx.createOscillator();
        o.type = k === 2 ? 'triangle' : 'sawtooth';
        o.frequency.value = k === 2 ? CFG.ROOT_HZ * 1.5 : CFG.ROOT_HZ / 2;
        o.detune.value = k === 1 ? -9 : (k === 2 ? 5 : 0);
        o.connect(filter);
        o.start();
        oscs.push(o);
      });

      filter.connect(gain);
      gain.connect(this.musicBus);
      const send = ctx.createGain();
      send.gain.value = 0.5;
      gain.connect(send); send.connect(this.reverb);

      lfo.start();
      this._drone = { oscs, lfo, gain, filter };
    }

    _stopDrone() {
      const d = this._drone;
      if (!d || !this.ctx) return;
      const now = this.ctx.currentTime;
      d.gain.gain.cancelScheduledValues(now);
      d.gain.gain.setTargetAtTime(0.0001, now, 0.5);
      setTimeout(() => {
        try {
          d.oscs.forEach(o => o.stop());
          d.lfo.stop();
          d.gain.disconnect();
        } catch (e) {}
      }, 2200);
      this._drone = null;
    }

    /** Progressões por clima: graus da escala (0 = tônica). */
    _progression() {
      switch (this.music.mood) {
        case 'battle':  return [0, 5, 3, 4, 0, 6, 4, 4];
        case 'victory': return [0, 4, 5, 7];
        case 'defeat':  return [0, 6, 5, 3];
        case 'phase':   return [0, 3, 5, 4];
        default:        return [0, 5, 3, 6];      // menu: mais aberto, mais lento
      }
    }

    _scheduler() {
      if (!this.music.playing || !this.ready) return;
      const ctx = this.ctx;
      const beat = 60 / (CFG.BPM * (this.music.mood === 'menu' ? 0.82 : 1));
      const stepDur = beat / 2;                  // colcheias

      while (this.music.nextTime < ctx.currentTime + CFG.SCHEDULE_AHEAD_S) {
        this._scheduleStep(this.music.step, this.music.nextTime, stepDur);
        this.music.step++;
        this.music.nextTime += stepDur;
      }
    }

    _scheduleStep(step, at, stepDur) {
      const prog = this._progression();
      const barLen = 8;                          // 8 colcheias por compasso
      const bar = Math.floor(step / barLen) % prog.length;
      const inBar = step % barLen;
      const rootDeg = prog[bar];
      const I = this.music.intensity;

      // ---- pad: acorde no primeiro tempo do compasso -----------------
      if (inBar === 0) {
        [0, 2, 4].forEach((interval, k) => {
          this._tone({
            at: at + k * 0.012,
            freq: degreeToHz(rootDeg + interval, -1),
            type: 'sawtooth',
            dur: stepDur * 7.2,
            attack: 0.5,
            peak: 0.045 + I * 0.02,
            detune: (k - 1) * 6,
            filter: { type: 'lowpass', freq: 520 + I * 900, q: 0.7 },
            send: 0.55,
            bus: this.musicBus
          });
        });
      }

      // ---- arpejo: entra quando a partida aquece ---------------------
      if (I > 0.32 && inBar % 2 === 1) {
        const figure = [0, 2, 4, 6, 4, 2];
        const note = figure[(step / 1) % figure.length | 0];
        this._tone({
          at: at,
          freq: degreeToHz(rootDeg + note, 1),
          type: 'triangle',
          dur: stepDur * 1.6,
          attack: 0.004,
          peak: 0.03 + I * 0.05,
          filter: { type: 'lowpass', freq: 2400, q: 1.1 },
          send: 0.4,
          bus: this.musicBus
        });
      }

      // ---- pulso grave: só no clímax ---------------------------------
      if (I > 0.6 && inBar % 4 === 0) {
        this._tone({
          at: at,
          freq: degreeToHz(rootDeg, -2),
          glideTo: degreeToHz(rootDeg, -2) * 0.6,
          type: 'sine',
          dur: 0.34,
          attack: 0.005,
          peak: 0.18 * I,
          bus: this.musicBus
        });
      }

      // ---- textura: brilho esparso -----------------------------------
      if (inBar === 5 && Math.random() < 0.3 + I * 0.3) {
        this._noiseHit({
          at: at,
          dur: 0.6,
          freq: 4200,
          sweepTo: 1200,
          q: 3,
          peak: 0.018 + I * 0.02,
          send: 0.7,
          bus: this.musicBus
        });
      }
    }
  }

  /* ================================================================== */
  /* Tabela de efeitos — cada um é uma pequena composição               */
  /* ================================================================== */

  const SFX = {

    /* --- interface ------------------------------------------------- */
    click(e) {
      e._tone({ freq: 560, type: 'square', dur: 0.06, peak: 0.07, filter: { type: 'lowpass', freq: 2200 } });
    },
    screen(e) {
      e._tone({ freq: 300, glideTo: 520, type: 'sine', dur: 0.24, peak: 0.1, send: 0.3 });
    },
    toast(e) {
      e._tone({ freq: 880, type: 'sine', dur: 0.14, peak: 0.08, send: 0.25 });
      e._tone({ at: e.ctx.currentTime + 0.07, freq: 1170, type: 'sine', dur: 0.14, peak: 0.06, send: 0.25 });
    },

    /* --- tabuleiro -------------------------------------------------- */
    select(e, o) {
      const base = o.side === 2 ? 620 : 520;
      e._tone({ freq: base, glideTo: base * 1.5, type: 'triangle', dur: 0.18, peak: 0.16, send: 0.35 });
    },
    deselect(e) {
      e._tone({ freq: 420, glideTo: 300, type: 'triangle', dur: 0.12, peak: 0.1 });
    },
    step(e) {
      e._noiseHit({ dur: 0.11, freq: 900, sweepTo: 320, q: 1.4, peak: 0.13, send: 0.2 });
      e._tone({ freq: 220, type: 'sine', dur: 0.1, peak: 0.1 });
    },
    slide(e, o) {
      const n = o.length || 2;
      e._noiseHit({ dur: 0.1 + n * 0.06, freq: 700, sweepTo: 2600, q: 2.2, peak: 0.1, send: 0.35 });
      e._tone({ freq: 300, glideTo: 300 * Math.pow(1.12, n), type: 'sawtooth', dur: 0.16 + n * 0.05,
                peak: 0.07, filter: { type: 'lowpass', freq: 1400, sweepTo: 3000 } });
    },
    jump(e) {
      e._tone({ freq: 380, glideTo: 820, type: 'triangle', dur: 0.2, peak: 0.16, send: 0.3 });
      e._noiseHit({ at: e.ctx.currentTime + 0.17, dur: 0.12, freq: 1600, sweepTo: 500, q: 1.6, peak: 0.14 });
    },
    portal(e) {
      const t = e.ctx.currentTime;
      e._tone({ at: t, freq: 240, glideTo: 1400, type: 'sine', dur: 0.3, peak: 0.13, send: 0.6 });
      e._tone({ at: t + 0.14, freq: 1400, glideTo: 300, type: 'sine', dur: 0.32, peak: 0.12, send: 0.6 });
      e._noiseHit({ at: t, dur: 0.42, freq: 800, sweepTo: 5200, q: 4, peak: 0.07, send: 0.8 });
    },
    radiate(e) {
      const t = e.ctx.currentTime;
      [0, 4, 7].forEach((s, k) => {
        e._tone({ at: t + k * 0.035, freq: degreeToHz(s, 1), type: 'sine',
                  dur: 0.45, attack: 0.01, peak: 0.08, send: 0.7 });
      });
    },
    paint(e) {
      e._tone({ freq: 1200 + Math.random() * 260, type: 'sine', dur: 0.09, peak: 0.045, send: 0.4 });
    },
    shatter(e, o) {
      const t = e.ctx.currentTime;
      const count = Math.min(4, Math.max(1, o.count || 1));
      for (let k = 0; k < count; k++) {
        e._noiseHit({ at: t + k * 0.055, dur: 0.34, freq: 3200, sweepTo: 420, q: 0.9,
                      peak: 0.17, send: 0.5 });
      }
      e._tone({ at: t, freq: 150, glideTo: 60, type: 'sawtooth', dur: 0.26, peak: 0.14,
                filter: { type: 'lowpass', freq: 900, sweepTo: 200 } });
    },
    siege(e) {
      const t = e.ctx.currentTime;
      [0, 3, 5, 7].forEach((s, k) => {
        e._tone({ at: t + k * 0.06, freq: degreeToHz(s, -1), type: 'sawtooth', dur: 0.7,
                  attack: 0.02, peak: 0.1, filter: { type: 'lowpass', freq: 700, sweepTo: 260, q: 4 },
                  send: 0.75 });
      });
      e._noiseHit({ at: t, dur: 0.8, freq: 260, sweepTo: 90, q: 0.7, peak: 0.12, send: 0.6 });
    },
    invalid(e) {
      e._tone({ freq: 180, type: 'square', dur: 0.14, peak: 0.1,
                filter: { type: 'lowpass', freq: 700 } });
    },
    turn(e) {
      e._tone({ freq: 700, type: 'sine', dur: 0.12, peak: 0.07, send: 0.3 });
    },
    coreWarn(e) {
      const t = e.ctx.currentTime;
      [0, 0.22].forEach(off => {
        e._tone({ at: t + off, freq: 196, type: 'sawtooth', dur: 0.2, peak: 0.12,
                  filter: { type: 'bandpass', freq: 420, q: 6 } });
      });
    },

    /* --- desfechos --------------------------------------------------- */
    victory(e) {
      const t = e.ctx.currentTime;
      [0, 2, 4, 7].forEach((s, k) => {
        e._tone({ at: t + k * 0.1, freq: degreeToHz(s, 0), type: 'triangle',
                  dur: 1.1, attack: 0.02, peak: 0.16, send: 0.8 });
        e._tone({ at: t + k * 0.1, freq: degreeToHz(s, 1), type: 'sine',
                  dur: 0.9, attack: 0.02, peak: 0.08, send: 0.8 });
      });
    },
    defeat(e) {
      const t = e.ctx.currentTime;
      [7, 5, 3, 0].forEach((s, k) => {
        e._tone({ at: t + k * 0.16, freq: degreeToHz(s, -1), type: 'sawtooth',
                  dur: 1.3, attack: 0.04, peak: 0.12,
                  filter: { type: 'lowpass', freq: 1200, sweepTo: 240 }, send: 0.7 });
      });
    },
    phase(e) {
      const t = e.ctx.currentTime;
      [0, 4, 7, 9].forEach((s, k) => {
        e._tone({ at: t + k * 0.08, freq: degreeToHz(s, 1), type: 'sine',
                  dur: 0.7, peak: 0.12, send: 0.85 });
      });
      e._noiseHit({ at: t, dur: 1.0, freq: 900, sweepTo: 6000, q: 2, peak: 0.06, send: 0.9 });
    },
    unlock(e) {
      const t = e.ctx.currentTime;
      [0, 2, 4, 5, 7].forEach((s, k) => {
        e._tone({ at: t + k * 0.07, freq: degreeToHz(s, 1), type: 'triangle',
                  dur: 0.5, peak: 0.11, send: 0.7 });
      });
    }
  };

  const engine = new AudioEngine();
  engine.degreeToHz = degreeToHz;
  engine.SFX_NAMES = Object.keys(SFX);

  root.AuraAudio = engine;
})(typeof self !== 'undefined' ? self : this);
