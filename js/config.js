/**
 * AURA — Configuração global do cliente.
 * Congelada para evitar mutação acidental entre módulos.
 */
(function (root) {
  'use strict';

  const AURA_CONFIG = Object.freeze({

    APP: Object.freeze({
      NAME: 'Aura',
      BUILD: '2.0.0',
      STORAGE_PREFIX: 'aura:v2:'
    }),

    API: Object.freeze({
      // Cole aqui a URL /exec da implantação do Apps Script.
      BASE_URL: 'https://script.google.com/macros/s/COLE_SEU_DEPLOYMENT_ID_AQUI/exec',
      TIMEOUT_MS: 15000,
      RETRIES: 2,
      RETRY_BACKOFF_MS: 700,
      // JSONP evita erros de CORS em contas/implantações restritivas.
      PREFER_JSONP: false
    }),

    NET: Object.freeze({
      QUEUE_POLL_MS: 2000,
      MATCH_POLL_MS: 2000,
      POLL_BACKOFF_MAX_MS: 8000,
      BOT_FALLBACK_MS: 30000      // 30s na fila -> partida contra a IA
    }),

    BOARD: Object.freeze({
      // Arena usada no online e no jogo rápido. O servidor valida contra ela.
      DEFAULT_ARENA: 'classic',
      // Acima deste tamanho a UI encolhe fontes e sombras para caber no celular.
      DENSE_FROM_N: 11
    }),

    CAMPAIGN: Object.freeze({
      // Quantas fases ficam liberadas de saída (as demais abrem ao vencer).
      UNLOCKED_AT_START: 1,
      // Orçamento de lances para a 3ª estrela, por tamanho de tabuleiro.
      STAR_PLY_BUDGET: Object.freeze({ 9: 70, 11: 95, 13: 130 })
    }),

    AI: Object.freeze({
      USE_WORKER: true,
      WORKER_PATH: 'js/ai.worker.js',
      DEFAULT_LEVEL: 'adept',
      LEVELS: Object.freeze({
        novice: { depth: 2, timeMs: 700,  noise: 55, name: 'novice' },
        adept:  { depth: 3, timeMs: 1400, noise: 18, name: 'adept'  },
        master: { depth: 4, timeMs: 2600, noise: 0,  name: 'master' }
      }),
      THINK_MIN_MS: 450           // respiro visual antes de mover
    }),

    RANK: Object.freeze({
      DIVISIONS: Object.freeze([
        { id: 'iron',        min: 0,    color: '#8a93a6' },
        { id: 'bronze',      min: 900,  color: '#c98b5a' },
        { id: 'silver',      min: 1100, color: '#c6d2e2' },
        { id: 'gold',        min: 1350, color: '#f2c14e' },
        { id: 'grandmaster', min: 1650, color: '#b06bff' }
      ])
    }),

    AUDIO: Object.freeze({
      ENABLED_BY_DEFAULT: true,
      MASTER: 0.85,
      MUSIC: 0.34,
      SFX: 0.62,
      // Escala de Ré menor (modo eólio) — base harmônica da trilha procedural.
      ROOT_HZ: 146.83,                                  // D3
      SCALE: Object.freeze([0, 2, 3, 5, 7, 8, 10, 12]),
      BPM: 68,
      LOOKAHEAD_MS: 25,
      SCHEDULE_AHEAD_S: 0.22,
      MAX_VOICES: 18              // teto de vozes simultâneas (celular fraco)
    }),

    UI: Object.freeze({
      SHARD_PARTICLES: 14,
      MOVE_ANIM_MS: 260,
      SLIDE_STEP_MS: 150,
      JUMP_STEP_MS: 210,
      PORTAL_ANIM_MS: 420,
      RADIATE_MS: 520,
      TOAST_MS: 3200,
      SHAKE_MS: 340,
      HAPTICS: true,
      BOARD_INTRO_MS: 620
    })
  });

  root.AURA_CONFIG = AURA_CONFIG;
})(typeof self !== 'undefined' ? self : this);
