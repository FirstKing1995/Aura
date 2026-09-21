/**
 * ============================================================================
 *  AURA — Camada de Apresentação
 * ============================================================================
 *  Responsabilidades:
 *    BoardView   — desenha o grid 9x9, aplica diffs, anima movimento, salto,
 *                  estilhaçamento e pulso de cerco.
 *    UIManager   — roteia telas, atualiza HUD, exibe toasts/modais, lista
 *                  ranking e cuida da troca de idioma.
 *
 *  A UI nunca decide regras: ela recebe estados prontos do GameController e
 *  emite intenções pelo EventBus (`ui:cellTap`, `ui:action`).
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG;
  const R = root.AuraRules;
  const I = root.AuraI18n;
  const { $, $$, el, sleep, haptic, clamp, prefersReducedMotion, formatDuration } = root.AuraUtils;

  /* ================================================================== */
  /* BoardView                                                          */
  /* ================================================================== */

  class BoardView {
    constructor(container, bus) {
      this.root = container;
      this.bus = bus;
      this.cells = [];
      this.pieces = new Map();          // índice -> elemento .piece
      this.lastBoard = null;
      this.lastAura = null;
      this.selected = null;
      this.targets = new Map();
      this.perspective = R.A;           // lado que fica embaixo na tela
      this.locked = false;
      this._build();
    }

    _build() {
      this.root.innerHTML = '';
      this.root.classList.add('board');
      const grid = el('div', { class: 'board__grid', role: 'grid', 'aria-label': 'Aura' });

      for (let i = 0; i < R.SIZE; i++) {
        const cell = el('button', {
          class: 'cell',
          type: 'button',
          'data-i': i,
          role: 'gridcell',
          'aria-label': `${String.fromCharCode(65 + R.colOf(i))}${9 - R.rowOf(i)}`
        }, [
          el('span', { class: 'cell__aura' }),
          el('span', { class: 'cell__marker' })
        ]);
        cell.addEventListener('click', () => this._onCellTap(i));
        this.cells.push(cell);
        grid.appendChild(cell);
      }

      this.grid = grid;
      this.fx = el('div', { class: 'board__fx', 'aria-hidden': 'true' });
      this.root.appendChild(grid);
      this.root.appendChild(this.fx);
    }

    setPerspective(side) {
      this.perspective = side;
      this.root.classList.toggle('board--flipped', side === R.B);
    }

    setLocked(locked) {
      this.locked = locked;
      this.root.classList.toggle('board--locked', locked);
    }

    _onCellTap(index) {
      if (this.locked) return;
      this.bus.emit('ui:cellTap', index);
    }

    /* ----------------------- render / diff ----------------------- */

    /** Renderiza o estado inteiro aplicando apenas as diferenças. */
    render(state, { force = false } = {}) {
      const board = state.board, aura = state.aura;

      for (let i = 0; i < R.SIZE; i++) {
        const cell = this.cells[i];

        if (force || !this.lastAura || this.lastAura[i] !== aura[i]) {
          cell.dataset.aura = aura[i] || '';
        }

        if (force || !this.lastBoard || this.lastBoard[i] !== board[i]) {
          this._renderPiece(i, board[i]);
        }
      }

      this.lastBoard = board.slice();
      this.lastAura = aura.slice();
      this._updateDominance(state);
    }

    _renderPiece(index, code) {
      const cell = this.cells[index];
      const existing = this.pieces.get(index);
      if (existing) { existing.remove(); this.pieces.delete(index); }
      if (!code) return;

      const owner = R.ownerOf(code);
      const piece = el('span', {
        class: `piece piece--${owner === R.A ? 'a' : 'b'} ${R.isCore(code) ? 'piece--core' : 'piece--sentinel'}`
      }, [
        el('span', { class: 'piece__body' }),
        el('span', { class: 'piece__glow' })
      ]);
      cell.appendChild(piece);
      this.pieces.set(index, piece);
    }

    _updateDominance(state) {
      const t = R.territoryCount(state);
      const leader = t[R.A] === t[R.B] ? 0 : (t[R.A] > t[R.B] ? R.A : R.B);
      const ratio = Math.max(t[R.A], t[R.B]) / R.SIZE;
      this.root.dataset.dominant = ratio > 0.45 ? (leader === R.A ? 'a' : 'b') : '';
      this.root.style.setProperty('--dominance', ratio.toFixed(3));
    }

    /* ----------------------- seleção ----------------------- */

    select(index, targets) {
      this.clearSelection();
      this.selected = index;
      this.targets = targets || new Map();

      const piece = this.pieces.get(index);
      if (piece) piece.classList.add('piece--lifted');
      this.cells[index].classList.add('cell--selected');

      this.targets.forEach((move, to) => {
        this.cells[to].classList.add('cell--target');
        if (move.captures.length) this.cells[to].classList.add('cell--target-capture');
        move.captures.forEach(c => this.cells[c].classList.add('cell--doomed'));
      });
      haptic(8);
    }

    clearSelection() {
      if (this.selected !== null) {
        const p = this.pieces.get(this.selected);
        if (p) p.classList.remove('piece--lifted');
      }
      this.selected = null;
      this.targets = new Map();
      this.cells.forEach(c => {
        c.classList.remove('cell--selected', 'cell--target', 'cell--target-capture', 'cell--doomed');
      });
    }

    highlight(indices, className = 'cell--hint') {
      this.cells.forEach(c => c.classList.remove(className));
      (indices || []).forEach(i => this.cells[i] && this.cells[i].classList.add(className));
    }

    markLastMove(move) {
      this.cells.forEach(c => c.classList.remove('cell--last-from', 'cell--last-to'));
      if (!move) return;
      if (this.cells[move.from]) this.cells[move.from].classList.add('cell--last-from');
      if (this.cells[move.to]) this.cells[move.to].classList.add('cell--last-to');
    }

    /* ----------------------- animações ----------------------- */

    _centerOf(index) {
      const cell = this.cells[index];
      return { x: cell.offsetLeft + cell.offsetWidth / 2, y: cell.offsetTop + cell.offsetHeight / 2 };
    }

    /**
     * Anima o deslocamento da peça ao longo do caminho (um trecho por salto),
     * pintando a aura conforme passa. Resolve quando a peça chega ao destino.
     */
    async animateMove(state, move) {
      if (prefersReducedMotion()) return;
      const piece = this.pieces.get(move.from);
      if (!piece) return;

      const owner = R.ownerOf(state.board[move.from]);
      const origin = this._centerOf(move.from);
      piece.style.zIndex = '40';
      piece.classList.add('piece--moving');

      const stepMs = move.type === 'jump' ? 220 : CFG.UI.MOVE_ANIM_MS;

      for (let s = 0; s < move.path.length; s++) {
        const target = this._centerOf(move.path[s]);
        const dx = target.x - origin.x;
        const dy = target.y - origin.y;

        if (move.type === 'jump') piece.classList.add('piece--arc');
        piece.style.transition = `transform ${stepMs}ms cubic-bezier(.34,1.3,.4,1)`;
        piece.style.transform = `translate(${dx}px, ${dy}px) translateZ(26px)`;

        // pinta a trilha no meio do trajeto
        setTimeout(() => {
          this.cells[move.path[s]].dataset.aura = owner;
          this.cells[move.path[s]].classList.add('cell--painted');
          setTimeout(() => this.cells[move.path[s]].classList.remove('cell--painted'), 600);
        }, stepMs * 0.55);

        await sleep(stepMs);
        piece.classList.remove('piece--arc');
      }

      piece.style.transition = '';
      piece.style.transform = '';
      piece.style.zIndex = '';
      piece.classList.remove('piece--moving');
      haptic(move.type === 'jump' ? [10, 30, 14] : 10);
    }

    /** Efeito de estilhaçar: partículas emitidas da casa capturada. */
    async shatter(indices, owner) {
      if (!indices || !indices.length) return;
      const color = owner === R.A ? 'a' : 'b';

      indices.forEach(i => {
        const piece = this.pieces.get(i);
        if (piece) piece.classList.add('piece--shattering');
        const c = this._centerOf(i);
        const count = prefersReducedMotion() ? 3 : CFG.UI.SHARD_PARTICLES;

        for (let p = 0; p < count; p++) {
          const angle = (Math.PI * 2 * p) / count + Math.random() * 0.5;
          const dist = 26 + Math.random() * 42;
          const shard = el('span', { class: `shard shard--${color}` });
          shard.style.left = `${c.x}px`;
          shard.style.top = `${c.y}px`;
          shard.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
          shard.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
          shard.style.setProperty('--rot', `${Math.random() * 540 - 270}deg`);
          shard.style.animationDelay = `${Math.random() * 70}ms`;
          this.fx.appendChild(shard);
          setTimeout(() => shard.remove(), 900);
        }
      });

      haptic([14, 20, 26]);
      await sleep(prefersReducedMotion() ? 60 : 340);
    }

    /** Pulso que percorre o perímetro do grupo cercado. */
    async siegePulse(indices, owner) {
      if (!indices || !indices.length) return;
      indices.forEach((i, k) => {
        const cell = this.cells[i];
        cell.classList.add(owner === R.A ? 'cell--siege-a' : 'cell--siege-b');
        setTimeout(() => cell.classList.remove('cell--siege-a', 'cell--siege-b'), 700 + k * 20);
      });
      await sleep(prefersReducedMotion() ? 50 : 300);
    }

    flashInvalid(index) {
      const cell = this.cells[index];
      if (!cell) return;
      cell.classList.add('cell--invalid');
      haptic([6, 40, 6]);
      setTimeout(() => cell.classList.remove('cell--invalid'), 420);
    }
  }

  /* ================================================================== */
  /* UIManager                                                          */
  /* ================================================================== */

  class UIManager {
    constructor(bus) {
      this.bus = bus;
      this.screen = 'boot';
      this.board = null;
      this.els = {};
      this._confirmResolver = null;
    }

    mount() {
      const q = id => document.getElementById(id);
      this.els = {
        app: q('app'),
        screens: {
          boot: q('screen-boot'),
          auth: q('screen-auth'),
          home: q('screen-home'),
          queue: q('screen-queue'),
          game: q('screen-game'),
          rank: q('screen-rank')
        },
        // auth
        authForm: q('auth-form'),
        authUser: q('auth-username'),
        authPass: q('auth-password'),
        authSubmit: q('auth-submit'),
        authSwitch: q('auth-switch'),
        authError: q('auth-error'),
        authOffline: q('auth-offline'),
        // home
        homeName: q('home-name'),
        homeElo: q('home-elo'),
        homeDivision: q('home-division'),
        homeRecord: q('home-record'),
        homeAvatar: q('home-avatar'),
        levelGroup: q('level-group'),
        // queue
        queueTimer: q('queue-timer'),
        queueCount: q('queue-count'),
        queueHint: q('queue-hint'),
        queueRing: q('queue-ring'),
        // game
        boardHost: q('board-host'),
        turnLabel: q('turn-label'),
        turnDot: q('turn-dot'),
        barA: q('bar-a'),
        barB: q('bar-b'),
        barLabelA: q('bar-label-a'),
        barLabelB: q('bar-label-b'),
        playerTop: q('player-top'),
        playerBottom: q('player-bottom'),
        topName: q('top-name'),
        topMeta: q('top-meta'),
        bottomName: q('bottom-name'),
        bottomMeta: q('bottom-meta'),
        // rank
        rankList: q('rank-list'),
        // overlays
        toastHost: q('toast-host'),
        confirm: q('overlay-confirm'),
        confirmText: q('confirm-text'),
        confirmYes: q('confirm-yes'),
        confirmNo: q('confirm-no'),
        result: q('overlay-result'),
        resultTitle: q('result-title'),
        resultReason: q('result-reason'),
        resultElo: q('result-elo'),
        resultDelta: q('result-delta'),
        // chrome
        langSelect: q('lang-select'),
        connBadge: q('conn-badge')
      };

      this.board = new BoardView(this.els.boardHost, this.bus);
      this._wireEvents();
      this._buildLanguageSelect();
      I.applyToDom();
      return this;
    }

    _wireEvents() {
      // Botões declarativos: data-action="home.playOnline"
      document.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        e.preventDefault();
        this.bus.emit('ui:action', { action: btn.dataset.action, value: btn.dataset.value, el: btn });
      });

      this.els.authForm.addEventListener('submit', e => {
        e.preventDefault();
        this.bus.emit('ui:action', { action: 'auth.submit' });
      });

      this.els.confirmYes.addEventListener('click', () => this._resolveConfirm(true));
      this.els.confirmNo.addEventListener('click', () => this._resolveConfirm(false));

      I.onChange(() => {
        I.applyToDom();
        this.bus.emit('ui:languageChanged');
      });
    }

    _buildLanguageSelect() {
      const sel = this.els.langSelect;
      const names = { pt: 'PT', en: 'EN', es: 'ES' };
      sel.innerHTML = '';
      I.supported.forEach(code => {
        sel.appendChild(el('option', { value: code, text: names[code] || code.toUpperCase() }));
      });
      sel.value = I.lang;
      sel.addEventListener('change', () => I.setLanguage(sel.value));
    }

    /* ----------------------- navegação ----------------------- */

    showScreen(name) {
      Object.entries(this.els.screens).forEach(([key, node]) => {
        if (!node) return;
        const active = key === name;
        node.classList.toggle('screen--active', active);
        node.setAttribute('aria-hidden', active ? 'false' : 'true');
      });
      this.screen = name;
      document.body.dataset.screen = name;
      window.scrollTo(0, 0);
    }

    /* ----------------------- feedback ----------------------- */

    toast(message, kind = 'info') {
      const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, [
        el('span', { class: 'toast__text', text: message })
      ]);
      this.els.toastHost.appendChild(node);
      requestAnimationFrame(() => node.classList.add('toast--in'));
      setTimeout(() => {
        node.classList.remove('toast--in');
        setTimeout(() => node.remove(), 320);
      }, CFG.UI.TOAST_MS);
    }

    confirm(message, yesLabel, noLabel) {
      this.els.confirmText.textContent = message;
      this.els.confirmYes.textContent = yesLabel || I.t('game.yes');
      this.els.confirmNo.textContent = noLabel || I.t('game.no');
      this.els.confirm.classList.add('overlay--open');
      return new Promise(resolve => { this._confirmResolver = resolve; });
    }

    _resolveConfirm(value) {
      this.els.confirm.classList.remove('overlay--open');
      if (this._confirmResolver) { this._confirmResolver(value); this._confirmResolver = null; }
    }

    setConnection(online) {
      this.els.connBadge.classList.toggle('conn--off', !online);
      this.els.connBadge.textContent = online ? '' : I.t('game.reconnecting');
    }

    /* ----------------------- telas ----------------------- */

    setAuthMode(mode) {
      const isRegister = mode === 'register';
      this.els.authSubmit.textContent = I.t(isRegister ? 'auth.register' : 'auth.login');
      this.els.authSwitch.textContent = I.t(isRegister ? 'auth.switchToLogin' : 'auth.switchToRegister');
      this.els.authSwitch.dataset.value = isRegister ? 'login' : 'register';
    }

    setAuthError(code) {
      this.els.authError.textContent = code ? I.error(code) : '';
      this.els.authError.classList.toggle('field-error--visible', !!code);
    }

    setAuthBusy(busy) {
      this.els.authSubmit.disabled = busy;
      this.els.authSubmit.classList.toggle('btn--busy', busy);
    }

    renderProfile(user) {
      if (!user) return;
      this.els.homeName.textContent = I.t('home.greeting', { name: user.username });
      this.els.homeElo.textContent = user.elo;
      this.els.homeDivision.textContent = I.t('division.' + user.division);
      this.els.homeDivision.dataset.division = user.division;
      this.els.homeRecord.textContent = I.t('home.record', { wins: user.wins, losses: user.losses });
      this.els.homeAvatar.textContent = (user.username || '?').charAt(0).toUpperCase();
      this.els.homeAvatar.dataset.division = user.division;
    }

    setLevel(level) {
      $$('#level-group [data-value]').forEach(btn => {
        btn.classList.toggle('chip--on', btn.dataset.value === level);
        btn.setAttribute('aria-pressed', btn.dataset.value === level ? 'true' : 'false');
      });
    }

    renderQueue({ elapsedMs, queueSize, botInMs }) {
      this.els.queueTimer.textContent = formatDuration(elapsedMs);
      this.els.queueCount.textContent = queueSize > 1
        ? I.t('queue.inQueue', { count: queueSize })
        : '';
      const seconds = Math.max(0, Math.ceil(botInMs / 1000));
      this.els.queueHint.textContent = seconds > 0
        ? I.t('queue.botIn', { seconds })
        : I.t('queue.startingBot');
      const progress = clamp(1 - botInMs / CFG.NET.BOT_FALLBACK_MS, 0, 1);
      this.els.queueRing.style.setProperty('--progress', progress.toFixed(3));
    }

    renderMatchHeader({ you, players, botName }) {
      const mine = you === 'A' ? players.A : players.B;
      const theirs = you === 'A' ? players.B : players.A;
      this.els.bottomName.textContent = mine.name;
      this.els.bottomMeta.textContent = I.t('result.elo', { elo: mine.elo });
      this.els.topName.textContent = theirs.name || botName || I.t('common.bot');
      this.els.topMeta.textContent = I.t('result.elo', { elo: theirs.elo });
      this.els.playerBottom.dataset.side = you === 'A' ? 'a' : 'b';
      this.els.playerTop.dataset.side = you === 'A' ? 'b' : 'a';
    }

    renderHud(state, { mySide, opponentName, thinking }) {
      const myTurn = state.turn === mySide;
      this.els.turnDot.dataset.side = state.turn === R.A ? 'a' : 'b';

      if (state.status === 'finished') {
        this.els.turnLabel.textContent = '';
      } else if (thinking) {
        this.els.turnLabel.textContent = I.t('game.thinking', { name: opponentName });
      } else {
        this.els.turnLabel.textContent = myTurn
          ? I.t('game.yourTurn')
          : I.t('game.opponentTurn', { name: opponentName });
      }
      this.els.turnLabel.classList.toggle('turn__label--mine', myTurn && !thinking);

      const t = R.territoryCount(state);
      const pctA = Math.round((t[R.A] / R.SIZE) * 100);
      const pctB = Math.round((t[R.B] / R.SIZE) * 100);
      this.els.barA.style.width = pctA + '%';
      this.els.barB.style.width = pctB + '%';
      this.els.barLabelA.textContent = pctA + '%';
      this.els.barLabelB.textContent = pctB + '%';

      const mineCount = R.countPieces(state, mySide);
      const theirCount = R.countPieces(state, R.opponent(mySide));
      this.els.bottomMeta.textContent = `${mineCount.sentinels} ${I.t('game.sentinels')}`;
      this.els.topMeta.textContent = `${theirCount.sentinels} ${I.t('game.sentinels')}`;

      this.els.playerBottom.classList.toggle('player--active', myTurn && state.status === 'playing');
      this.els.playerTop.classList.toggle('player--active', !myTurn && state.status === 'playing');
    }

    showResult({ outcome, reason, elo, delta }) {
      const titleKey = outcome === 'win' ? 'result.victory'
                     : outcome === 'loss' ? 'result.defeat' : 'result.draw';
      this.els.resultTitle.textContent = I.t(titleKey);
      this.els.result.dataset.outcome = outcome;
      this.els.resultReason.textContent = reason ? I.t('reason.' + reason) : '';

      if (elo !== null && elo !== undefined) {
        this.els.resultElo.textContent = I.t('result.elo', { elo });
        this.els.resultDelta.textContent = delta > 0 ? `+${delta}` : `${delta}`;
        this.els.resultDelta.dataset.sign = delta >= 0 ? 'up' : 'down';
        this.els.resultElo.parentElement.hidden = false;
      } else {
        this.els.resultElo.parentElement.hidden = true;
      }
      this.els.result.classList.add('overlay--open');
    }

    hideResult() { this.els.result.classList.remove('overlay--open'); }

    renderLeaderboard(entries, myName) {
      const host = this.els.rankList;
      host.innerHTML = '';
      if (!entries || !entries.length) {
        host.appendChild(el('p', { class: 'empty', text: I.t('rank.empty') }));
        return;
      }
      entries.forEach(e => {
        const row = el('li', {
          class: 'rank-row' + (e.username === myName ? ' rank-row--me' : ''),
          'data-division': e.division
        }, [
          el('span', { class: 'rank-row__pos', text: String(e.rank) }),
          el('span', { class: 'rank-row__badge', 'data-division': e.division }),
          el('span', { class: 'rank-row__name', text: e.username }),
          el('span', { class: 'rank-row__div', text: I.t('division.' + e.division) }),
          el('span', { class: 'rank-row__elo', text: String(e.elo) })
        ]);
        host.appendChild(row);
      });
    }
  }

  root.AuraUI = { BoardView, UIManager };
})(typeof self !== 'undefined' ? self : this);
