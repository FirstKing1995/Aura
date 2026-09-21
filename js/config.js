/**
 * AURA — Configuração global do cliente.
 * Congelada para evitar mutação acidental entre módulos.
 */
(function (root) {
  'use strict';

  const AURA_CONFIG = Object.freeze({

    APP: Object.freeze({
      NAME: 'Aura',
      BUILD: '1.4.0',
      STORAGE_PREFIX: 'aura:v1:'
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
      N: 9,
      SIZE: 81,
      TERRITORY_WIN_RATIO: 0.70
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

    UI: Object.freeze({
      SHARD_PARTICLES: 14,
      MOVE_ANIM_MS: 260,
      TOAST_MS: 3200,
      HAPTICS: true
    })
  });

  root.AURA_CONFIG = AURA_CONFIG;
})(typeof self !== 'undefined' ? self : this);
