/**
 * ============================================================================
 *  AURA — GameController
 * ============================================================================
 *  Orquestra tudo: autenticação, menu, fila, partida (online ou IA), resultado
 *  e ranking. A UI só emite intenções; as regras vivem em rules.js; a rede em
 *  api.js/net.js. Este arquivo é a cola — e a única peça que conhece o fluxo.
 *
 *  Padrões:
 *    - State Machine        (screens + estados de partida)
 *    - Strategy             (MatchSession: Online vs. Bot)
 *    - Observer/EventBus    (desacopla UI de lógica)
 *    - Command              (intenções `ui:action` roteadas por tabela)
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG;
  const R = root.AuraRules;
  const I = root.AuraI18n;
  const API = root.AuraApi;
  const BOT = root.AuraBot;
  const { Poller } = root.AuraNet;
  const { Storage, sleep, formatDuration } = root.AuraUtils;

  /* ================================================================== */
  /* Sessões de partida (Strategy)                                      */
  /* ================================================================== */

  class MatchSession {
    constructor(ctx) {
      this.ctx = ctx;              // GameController
      this.bus = ctx.bus;
      this.state = null;
      this.mySide = R.A;
      this.opponentName = '';
      this.opponentElo = 0;
      this.busy = false;
      this.finished = false;
    }
    get myPlayer() { return this.mySide; }
    get isMyTurn() { return this.state && this.state.turn === this.mySide && !this.busy; }
    async start() { throw new Error('abstract'); }
    async submitMove() { throw new Error('abstract'); }
    async resign() { throw new Error('abstract'); }
    dispose() {}
  }

  /* ------------------------- Partida contra a IA -------------------- */

  class BotMatchSession extends MatchSession {
    constructor(ctx, { level, playerSide } = {}) {
      super(ctx);
      this.level = level || BOT.level;
      this.mySide = playerSide || (Math.random() < 0.5 ? R.A : R.B);
      this.botSide = R.opponent(this.mySide);
      this.opponentName = BOT.generateName(Date.now());
      this.opponentElo = BOT.estimatedElo();
      this.ranked = false;
    }

    async start() {
      BOT.setLevel(this.level);
      BOT.init();
      this.state = R.createInitialState();
      this.bus.emit('match:ready', this);
      this.bus.emit('match:state', { state: this.state, animate: false });
      if (this.state.turn === this.botSide) this._botTurn();
    }

    async submitMove(move) {
      if (!this.isMyTurn || this.finished) return;
      this.busy = true;
      const prev = this.state;
      const next = R.applyMove(prev, move);
      this.state = next;
      this.bus.emit('match:state', { state: next, animate: true, prev, move });
      this.busy = false;

      if (next.status === 'finished') return this._end(next);
      this._botTurn();
    }

    async _botTurn() {
      if (this.finished) return;
      this.busy = true;
      this.bus.emit('match:thinking', true);
      try {
        const move = await BOT.think(this.state, this.botSide);
        this.bus.emit('match:thinking', false);
        if (!move || this.finished) return;

        const prev = this.state;
        const next = R.applyMove(prev, move);
        this.state = next;
        this.busy = false;
        this.bus.emit('match:state', { state: next, animate: true, prev, move });
        if (next.status === 'finished') this._end(next);
      } catch (err) {
        console.error('[bot]', err);
        this.bus.emit('match:thinking', false);
        this.busy = false;
      }
    }

    async resign() {
      const next = R.cloneState(this.state);
      next.status = 'finished';
      next.winner = this.botSide;
      next.reason = 'resign';
      this.state = next;
      this._end(next);
    }

    _end(state) {
      if (this.finished) return;
      this.finished = true;
      this.bus.emit('match:end', {
        winner: state.winner,
        reason: state.reason,
        mySide: this.mySide,
        ranked: false,
        ranking: null
      });
    }

    dispose() { this.finished = true; }
  }

  /* ------------------------- Partida online ------------------------- */

  class OnlineMatchSession extends MatchSession {
    constructor(ctx, { matchId, side }) {
      super(ctx);
      this.matchId = matchId;
      this.mySide = side === 'A' ? R.A : R.B;
      this.sideLetter = side;
      this.version = 0;
      this.poller = null;
      this.players = null;
      this.pendingSync = false;
    }

    async start() {
      const dto = await API.matchGet(this.matchId, null);
      this._ingest(dto, { animate: false });
      this.bus.emit('match:ready', this);

      this.poller = new Poller(() => this._pollOnce(), {
        interval: CFG.NET.MATCH_POLL_MS,
        name: 'match',
        onError: err => this.ctx.handleNetworkError(err)
      }).start(false);
    }

    async _pollOnce() {
      if (this.finished) return;
      const dto = await API.matchGet(this.matchId, this.version);
      if (dto.changed === false) return;
      this._ingest(dto, { animate: true });
    }

    _ingest(dto, { animate }) {
      if (!dto || !dto.state) return;
      const prev = this.state;
      const next = R.deserialize(dto.state);

      this.version = dto.version;
      if (dto.players) {
        this.players = dto.players;
        const foe = this.sideLetter === 'A' ? dto.players.B : dto.players.A;
        this.opponentName = foe.name;
        this.opponentElo = foe.elo;
      }

      const isNewPly = !prev || next.ply > prev.ply;
      this.state = next;

      this.bus.emit('match:state', {
        state: next,
        animate: animate && isNewPly && !!next.lastMove,
        prev,
        move: next.lastMove,
        players: this.players,
        you: this.sideLetter
      });

      if (next.status === 'finished' || dto.status === 'finished') {
        this._end(next, dto.ranking);
      }
    }

    async submitMove(move) {
      if (!this.isMyTurn || this.finished) return;
      this.busy = true;

      // Aplicação otimista: o tabuleiro responde na hora, o servidor confirma.
      const prev = this.state;
      const optimistic = R.applyMove(prev, move);
      this.state = optimistic;
      this.bus.emit('match:state', { state: optimistic, animate: true, prev, move, optimistic: true });

      try {
        const dto = await API.matchMove(this.matchId, move.from, move.path, this.version);
        this._ingest(dto, { animate: false });
      } catch (err) {
        if (err.code === 'STALE_STATE' || err.code === 'ILLEGAL_MOVE' || err.code === 'NOT_YOUR_TURN') {
          this.ctx.ui.toast(I.error(err.code), 'warn');
          const fresh = await API.matchGet(this.matchId, null).catch(() => null);
          if (fresh) this._ingest(fresh, { animate: false });
        } else {
          this.ctx.handleNetworkError(err);
          this.state = prev;                       // desfaz o otimismo
          this.bus.emit('match:state', { state: prev, animate: false });
        }
      } finally {
        this.busy = false;
        if (this.poller) this.poller.poke();
      }
    }

    async resign() {
      try {
        const dto = await API.matchResign(this.matchId);
        this._ingest(dto, { animate: false });
      } catch (err) {
        this.ctx.handleNetworkError(err);
      }
    }

    _end(state, ranking) {
      if (this.finished) return;
      this.finished = true;
      if (this.poller) this.poller.stop();
      this.bus.emit('match:end', {
        winner: state.winner,
        reason: state.reason,
        mySide: this.mySide,
        ranked: true,
        ranking: ranking || null,
        sideLetter: this.sideLetter
      });
    }

    dispose() {
      this.finished = true;
      if (this.poller) this.poller.stop();
    }
  }

  /* ================================================================== */
  /* GameController                                                     */
  /* ================================================================== */

  class GameController {
    constructor(ui, bus) {
      this.ui = ui;
      this.bus = bus;
      this.user = null;
      this.session = null;
      this.authMode = 'login';
      this.level = Storage.get('aiLevel', CFG.AI.DEFAULT_LEVEL);
      this.selected = null;
      this.queue = null;
      this.tutorial = new root.AuraTutorial(ui, bus);
      this.guest = false;
      this._wire();
    }

    /* ----------------------------- boot ----------------------------- */

    async boot() {
      this.ui.showScreen('boot');
      this.ui.setLevel(this.level);
      BOT.setLevel(this.level);
      BOT.init();

      const token = Storage.get('token', null);
      if (token && API.isConfigured) {
        API.setToken(token);
        try {
          const data = await API.me();
          this.user = data.user;
          this.ui.renderProfile(this.user);
          await this._afterLogin();
          return;
        } catch (err) {
          API.setToken(null);
        }
      }
      await sleep(400);
      this.ui.showScreen('auth');
      this.ui.setAuthMode(this.authMode);
    }

    async _afterLogin() {
      if (!Storage.get('tutorialDone', false)) {
        this.tutorial.start(() => this.goHome());
        return;
      }
      this.goHome();
    }

    goHome() {
      this.ui.renderProfile(this.user || {
        username: I.t('common.you'), elo: '—', division: 'iron', wins: 0, losses: 0
      });
      this.ui.showScreen('home');
    }

    /* --------------------------- roteamento -------------------------- */

    _wire() {
      const actions = {
        'auth.submit':      () => this.handleAuthSubmit(),
        'auth.switch':      ({ el }) => {
          this.authMode = el.dataset.value || 'register';
          this.ui.setAuthMode(this.authMode);
          this.ui.setAuthError(null);
        },
        'auth.offline':     () => this.playAsGuest(),
        'home.playOnline':  () => this.startQueue(),
        'home.playBot':     () => this.startBotMatch(),
        'home.ranking':     () => this.openRanking(),
        'home.tutorial':    () => this.tutorial.start(() => this.goHome()),
        'home.logout':      () => this.logout(),
        'home.setLevel':    ({ value }) => this.setLevel(value),
        'queue.cancel':     () => this.cancelQueue(),
        'game.resign':      () => this.confirmResign(),
        'game.back':        () => this.leaveMatch(),
        'result.rematch':   () => this.rematch(),
        'result.home':      () => { this.ui.hideResult(); this.leaveMatch(); },
        'nav.home':         () => { this.ui.hideResult(); this.goHome(); },
        'tutorial.skip':    () => { this.tutorial.stop(); Storage.set('tutorialDone', true); this.goHome(); }
      };

      this.bus.on('ui:action', payload => {
        const fn = actions[payload.action];
        if (fn) fn(payload);
      });

      this.bus.on('ui:cellTap', index => this.handleCellTap(index));
      this.bus.on('match:ready', session => this.onMatchReady(session));
      this.bus.on('match:state', payload => this.onMatchState(payload));
      this.bus.on('match:thinking', flag => this.onThinking(flag));
      this.bus.on('match:end', payload => this.onMatchEnd(payload));
      this.bus.on('connection:change', online => this.ui.setConnection(online));
      this.bus.on('ui:languageChanged', () => {
        this.ui.setAuthMode(this.authMode);
        if (this.user) this.ui.renderProfile(this.user);
        if (this.session && this.session.state) this.refreshHud();
      });
    }

    /* ----------------------------- auth ----------------------------- */

    async handleAuthSubmit() {
      const username = this.ui.els.authUser.value.trim();
      const password = this.ui.els.authPass.value;
      this.ui.setAuthError(null);

      if (!API.isConfigured) {
        this.ui.setAuthError('NETWORK');
        this.ui.toast(I.t('auth.offlineHint'), 'warn');
        return;
      }

      this.ui.setAuthBusy(true);
      try {
        const data = this.authMode === 'register'
          ? await API.register(username, password)
          : await API.login(username, password);
        API.setToken(data.token);
        this.user = data.user;
        this.guest = false;
        this.ui.els.authPass.value = '';
        await this._afterLogin();
      } catch (err) {
        this.ui.setAuthError(err.code || 'UNKNOWN');
      } finally {
        this.ui.setAuthBusy(false);
      }
    }

    playAsGuest() {
      this.guest = true;
      this.user = { username: I.t('common.you'), elo: 1000, division: 'iron', wins: 0, losses: 0 };
      this._afterLogin();
    }

    logout() {
      API.setToken(null);
      Storage.remove('token');
      this.user = null;
      this.guest = false;
      this.ui.showScreen('auth');
      this.ui.setAuthMode(this.authMode);
    }

    setLevel(level) {
      if (!CFG.AI.LEVELS[level]) return;
      this.level = level;
      Storage.set('aiLevel', level);
      BOT.setLevel(level);
      this.ui.setLevel(level);
    }

    /* ----------------------------- fila ----------------------------- */

    async startQueue() {
      if (this.guest || !API.isConfigured) {
        this.ui.toast(I.t('auth.offlineHint'), 'warn');
        return this.startBotMatch();
      }

      this.queue = { startedAt: Date.now(), size: 1, poller: null, ticker: null, closed: false };
      this.ui.showScreen('queue');
      this.ui.renderQueue({ elapsedMs: 0, queueSize: 1, botInMs: CFG.NET.BOT_FALLBACK_MS });

      this.queue.ticker = setInterval(() => {
        if (!this.queue || this.queue.closed) return;
        const elapsed = Date.now() - this.queue.startedAt;
        this.ui.renderQueue({
          elapsedMs: elapsed,
          queueSize: this.queue.size,
          botInMs: CFG.NET.BOT_FALLBACK_MS - elapsed
        });
        if (elapsed >= CFG.NET.BOT_FALLBACK_MS) this.fallbackToBot();
      }, 250);

      try {
        const res = await API.queueJoin();
        if (res.status === 'matched') return this.enterOnlineMatch(res.matchId, res.side);
        this.queue.size = res.queueSize || 1;
      } catch (err) {
        this.handleNetworkError(err);
        return this.fallbackToBot();
      }

      this.queue.poller = new Poller(async () => {
        if (!this.queue || this.queue.closed) return;
        const res = await API.queuePoll();
        if (res.status === 'matched') {
          this.ui.toast(I.t('queue.matched'), 'good');
          this.enterOnlineMatch(res.matchId, res.side);
        } else if (res.status === 'waiting') {
          this.queue.size = res.queueSize || 1;
        }
      }, {
        interval: CFG.NET.QUEUE_POLL_MS,
        name: 'queue',
        onError: err => this.handleNetworkError(err)
      }).start(false);
    }

    _closeQueue() {
      if (!this.queue) return;
      this.queue.closed = true;
      clearInterval(this.queue.ticker);
      if (this.queue.poller) this.queue.poller.stop();
      this.queue = null;
    }

    async cancelQueue() {
      this._closeQueue();
      try { await API.queueLeave(); } catch (e) { /* silencioso */ }
      this.goHome();
    }

    async fallbackToBot() {
      if (!this.queue) return;
      this.ui.renderQueue({ elapsedMs: CFG.NET.BOT_FALLBACK_MS, queueSize: this.queue.size, botInMs: 0 });
      this._closeQueue();
      try { await API.queueLeave(); } catch (e) {}
      await sleep(600);
      this.startBotMatch();
    }

    /* --------------------------- partidas --------------------------- */

    async startBotMatch() {
      this.disposeSession();
      this.session = new BotMatchSession(this, { level: this.level });
      this.ui.showScreen('game');
      await this.session.start();
    }

    async enterOnlineMatch(matchId, side) {
      this._closeQueue();
      this.disposeSession();
      this.session = new OnlineMatchSession(this, { matchId, side });
      this.ui.showScreen('game');
      try {
        await this.session.start();
      } catch (err) {
        this.handleNetworkError(err);
        this.goHome();
      }
    }

    onMatchReady(session) {
      this.selected = null;
      this.ui.board.setPerspective(session.mySide);
      this.ui.board.clearSelection();
      this.ui.hideResult();
      this.ui.renderMatchHeader({
        you: session.mySide === R.A ? 'A' : 'B',
        players: session.players || {
          A: session.mySide === R.A
            ? { name: this.user ? this.user.username : I.t('common.you'), elo: this.user ? this.user.elo : 1000 }
            : { name: session.opponentName, elo: session.opponentElo },
          B: session.mySide === R.B
            ? { name: this.user ? this.user.username : I.t('common.you'), elo: this.user ? this.user.elo : 1000 }
            : { name: session.opponentName, elo: session.opponentElo }
        },
        botName: session.opponentName
      });
    }

    async onMatchState({ state, animate, prev, move }) {
      const board = this.ui.board;
      this.selected = null;
      board.clearSelection();

      if (animate && prev && move) {
        board.setLocked(true);
        await board.animateMove(prev, move);

        const siege = move.siegeCaptures || [];
        const jumps = move.jumpCaptures || move.captures || [];
        if (siege.length) await board.siegePulse(siege, move.by || state.turn);
        const removed = jumps.concat(siege);
        if (removed.length) await board.shatter(removed, move.by || R.A);
      }

      board.render(state, { force: !animate });
      board.markLastMove(state.lastMove);
      board.setLocked(state.status !== 'playing' || !this.session || !this.session.isMyTurn);
      this.refreshHud();
    }

    onThinking(flag) {
      this.thinking = flag;
      this.ui.board.setLocked(flag || !(this.session && this.session.isMyTurn));
      this.refreshHud();
    }

    refreshHud() {
      if (!this.session || !this.session.state) return;
      this.ui.renderHud(this.session.state, {
        mySide: this.session.mySide,
        opponentName: this.session.opponentName || I.t('common.bot'),
        thinking: !!this.thinking
      });
    }

    /* --------------------- interação com o tabuleiro ----------------- */

    handleCellTap(index) {
      if (this.tutorial.active) return this.tutorial.handleTap(index);
      const s = this.session;
      if (!s || !s.state || s.state.status !== 'playing') return;
      if (!s.isMyTurn) { this.ui.toast(I.t('error.NOT_YOUR_TURN'), 'warn'); return; }

      const state = s.state;
      const board = this.ui.board;

      if (this.selected === null) {
        if (R.ownerOf(state.board[index]) !== s.mySide) {
          if (state.board[index]) board.flashInvalid(index);
          return;
        }
        const targets = R.targetsFor(state, index);
        if (!targets.size) { board.flashInvalid(index); return; }
        this.selected = index;
        board.select(index, targets);
        return;
      }

      if (index === this.selected) {
        this.selected = null;
        board.clearSelection();
        return;
      }

      // Trocar a peça selecionada
      if (R.ownerOf(state.board[index]) === s.mySide) {
        const targets = R.targetsFor(state, index);
        if (targets.size) { this.selected = index; board.select(index, targets); return; }
      }

      const move = board.targets.get(index);
      if (!move) { board.flashInvalid(index); return; }

      this.selected = null;
      board.clearSelection();
      s.submitMove(move);
    }

    /* ----------------------------- fim ------------------------------ */

    async confirmResign() {
      const ok = await this.ui.confirm(I.t('game.resignConfirm'));
      if (!ok || !this.session) return;
      await this.session.resign();
    }

    onMatchEnd({ winner, reason, mySide, ranked, ranking, sideLetter }) {
      this.ui.board.setLocked(true);
      const outcome = winner === 0 || winner === null ? 'draw'
                    : (winner === mySide ? 'win' : 'loss');

      let elo = null, delta = null;
      if (ranked && ranking && sideLetter && ranking[sideLetter]) {
        elo = ranking[sideLetter].elo;
        delta = ranking[sideLetter].delta;
        if (this.user) {
          this.user.elo = elo;
          this.user.division = ranking[sideLetter].division;
          this.user.wins += outcome === 'win' ? 1 : 0;
          this.user.losses += outcome === 'loss' ? 1 : 0;
          this.ui.renderProfile(this.user);
        }
      }

      if (!ranked && this.user && !this.guest) {
        API.reportBotResult(outcome === 'win').catch(() => {});
      }

      setTimeout(() => this.ui.showResult({ outcome, reason, elo, delta }), 520);
    }

    rematch() {
      this.ui.hideResult();
      const wasOnline = this.session instanceof OnlineMatchSession;
      this.disposeSession();
      if (wasOnline) this.startQueue(); else this.startBotMatch();
    }

    leaveMatch() {
      this.disposeSession();
      this.goHome();
    }

    disposeSession() {
      if (this.session) { this.session.dispose(); this.session = null; }
      this.thinking = false;
      this.selected = null;
    }

    /* --------------------------- ranking ---------------------------- */

    async openRanking() {
      this.ui.showScreen('rank');
      this.ui.renderLeaderboard(null);
      if (!API.isConfigured) return;
      try {
        const data = await API.leaderboard(30);
        this.ui.renderLeaderboard(data.entries, this.user && this.user.username);
      } catch (err) {
        this.handleNetworkError(err);
      }
    }

    /* ---------------------------- erros ----------------------------- */

    handleNetworkError(err) {
      const code = (err && err.code) || 'UNKNOWN';
      if (code === 'EXPIRED_TOKEN' || code === 'BAD_TOKEN') {
        this.ui.toast(I.error(code), 'bad');
        this.logout();
        return;
      }
      if (code === 'NETWORK' || code === 'TIMEOUT') {
        this.ui.setConnection(false);
        setTimeout(() => this.ui.setConnection(true), 4000);
      }
      this.ui.toast(I.error(code), 'bad');
    }
  }

  root.AuraGame = { GameController, MatchSession, BotMatchSession, OnlineMatchSession };
})(typeof self !== 'undefined' ? self : this);
