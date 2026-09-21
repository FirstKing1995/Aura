/**
 * ============================================================================
 *  AURA — Camada de tempo real por Short Polling
 * ============================================================================
 *  O Apps Script não oferece WebSocket. Esta camada simula tempo real com
 *  pesquisa periódica, mas trata os problemas clássicos do polling ingênuo:
 *
 *   - Sobreposição: nunca dispara um tick enquanto o anterior está no ar.
 *   - Backoff exponencial: erros consecutivos espaçam a próxima tentativa.
 *   - Jitter: dispersa requisições simultâneas de vários clientes.
 *   - Visibilidade: pausa quando a aba sai de foco e faz um tick imediato ao
 *     voltar, poupando quota do Apps Script e bateria do celular.
 *   - Versionamento: o servidor devolve `changed:false` quando nada mudou,
 *     então o payload trafegado em turno alheio é mínimo.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG;

  class Poller {
    /**
     * @param {Function} task   async () => void — uma rodada de pesquisa
     * @param {object}   opts   { interval, maxBackoff, name, onError }
     */
    constructor(task, opts = {}) {
      this.task = task;
      this.interval = opts.interval || 2000;
      this.maxBackoff = opts.maxBackoff || CFG.NET.POLL_BACKOFF_MAX_MS;
      this.name = opts.name || 'poller';
      this.onError = opts.onError || null;

      this.timer = null;
      this.running = false;
      this.inFlight = false;
      this.failures = 0;
      this.ticks = 0;
      this._visibilityHandler = this._onVisibility.bind(this);
    }

    start(immediate = true) {
      if (this.running) return this;
      this.running = true;
      this.failures = 0;
      document.addEventListener('visibilitychange', this._visibilityHandler);
      if (immediate) this._tick();
      else this._schedule();
      return this;
    }

    stop() {
      this.running = false;
      clearTimeout(this.timer);
      this.timer = null;
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      return this;
    }

    /** Força uma rodada agora (após enviar uma jogada, por exemplo). */
    poke() {
      if (!this.running || this.inFlight) return;
      clearTimeout(this.timer);
      this._tick();
    }

    _delay() {
      const backoff = Math.min(
        this.interval * Math.pow(2, this.failures),
        this.maxBackoff
      );
      const base = this.failures ? backoff : this.interval;
      return base + Math.random() * 250;          // jitter
    }

    _schedule() {
      if (!this.running) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._tick(), this._delay());
    }

    async _tick() {
      if (!this.running || this.inFlight) return;
      if (document.hidden) { this._schedule(); return; }

      this.inFlight = true;
      try {
        await this.task(this.ticks++);
        this.failures = 0;
      } catch (err) {
        this.failures = Math.min(this.failures + 1, 5);
        if (this.onError) {
          try { this.onError(err, this.failures); } catch (e) { console.error(e); }
        } else {
          console.warn(`[${this.name}]`, err.code || err.message);
        }
      } finally {
        this.inFlight = false;
        this._schedule();
      }
    }

    _onVisibility() {
      if (!this.running) return;
      if (!document.hidden) this.poke();
    }
  }

  /**
   * Detector de conectividade simples: combina navigator.onLine com o
   * resultado real das chamadas de API.
   */
  class ConnectionMonitor {
    constructor(bus) {
      this.bus = bus;
      this.online = navigator.onLine !== false;
      root.addEventListener('online', () => this._set(true));
      root.addEventListener('offline', () => this._set(false));
      root.AuraApi.onStatus(ok => this._set(ok));
    }
    _set(value) {
      if (this.online === value) return;
      this.online = value;
      this.bus.emit('connection:change', value);
    }
  }

  root.AuraNet = { Poller, ConnectionMonitor };
})(typeof self !== 'undefined' ? self : this);
