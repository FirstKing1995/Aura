/**
 * ============================================================================
 *  AURA — BotService
 * ============================================================================
 *  Fachada entre o jogo e o motor de IA. Decide entre Web Worker (padrão) e
 *  execução síncrona (fallback quando o Worker não pode ser criado, por
 *  exemplo em `file://`). Expõe uma única promessa: `think(state, player)`.
 *
 *  Padrões: Facade + Strategy (worker vs. inline) + Promise registry.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG;
  const R = root.AuraRules;
  const { sleep } = root.AuraUtils;

  class BotService {
    constructor() {
      this.worker = null;
      this.ready = false;
      this.seq = 0;
      this.pending = new Map();
      this.level = CFG.AI.DEFAULT_LEVEL;
      this.lastStats = null;
    }

    setLevel(level) {
      if (CFG.AI.LEVELS[level]) this.level = level;
      return this.level;
    }

    get options() {
      return CFG.AI.LEVELS[this.level] || CFG.AI.LEVELS.adept;
    }

    /** Sobe o Worker silenciosamente; qualquer falha cai para modo inline. */
    init() {
      if (!CFG.AI.USE_WORKER || typeof Worker === 'undefined') return false;
      if (this.worker) return true;
      try {
        this.worker = new Worker(CFG.AI.WORKER_PATH);
        this.worker.onmessage = e => this._onMessage(e.data);
        this.worker.onerror = err => {
          console.warn('[bot] worker falhou, usando modo inline:', err.message);
          this._rejectAll(err);
          this.worker = null;
          this.ready = false;
        };
        return true;
      } catch (err) {
        console.warn('[bot] Worker indisponível:', err);
        this.worker = null;
        return false;
      }
    }

    _onMessage(msg) {
      if (!msg) return;
      if (msg.type === 'ready') { this.ready = true; return; }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.type === 'result') {
        this.lastStats = msg.stats;
        entry.resolve(msg.move);
      } else {
        entry.reject(new Error(msg.message || 'Falha na IA'));
      }
    }

    _rejectAll(err) {
      this.pending.forEach(p => p.reject(err));
      this.pending.clear();
    }

    /**
     * Calcula a melhor jogada. Garante um tempo mínimo de "pensamento" para
     * que o movimento do bot não pareça instantâneo (leitura do tabuleiro).
     */
    async think(state, player, overrides = {}) {
      const options = Object.assign({}, this.options, overrides);
      const started = Date.now();
      let move;

      if (this.worker) {
        move = await this._thinkInWorker(state, player, options)
          .catch(err => {
            console.warn('[bot] fallback inline:', err.message);
            return this._thinkInline(state, player, options);
          });
      } else {
        move = this._thinkInline(state, player, options);
      }

      const elapsed = Date.now() - started;
      if (elapsed < CFG.AI.THINK_MIN_MS) await sleep(CFG.AI.THINK_MIN_MS - elapsed);
      return move;
    }

    _thinkInWorker(state, player, options) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        const timeout = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error('Timeout da IA'));
          }
        }, options.timeMs + 6000);

        const wrap = fn => value => { clearTimeout(timeout); fn(value); };
        this.pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) });

        this.worker.postMessage({
          type: 'think',
          id,
          state: R.serialize(state),
          player,
          options
        });
      });
    }

    _thinkInline(state, player, options) {
      const result = root.AuraAI.think(state, player, options);
      this.lastStats = { score: result.score, depth: result.depth, nodes: result.nodes, ms: result.ms };
      return result.move;
    }

    /** Nome gerado para o adversário artificial, estável por sessão. */
    generateName(seed) {
      const prefixes = ['Vex', 'Nyx', 'Kael', 'Orin', 'Zephy', 'Lum', 'Arc', 'Sora'];
      const suffixes = ['-01', '-VII', '-Prime', '-Echo', '-Null', '-Ix'];
      const s = seed || Date.now();
      return prefixes[s % prefixes.length] + suffixes[(s >> 3) % suffixes.length];
    }

    estimatedElo() {
      return { novice: 780, adept: 1080, master: 1420 }[this.level] || 1000;
    }

    dispose() {
      this._rejectAll(new Error('Bot encerrado'));
      if (this.worker) { this.worker.terminate(); this.worker = null; }
      this.ready = false;
    }
  }

  root.AuraBot = new BotService();
})(typeof self !== 'undefined' ? self : this);
