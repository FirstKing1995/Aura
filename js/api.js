/**
 * ============================================================================
 *  AURA — Camada de API
 * ============================================================================
 *  Cliente HTTP para o Web App do Google Apps Script.
 *
 *  Decisões de engenharia:
 *   - POST com `Content-Type: text/plain;charset=utf-8`. O Apps Script não
 *     responde ao preflight OPTIONS; usando um "simple request" o navegador
 *     não dispara preflight e a chamada passa.
 *   - Fallback JSONP (<script>) para ambientes onde a resposta do POST vem
 *     opaca ou bloqueada. Transparente para o chamador.
 *   - Retry com backoff apenas em falhas de rede/5xx. Erros de domínio
 *     (jogada ilegal, credenciais) nunca são repetidos.
 *   - Erros normalizados em `ApiClientError { code, message }` para que a UI
 *     apenas traduza o código via i18n.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG;
  const { Storage, retry } = root.AuraUtils;

  class ApiClientError extends Error {
    constructor(code, message, fatal = false) {
      super(message || code);
      this.name = 'ApiClientError';
      this.code = code;
      this.fatal = fatal;   // fatal = não tentar de novo
    }
  }

  const DOMAIN_ERRORS = new Set([
    'BAD_CREDENTIALS', 'USERNAME_TAKEN', 'USERNAME_SHORT', 'USERNAME_INVALID',
    'PASSWORD_SHORT', 'NOT_YOUR_TURN', 'ILLEGAL_MOVE', 'MATCH_NOT_FOUND',
    'NOT_A_PLAYER', 'MATCH_OVER', 'EXPIRED_TOKEN', 'BAD_TOKEN', 'UNKNOWN_ACTION',
    'STALE_STATE', 'USER_NOT_FOUND'
  ]);

  class ApiClient {
    constructor() {
      this.baseUrl = CFG.API.BASE_URL;
      this.token = Storage.get('token', null);
      this.jsonpSeq = 0;
      this.forceJsonp = CFG.API.PREFER_JSONP;
      this.online = true;
      this.listeners = new Set();
    }

    /* -------------------------- sessão -------------------------- */

    setToken(token) {
      this.token = token || null;
      if (token) Storage.set('token', token); else Storage.remove('token');
    }

    get isConfigured() {
      return !!this.baseUrl && this.baseUrl.indexOf('COLE_SEU_DEPLOYMENT_ID_AQUI') === -1;
    }

    onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    _setOnline(value) {
      if (this.online === value) return;
      this.online = value;
      this.listeners.forEach(fn => fn(value));
    }

    /* -------------------------- transporte -------------------------- */

    async _fetchPost(payload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CFG.API.TIMEOUT_MS);
      try {
        const res = await fetch(this.baseUrl, {
          method: 'POST',
          // text/plain evita o preflight CORS que o GAS não responde
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload),
          redirect: 'follow',
          signal: controller.signal
        });
        if (!res.ok) throw new ApiClientError('NETWORK', 'HTTP ' + res.status);
        const text = await res.text();
        try { return JSON.parse(text); }
        catch (e) { throw new ApiClientError('NETWORK', 'Resposta inválida do servidor'); }
      } catch (err) {
        if (err.name === 'AbortError') throw new ApiClientError('TIMEOUT', 'Timeout');
        if (err instanceof ApiClientError) throw err;
        throw new ApiClientError('NETWORK', err.message);
      } finally {
        clearTimeout(timer);
      }
    }

    _fetchJsonp(payload) {
      return new Promise((resolve, reject) => {
        const cbName = '__auraCb' + (++this.jsonpSeq) + '_' + Date.now().toString(36);
        const script = document.createElement('script');
        const cleanup = () => {
          delete root[cbName];
          if (script.parentNode) script.parentNode.removeChild(script);
          clearTimeout(timer);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new ApiClientError('TIMEOUT', 'Timeout JSONP'));
        }, CFG.API.TIMEOUT_MS);

        root[cbName] = data => { cleanup(); resolve(data); };

        const url = this.baseUrl +
          '?callback=' + encodeURIComponent(cbName) +
          '&payload=' + encodeURIComponent(encodeURIComponent(JSON.stringify(payload))) +
          '&_=' + Date.now();

        script.src = url;
        script.onerror = () => { cleanup(); reject(new ApiClientError('NETWORK', 'Falha JSONP')); };
        document.head.appendChild(script);
      });
    }

    /* -------------------------- chamada -------------------------- */

    /**
     * Executa uma ação da API.
     * @param {string} action   ex.: 'match.move'
     * @param {object} params   corpo da requisição
     * @param {object} opts     { auth:boolean, retries:number }
     */
    async call(action, params = {}, opts = {}) {
      if (!this.isConfigured) {
        throw new ApiClientError('NETWORK', 'API_BASE_URL não configurada', true);
      }
      const payload = Object.assign({ action }, params);
      if (opts.auth !== false && this.token) payload.token = this.token;

      const attempts = opts.retries === undefined ? CFG.API.RETRIES : opts.retries;

      const envelope = await retry(async () => {
        const res = this.forceJsonp
          ? await this._fetchJsonp(payload)
          : await this._fetchPost(payload).catch(async err => {
              // Uma falha de rede pode ser CORS: tenta JSONP uma vez e fixa o modo.
              if (err.code === 'NETWORK') {
                const alt = await this._fetchJsonp(payload);
                this.forceJsonp = true;
                return alt;
              }
              throw err;
            });
        return res;
      }, attempts, CFG.API.RETRY_BACKOFF_MS);

      this._setOnline(true);

      if (!envelope || typeof envelope !== 'object') {
        throw new ApiClientError('NETWORK', 'Envelope inválido');
      }
      if (envelope.ok === false) {
        const code = (envelope.error && envelope.error.code) || 'UNKNOWN';
        throw new ApiClientError(code, envelope.error && envelope.error.message,
                                 DOMAIN_ERRORS.has(code));
      }
      return envelope.data;
    }

    /* -------------------------- endpoints -------------------------- */

    ping()                       { return this.call('ping', {}, { auth: false, retries: 0 }); }
    register(username, password) { return this.call('auth.register', { username, password }, { auth: false, retries: 0 }); }
    login(username, password)    { return this.call('auth.login', { username, password }, { auth: false, retries: 0 }); }
    me()                         { return this.call('auth.me'); }

    lobbyHeartbeat()             { return this.call('lobby.heartbeat', {}, { retries: 0 }); }
    lobbyChallenge(targetId)     { return this.call('lobby.challenge', { targetId }); }
    lobbyRespond(challengeId, accept) { return this.call('lobby.respond', { challengeId, accept }); }
    lobbyCancel(challengeId)     { return this.call('lobby.cancel', { challengeId }, { retries: 0 }); }

    queueJoin()                  { return this.call('queue.join'); }
    queuePoll()                  { return this.call('queue.poll', {}, { retries: 0 }); }
    queueLeave()                 { return this.call('queue.leave', {}, { retries: 0 }); }

    matchGet(matchId, version)   { return this.call('match.get', { matchId, version }, { retries: 0 }); }
    matchMove(matchId, from, path, version) {
      return this.call('match.move', { matchId, from, path, version }, { retries: 0 });
    }
    matchResign(matchId)         { return this.call('match.resign', { matchId }); }

    leaderboard(limit = 25)      { return this.call('rank.leaderboard', { limit }, { auth: false }); }
    reportBotResult(won)         { return this.call('bot.report', { won }, { retries: 0 }); }
  }

  root.AuraApi = new ApiClient();
  root.ApiClientError = ApiClientError;
})(typeof self !== 'undefined' ? self : this);
