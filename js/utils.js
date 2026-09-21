/**
 * AURA — Utilidades transversais.
 * Contém: EventBus (pub/sub), Store (estado observável), helpers de DOM,
 * persistência local segura e controle de animação.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* EventBus — desacopla UI, rede e regras                              */
  /* ------------------------------------------------------------------ */
  class EventBus {
    constructor() { this._map = new Map(); }

    on(event, handler) {
      if (!this._map.has(event)) this._map.set(event, new Set());
      this._map.get(event).add(handler);
      return () => this.off(event, handler);
    }

    once(event, handler) {
      const off = this.on(event, (...args) => { off(); handler(...args); });
      return off;
    }

    off(event, handler) {
      const set = this._map.get(event);
      if (set) set.delete(handler);
    }

    emit(event, payload) {
      const set = this._map.get(event);
      if (!set) return;
      [...set].forEach(fn => {
        try { fn(payload); }
        catch (err) { console.error(`[bus:${event}]`, err); }
      });
    }

    clear() { this._map.clear(); }
  }

  /* ------------------------------------------------------------------ */
  /* Store — estado central observável (padrão Observer)                 */
  /* ------------------------------------------------------------------ */
  class Store {
    constructor(initial = {}) {
      this._state = { ...initial };
      this._subs = new Set();
    }

    get state() { return this._state; }

    get(key) { return this._state[key]; }

    set(patch) {
      const prev = this._state;
      this._state = { ...prev, ...patch };
      const changed = Object.keys(patch).filter(k => prev[k] !== this._state[k]);
      if (changed.length) this._subs.forEach(fn => fn(this._state, prev, changed));
      return this._state;
    }

    subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  }

  /* ------------------------------------------------------------------ */
  /* Storage — localStorage com namespace e fallback em memória          */
  /* ------------------------------------------------------------------ */
  const Storage = (() => {
    const prefix = (root.AURA_CONFIG && root.AURA_CONFIG.APP.STORAGE_PREFIX) || 'aura:';
    const memory = new Map();
    let available = true;
    try {
      const probe = prefix + '__probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
    } catch (e) { available = false; }

    return {
      get(key, fallback = null) {
        try {
          const raw = available ? localStorage.getItem(prefix + key) : memory.get(prefix + key);
          return raw === null || raw === undefined ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
      },
      set(key, value) {
        const raw = JSON.stringify(value);
        try {
          if (available) localStorage.setItem(prefix + key, raw);
          else memory.set(prefix + key, raw);
        } catch (e) { memory.set(prefix + key, raw); }
      },
      remove(key) {
        try {
          if (available) localStorage.removeItem(prefix + key);
          memory.delete(prefix + key);
        } catch (e) {}
      }
    };
  })();

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */
  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children])
      .filter(Boolean)
      .forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* Assíncrono                                                          */
  /* ------------------------------------------------------------------ */
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  function debounce(fn, wait = 200) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  function throttle(fn, wait = 200) {
    let last = 0, pending = null;
    return (...args) => {
      const now = Date.now();
      if (now - last >= wait) { last = now; fn(...args); }
      else {
        clearTimeout(pending);
        pending = setTimeout(() => { last = Date.now(); fn(...args); }, wait - (now - last));
      }
    };
  }

  /** Retry com backoff exponencial e jitter. */
  async function retry(fn, attempts = 2, baseDelay = 600) {
    let lastErr;
    for (let i = 0; i <= attempts; i++) {
      try { return await fn(i); }
      catch (err) {
        lastErr = err;
        if (err && err.fatal) throw err;
        if (i === attempts) break;
        await sleep(baseDelay * Math.pow(2, i) + Math.random() * 180);
      }
    }
    throw lastErr;
  }

  /* ------------------------------------------------------------------ */
  /* Misc                                                                */
  /* ------------------------------------------------------------------ */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand  = (a, b) => a + Math.random() * (b - a);

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function prefersReducedMotion() {
    return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function haptic(pattern = 12) {
    const cfg = root.AURA_CONFIG;
    if (!cfg || !cfg.UI.HAPTICS) return;
    if (root.navigator && navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  root.AuraUtils = {
    EventBus, Store, Storage,
    $, $$, el, sleep, debounce, throttle, retry,
    clamp, rand, formatDuration, prefersReducedMotion, haptic
  };
})(typeof self !== 'undefined' ? self : this);
