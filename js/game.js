/**
 * ============================================================================
 *  AURA — GameController
 * ============================================================================
 *  Orquestra tudo: autenticação, menu, campanha, fila, partida (online, rápida
 *  ou de fase), áudio adaptativo, resultado e ranking. A UI só emite
 *  intenções; as regras vivem em rules.js; a rede em api.js/net.js.
 *
 *  Padrões:
 *    - State Machine        (telas + estados de partida)
 *    - Strategy             (MatchSession: Online | Bot | Campanha)
 *    - Observer/EventBus    (desacopla UI de lógica)
 *    - Command              (intenções `ui:action` roteadas por tabela)
 *    - Repository           (CampaignProgress sobre o Storage local)
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG;
  const R = root.AuraRules;
  const I = root.AuraI18n;
  const API = root.AuraApi;
  const BOT = root.AuraBot;
  const AUDIO = root.AuraAudio;
  const ARENAS = root.AuraArenas;
  const { Poller } = root.AuraNet;
  const { Storage, sleep, clamp } = root.AuraUtils;

  /* ================================================================== */
  /* Progresso da campanha (repositório local)                          */
  /* ================================================================== */

  const CampaignProgress = {
    load() {
      const raw = Storage.get('campaign', null);
      const base = { cleared: {}, unlockedUpTo: CFG.CAMPAIGN.UNLOCKED_AT_START };
      if (!raw || typeof raw !== 'object') return base;
      return {
        cleared: raw.cleared || {},
        unlockedUpTo: Math.max(CFG.CAMPAIGN.UNLOCKED_AT_START, raw.unlockedUpTo || 1)
      };
    },
    save(progress) { Storage.set('campaign', progress); },

    /** Registra o resultado de uma fase; devolve a arena recém-liberada. */
    record(order, arenaId, stars) {
      const p = this.load();
      const previous = p.cleared[arenaId] || 0;
      if (stars > previous) p.cleared[arenaId] = stars;

      let unlocked = null;
      if (stars > 0 && order >= p.unlockedUpTo) {
        const nextDef = ARENAS.phaseAt(order + 1);
        if (nextDef) { p.unlockedUpTo = order + 1; unlocked = nextDef; }
      }
      this.save(p);
      return { progress: p, unlocked: unlocked };
    }
  };

  /**
   * Estrelas de uma fase:
   *   1 — vencer
   *   2 — vencer sem perder mais de 1/3 do exército
   *   3 — vencer dentro do orçamento de lances da arena
   */
  function computeStars(state, mySide, arena) {
    if (state.winner !== mySide) return 0;
    let stars = 1;

    const survivors = R.countPieces(state, mySide).total;
    const started = arena.pieces.length / 2;
    if (survivors >= Math.ceil(started * 0.67)) stars++;

    const budget = CFG.CAMPAIGN.STAR_PLY_BUDGET[arena.N] || 100;
    if (state.ply <= budget) stars++;

    return Math.min(3, stars);
  }

  /* ================================================================== */
  /* Sessões de partida (Strategy)                                      */
  /* ================================================================== */

  class MatchSession {
    constructor(ctx) {
      this.ctx = ctx;
      this.bus = ctx.bus;
      this.state = null;
      this.mySide = R.A;
      this.opponentName = '';
      this.opponentElo = 0;
      this.busy = false;
      this.finished = false;
      this.phase = null;                 // preenchido só na campanha
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
    constructor(ctx, options) {
      super(ctx);
      const o = options || {};
      this.level = o.level || BOT.level;
      this.arenaId = o.arenaId || CFG.BOARD.DEFAULT_ARENA;
      this.phase = o.phase || null;
      // Na campanha o jogador é sempre A (embaixo): o aprendizado precisa de
      // um ponto de vista estável. No jogo rápido, o lado é sorteado.
      this.mySide = o.playerSide || (this.phase ? R.A : (Math.random() < 0.5 ? R.A : R.B));
      this.botSide = R.opponent(this.mySide);
      this.opponentName = BOT.generateName(Date.now());
      this.opponentElo = BOT.estimatedElo();
      this.ranked = false;
    }

    async start() {
      BOT.setLevel(this.level);
      BOT.init();
      this.state = R.createInitialState(this.arenaId);
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
        ranking: null,
        phase: this.phase,
        state: state
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
        sideLetter: this.sideLetter,
        state: state
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
      this.lastResult = null;
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
      this.ui.renderCampaign(CampaignProgress.load());
      this.ui.showScreen('home');
      AUDIO.setMood('menu');
      AUDIO.setIntensity(0.15);
      AUDIO.startMusic('menu');
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
        'home.campaign':    () => this.openCampaign(),
        'home.codex':       () => this.ui.showScreen('codex'),
        'home.ranking':     () => this.openRanking(),
        'home.tutorial':    () => this.tutorial.start(() => this.goHome()),
        'home.logout':      () => this.logout(),
        'home.setLevel':    ({ value }) => this.setLevel(value),
        'campaign.play':    ({ value }) => this.startPhase(Number(value)),
        'campaign.locked':  () => this.ui.toast(I.t('campaign.lockedHint'), 'warn'),
        'queue.cancel':     () => this.cancelQueue(),
        'game.resign':      () => this.confirmResign(),
        'game.back':        () => this.leaveMatch(),
        'result.rematch':   () => this.rematch(),
        'result.next':      () => this.playNextPhase(),
        'result.home':      () => { this.ui.hideResult(); this.leaveMatch(); },
        'nav.home':         () => { this.ui.hideResult(); this.goHome(); },
        'nav.campaign':     () => { this.ui.hideResult(); this.openCampaign(); },
        'tutorial.skip':    () => {
          this.tutorial.stop();
          Storage.set('tutorialDone', true);
          this.goHome();
        }
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
      this.bus.on('ui:audioUnlocked', () => {
        AUDIO.startMusic(this.session ? 'battle' : 'menu');
      });
      this.bus.on('ui:languageChanged', () => {
        this.ui.setAuthMode(this.authMode);
        if (this.user) this.ui.renderProfile(this.user);
        this.ui.renderCampaign(CampaignProgress.load());
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

    /* --------------------------- campanha --------------------------- */

    openCampaign() {
      this.ui.renderCampaign(CampaignProgress.load());
      this.ui.showScreen('campaign');
    }

    async startPhase(order) {
      const def = ARENAS.phaseAt(order);
      if (!def) return;
      const progress = CampaignProgress.load();
      if (order > progress.unlockedUpTo) {
        this.ui.toast(I.t('campaign.lockedHint'), 'warn');
        return;
      }

      this.disposeSession();
      this.session = new BotMatchSession(this, {
        level: def.level,
        arenaId: def.id,
        phase: { order: def.order, id: def.id }
      });
      this.ui.showScreen('game');
      AUDIO.play('phase');
      await this.session.start();
      this.ui.board.intro();
    }

    playNextPhase() {
      this.ui.hideResult();
      const phase = this.lastResult && this.lastResult.phase;
      if (!phase) return this.goHome();
      const next = ARENAS.phaseAt(phase.order + 1);
      if (!next) { this.goHome(); return; }
      this.startPhase(next.order);
    }

    /* ----------------------------- fila ----------------------------- */

    async startQueue() {
      // Online exige conta: convidado não tem identidade para a fila.
      if (this.guest || !API.isConfigured) {
        this.ui.toast(I.t(API.isConfigured ? 'queue.needAccount' : 'auth.offlineHint'), 'warn');
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

      // Entrar na fila: um erro passageiro (servidor ocupado porque o outro
      // jogador entrou no mesmo segundo, ou o Apps Script "acordando") NÃO
      // manda mais para a IA. Tenta de novo até o relógio de 30s vencer.
      let joined = false;
      while (!joined && this.queue && !this.queue.closed) {
        try {
          const res = await API.queueJoin();
          if (!this.queue || this.queue.closed) return;
          if (res.status === 'matched') return this.enterOnlineMatch(res.matchId, res.side);
          this.queue.size = res.queueSize || 1;
          joined = true;
        } catch (err) {
          if (err && (err.code === 'EXPIRED_TOKEN' || err.code === 'BAD_TOKEN')) {
            this._closeQueue();
            return this.handleNetworkError(err);
          }
          await sleep(1200);
        }
      }
      if (!this.queue || this.queue.closed) return;

      this.queue.poller = new Poller(async () => {
        if (!this.queue || this.queue.closed) return;
        const res = await API.queuePoll();
        if (!this.queue || this.queue.closed) return;
        if (res.status === 'matched') {
          this.ui.toast(I.t('queue.matched'), 'good');
          this.enterOnlineMatch(res.matchId, res.side);
        } else if (res.status === 'waiting') {
          this.queue.size = res.queueSize || 1;
        }
      }, {
        interval: CFG.NET.QUEUE_POLL_MS,
        name: 'queue',
        // erros de polling são silenciosos: o próximo tique tenta de novo
        onError: err => { if (err && (err.code === 'EXPIRED_TOKEN' || err.code === 'BAD_TOKEN')) this.handleNetworkError(err); }
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
      this.session = new BotMatchSession(this, {
        level: this.level,
        arenaId: CFG.BOARD.DEFAULT_ARENA
      });
      this.ui.showScreen('game');
      await this.session.start();
      this.ui.board.intro();
    }

    async enterOnlineMatch(matchId, side) {
      this._closeQueue();
      this.disposeSession();
      this.session = new OnlineMatchSession(this, { matchId, side });
      this.ui.showScreen('game');
      try {
        await this.session.start();
        this.ui.board.intro();
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

      const me = this.user
        ? { name: this.user.username, elo: this.user.elo }
        : { name: I.t('common.you'), elo: 1000 };
      const foe = { name: session.opponentName, elo: session.opponentElo };

      this.ui.renderMatchHeader({
        you: session.mySide === R.A ? 'A' : 'B',
        players: session.players || (session.mySide === R.A ? { A: me, B: foe } : { A: foe, B: me }),
        botName: session.opponentName,
        arena: session.state ? session.state.arena : null
      });

      AUDIO.setMood('battle');
      AUDIO.startMusic('battle');
    }

    /**
     * Sequência de uma jogada na tela, na MESMA ordem do motor:
     * deslocamento → irradiação → pulso de cerco → estilhaçar.
     */
    async onMatchState({ state, animate, prev, move }) {
      const board = this.ui.board;
      this.selected = null;
      board.clearSelection();

      if (animate && prev && move) {
        board.setLocked(true);
        await board.animateMove(prev, move);

        const radiated = move.radiated || [];
        if (radiated.length) await board.radiate(move.to, radiated, move.by || state.turn);

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
      this._updateTension(state);
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

    /**
     * Converte a situação do tabuleiro em intensidade musical (0..1) e avisa
     * quando o Núcleo do jogador está com uma respiração só.
     */
    _updateTension(state) {
      if (!this.session) return;
      const mySide = this.session.mySide;
      const arena = state.arena;

      const t = R.territoryCount(state);
      const lead = Math.max(t[R.A], t[R.B]) / arena.territoryThreshold;
      const progress = clamp(state.ply / arena.maxPlies, 0, 1);

      const myCore = R.coreIndex(state, mySide);
      let coreDanger = false;
      if (myCore >= 0) {
        const lib = root.AuraAI.groupLiberties(state, myCore, R.opponent(mySide));
        coreDanger = lib <= 1;
        this.ui.board.markCoreDanger(myCore, lib <= 1);
        if (coreDanger && !this._warnedCore) {
          this._warnedCore = true;
          AUDIO.play('coreWarn');
          this.ui.toast(I.t('game.coreWarning'), 'warn');
        } else if (!coreDanger) {
          this._warnedCore = false;
        }
      }

      AUDIO.setIntensity(clamp(lead * 0.6 + progress * 0.25 + (coreDanger ? 0.35 : 0), 0, 1));
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
        root.AuraAudio.play('deselect');
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

    onMatchEnd({ winner, reason, mySide, ranked, ranking, sideLetter, phase, state }) {
      this.ui.board.setLocked(true);
      this.ui.board.markCoreDanger(-1, false);
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

      // --- campanha: estrelas, desbloqueio e botão "próxima fase" -----
      let stars = null, hasNext = false;
      if (phase && state) {
        const arena = state.arena;
        stars = computeStars(state, mySide, arena);
        const result = CampaignProgress.record(phase.order, phase.id, stars);
        this.ui.renderCampaign(result.progress);

        const nextDef = ARENAS.phaseAt(phase.order + 1);
        hasNext = !!nextDef && result.progress.unlockedUpTo >= phase.order + 1;

        if (result.unlocked) {
          setTimeout(() => {
            AUDIO.play('unlock');
            this.ui.toast(I.t('campaign.unlocked', { name: I.t('arena.' + result.unlocked.id) }), 'good');
          }, 1400);
        } else if (stars > 0 && !nextDef) {
          setTimeout(() => this.ui.toast(I.t('campaign.allClear'), 'good'), 1400);
        }
      }

      this.lastResult = { outcome, phase: phase || null };
      AUDIO.setIntensity(0.2);
      AUDIO.setMood(outcome === 'win' ? 'victory' : outcome === 'loss' ? 'defeat' : 'menu');

      setTimeout(() => this.ui.showResult({ outcome, reason, elo, delta, stars, hasNext }), 560);
    }

    rematch() {
      this.ui.hideResult();
      const wasOnline = this.session instanceof OnlineMatchSession;
      const phase = this.session && this.session.phase;
      this.disposeSession();
      if (phase) this.startPhase(phase.order);
      else if (wasOnline) this.startQueue();
      else this.startBotMatch();
    }

    leaveMatch() {
      const wasPhase = !!(this.session && this.session.phase);
      this.disposeSession();
      if (wasPhase) this.openCampaign(); else this.goHome();
    }

    disposeSession() {
      if (this.session) { this.session.dispose(); this.session = null; }
      this.thinking = false;
      this.selected = null;
      this._warnedCore = false;
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

  root.AuraGame = {
    GameController, MatchSession, BotMatchSession, OnlineMatchSession,
    CampaignProgress, computeStars
  };
})(typeof self !== 'undefined' ? self : this);
