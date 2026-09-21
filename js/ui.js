/**
 * ============================================================================
 *  AURA — Camada de Apresentação
 * ============================================================================
 *  BoardView   — desenha um grid de tamanho VARIÁVEL (9, 11 ou 13), aplica
 *                diffs, e anima: passo, deslize, salto, travessia de portal,
 *                irradiação, estilhaçamento, pulso de cerco, tremor de tela e
 *                a entrada em cascata do tabuleiro.
 *  UIManager   — roteia telas, atualiza HUD, monta a campanha e o códex,
 *                controla o mixer de áudio, exibe toasts/modais e o ranking.
 *
 *  A UI nunca decide regras: recebe estados prontos do GameController e emite
 *  intenções pelo EventBus (`ui:cellTap`, `ui:action`). Toda animação é
 *  `await`-ável para que o controlador possa sequenciar sem timers mágicos.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const CFG = root.AURA_CONFIG;
  const R = root.AuraRules;
  const I = root.AuraI18n;
  const AUDIO = root.AuraAudio;
  const ARENAS = root.AuraArenas;
  const { $, $$, el, sleep, haptic, clamp, prefersReducedMotion, formatDuration } = root.AuraUtils;

  const sideClass = owner => (owner === R.B ? 'b' : 'a');
  const kindName = kind => R.KIND_NAMES[kind] || 'sentinel';

  /** Marcação de uma peça — reaproveitada pelo tabuleiro e pelo códex. */
  function pieceNode(owner, kind, extraClass) {
    return el('span', {
      class: 'piece piece--' + sideClass(owner) + ' piece--' + kindName(kind) + (extraClass ? ' ' + extraClass : ''),
      'data-kind': kindName(kind)
    }, [
      el('span', { class: 'piece__base' }),
      el('span', { class: 'piece__body' }),
      el('span', { class: 'piece__crest' }),
      el('span', { class: 'piece__glow' })
    ]);
  }

  /* ================================================================== */
  /* BoardView                                                          */
  /* ================================================================== */

  class BoardView {
    constructor(container, bus) {
      this.root = container;
      this.bus = bus;
      this.arena = null;
      this.cells = [];
      this.pieces = new Map();          // índice -> elemento .piece
      this.lastBoard = null;
      this.lastAura = null;
      this.selected = null;
      this.targets = new Map();
      this.perspective = R.A;
      this.locked = false;
      this.root.classList.add('board');
      this.fx = el('div', { class: 'board__fx', 'aria-hidden': 'true' });
    }

    /* ----------------------- construção ----------------------- */

    /**
     * Reconstrói o grid quando a arena muda. Chamado automaticamente pelo
     * render: nenhum caller precisa lembrar de sincronizar.
     */
    setArena(arena) {
      if (this.arena && this.arena.id === arena.id) return;
      this.arena = arena;
      this.cells = [];
      this.pieces.clear();
      this.lastBoard = null;
      this.lastAura = null;

      this.root.innerHTML = '';
      this.root.style.setProperty('--n', arena.N);
      this.root.dataset.arena = arena.id;
      this.root.dataset.density = arena.N >= CFG.BOARD.DENSE_FROM_N ? 'dense' : 'normal';

      const grid = el('div', { class: 'board__grid', role: 'grid', 'aria-label': 'Aura' });

      for (let i = 0; i < arena.SIZE; i++) {
        const r = R.rowOn(arena, i), c = R.colOn(arena, i);
        const blocked = !!arena.blocked[i];
        const portal = arena.portal[i];

        const cell = el('button', {
          class: 'cell' + (blocked ? ' cell--void' : '') + (portal >= 0 ? ' cell--portal' : ''),
          type: 'button',
          'data-i': i,
          role: 'gridcell',
          'aria-label': String.fromCharCode(65 + c) + (arena.N - r),
          style: '--cell-delay:' + ((r + c) * 14) + 'ms'
        }, [
          el('span', { class: 'cell__aura' }),
          el('span', { class: 'cell__marker' }),
          el('span', { class: 'cell__ripple' })
        ]);

        if (blocked) cell.setAttribute('aria-hidden', 'true');
        if (portal >= 0) cell.dataset.portal = String(Math.min(i, portal));
        cell.addEventListener('click', () => this._onCellTap(i));

        this.cells.push(cell);
        grid.appendChild(cell);
      }

      this.grid = grid;
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
      this._ripple(index);
      this.bus.emit('ui:cellTap', index);
    }

    _ripple(index) {
      const cell = this.cells[index];
      if (!cell || prefersReducedMotion()) return;
      cell.classList.remove('cell--rippling');
      // força reflow para reiniciar a animação em toques rápidos seguidos
      void cell.offsetWidth;
      cell.classList.add('cell--rippling');
      setTimeout(() => cell.classList.remove('cell--rippling'), 520);
    }

    /* ----------------------- render / diff ----------------------- */

    render(state, options) {
      const force = !!(options && options.force);
      this.setArena(state.arena);
      const board = state.board, aura = state.aura;

      for (let i = 0; i < state.arena.SIZE; i++) {
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

      const node = pieceNode(R.ownerOf(code), R.kindOf(code), 'piece--spawn');
      cell.appendChild(node);
      this.pieces.set(index, node);
      setTimeout(() => node.classList.remove('piece--spawn'), 420);
    }

    _updateDominance(state) {
      const t = R.territoryCount(state);
      const leader = t[R.A] === t[R.B] ? 0 : (t[R.A] > t[R.B] ? R.A : R.B);
      const ratio = Math.max(t[R.A], t[R.B]) / state.arena.playable;
      this.root.dataset.dominant = ratio > 0.45 ? sideClass(leader) : '';
      this.root.style.setProperty('--dominance', ratio.toFixed(3));
    }

    /** Entrada do tabuleiro: as casas caem em cascata diagonal. */
    async intro() {
      if (prefersReducedMotion()) return;
      this.root.classList.add('board--intro');
      await sleep(CFG.UI.BOARD_INTRO_MS);
      this.root.classList.remove('board--intro');
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
        const cell = this.cells[to];
        cell.classList.add('cell--target');
        if (move.captures.length) cell.classList.add('cell--target-capture');
        if (move.type === 'portal') cell.classList.add('cell--target-portal');
        if (move.type === 'slide') cell.classList.add('cell--target-slide');
        move.captures.forEach(c => this.cells[c].classList.add('cell--doomed'));
        // prévia do rastro: as casas intermediárias piscam de leve
        move.path.forEach((p, k) => {
          if (k < move.path.length - 1) this.cells[p].classList.add('cell--trail');
        });
      });

      haptic(8);
      AUDIO.play('select', { side: R.ownerOf(this.lastBoard ? this.lastBoard[index] : 0) });
    }

    clearSelection() {
      if (this.selected !== null) {
        const p = this.pieces.get(this.selected);
        if (p) p.classList.remove('piece--lifted');
      }
      this.selected = null;
      this.targets = new Map();
      this.cells.forEach(c => {
        c.classList.remove('cell--selected', 'cell--target', 'cell--target-capture',
          'cell--target-portal', 'cell--target-slide', 'cell--doomed', 'cell--trail');
      });
    }

    highlight(indices, className) {
      const cls = className || 'cell--hint';
      this.cells.forEach(c => c.classList.remove(cls));
      (indices || []).forEach(i => { if (this.cells[i]) this.cells[i].classList.add(cls); });
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

    _paintCell(index, owner) {
      const cell = this.cells[index];
      if (!cell) return;
      cell.dataset.aura = owner;
      cell.classList.add('cell--painted');
      setTimeout(() => cell.classList.remove('cell--painted'), 620);
    }

    /**
     * Desloca a peça ao longo do caminho, um trecho por vez, pintando a Aura
     * na metade de cada trecho. Cada tipo de lance tem sua própria curva:
     * deslize é rápido e reto, salto é arco, portal é dissolve + materializa.
     */
    async animateMove(state, move) {
      const piece = this.pieces.get(move.from);
      const owner = R.ownerOf(state.board[move.from]);

      if (prefersReducedMotion() || !piece) {
        move.path.forEach(p => this._paintCell(p, owner));
        return;
      }

      piece.style.zIndex = '40';
      piece.classList.add('piece--moving');

      if (move.type === 'portal') {
        await this._animatePortal(piece, move, owner);
      } else {
        const origin = this._centerOf(move.from);
        const stepMs = move.type === 'jump' ? CFG.UI.JUMP_STEP_MS
          : move.type === 'slide' ? CFG.UI.SLIDE_STEP_MS
            : CFG.UI.MOVE_ANIM_MS;

        AUDIO.play(move.type === 'jump' ? 'jump' : move.type === 'slide' ? 'slide' : 'step',
          { length: move.path.length });

        for (let s = 0; s < move.path.length; s++) {
          const target = this._centerOf(move.path[s]);
          const dx = target.x - origin.x;
          const dy = target.y - origin.y;

          if (move.type === 'jump') piece.classList.add('piece--arc');
          piece.style.transition = 'transform ' + stepMs + 'ms cubic-bezier(.34,1.3,.4,1)';
          piece.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) translateZ(26px)';

          const cellIndex = move.path[s];
          setTimeout(() => this._paintCell(cellIndex, owner), stepMs * 0.55);
          if (move.type === 'slide' && s > 0) AUDIO.play('paint');

          await sleep(stepMs);
          piece.classList.remove('piece--arc');
        }
      }

      piece.style.transition = '';
      piece.style.transform = '';
      piece.style.zIndex = '';
      piece.classList.remove('piece--moving');
      haptic(move.type === 'jump' ? [10, 30, 14] : 10);
    }

    /** Travessia de portal: a peça implode em um ponto e explode no gêmeo. */
    async _animatePortal(piece, move, owner) {
      AUDIO.play('portal');
      const half = CFG.UI.PORTAL_ANIM_MS / 2;

      this.cells[move.from].classList.add('cell--portal-active');
      this.cells[move.to].classList.add('cell--portal-active');

      piece.classList.add('piece--warp-out');
      await sleep(half);

      const origin = this._centerOf(move.from);
      const target = this._centerOf(move.to);
      piece.style.transform = 'translate(' + (target.x - origin.x) + 'px, ' + (target.y - origin.y) + 'px)';
      piece.classList.remove('piece--warp-out');
      piece.classList.add('piece--warp-in');
      this._paintCell(move.to, owner);

      await sleep(half);
      piece.classList.remove('piece--warp-in');
      this.cells[move.from].classList.remove('cell--portal-active');
      this.cells[move.to].classList.remove('cell--portal-active');
      haptic([8, 24, 8]);
    }

    /** Onda de luz do Prisma e do Guardião ao pousar. */
    async radiate(center, indices, owner) {
      if (!indices || !indices.length) return;
      AUDIO.play('radiate');

      const cell = this.cells[center];
      if (cell) {
        cell.classList.add('cell--radiating');
        setTimeout(() => cell.classList.remove('cell--radiating'), CFG.UI.RADIATE_MS);
      }

      indices.forEach((i, k) => {
        setTimeout(() => this._paintCell(i, owner), k * 45);
        const target = this.cells[i];
        if (!target) return;
        target.classList.add('cell--beam');
        setTimeout(() => target.classList.remove('cell--beam'), CFG.UI.RADIATE_MS);
      });

      await sleep(prefersReducedMotion() ? 40 : CFG.UI.RADIATE_MS * 0.55);
    }

    /** Estilhaçar: partículas emitidas da casa capturada. */
    async shatter(indices, owner) {
      if (!indices || !indices.length) return;
      const color = sideClass(owner);
      AUDIO.play('shatter', { count: indices.length });

      indices.forEach(i => {
        const piece = this.pieces.get(i);
        if (piece) piece.classList.add('piece--shattering');
        const c = this._centerOf(i);
        const count = prefersReducedMotion() ? 3 : CFG.UI.SHARD_PARTICLES;

        for (let p = 0; p < count; p++) {
          const angle = (Math.PI * 2 * p) / count + Math.random() * 0.5;
          const dist = 26 + Math.random() * 46;
          const shard = el('span', { class: 'shard shard--' + color });
          shard.style.left = c.x + 'px';
          shard.style.top = c.y + 'px';
          shard.style.setProperty('--dx', (Math.cos(angle) * dist) + 'px');
          shard.style.setProperty('--dy', (Math.sin(angle) * dist) + 'px');
          shard.style.setProperty('--rot', (Math.random() * 540 - 270) + 'deg');
          shard.style.animationDelay = (Math.random() * 70) + 'ms';
          this.fx.appendChild(shard);
          setTimeout(() => shard.remove(), 900);
        }
      });

      this.shake(indices.length > 2 ? 'strong' : 'soft');
      haptic([14, 20, 26]);
      await sleep(prefersReducedMotion() ? 60 : 360);
    }

    /** Pulso que percorre o grupo cercado antes de ele cair. */
    async siegePulse(indices, owner) {
      if (!indices || !indices.length) return;
      AUDIO.play('siege');
      const cls = owner === R.A ? 'cell--siege-a' : 'cell--siege-b';
      indices.forEach((i, k) => {
        const cell = this.cells[i];
        if (!cell) return;
        setTimeout(() => cell.classList.add(cls), k * 26);
        setTimeout(() => cell.classList.remove('cell--siege-a', 'cell--siege-b'), 760 + k * 26);
      });
      await sleep(prefersReducedMotion() ? 50 : 340);
    }

    /** Tremor curto — sempre no wrapper, nunca no grid (não quebra offsets). */
    shake(intensity) {
      if (prefersReducedMotion()) return;
      const cls = intensity === 'strong' ? 'board--shake-strong' : 'board--shake';
      this.root.classList.add(cls);
      setTimeout(() => this.root.classList.remove(cls), CFG.UI.SHAKE_MS);
    }

    flashInvalid(index) {
      const cell = this.cells[index];
      if (!cell) return;
      cell.classList.add('cell--invalid');
      AUDIO.play('invalid');
      haptic([6, 40, 6]);
      setTimeout(() => cell.classList.remove('cell--invalid'), 420);
    }

    /** Aviso visual quando o Núcleo fica com 1 respiração. */
    markCoreDanger(index, danger) {
      this.cells.forEach(c => c.classList.remove('cell--core-danger'));
      if (danger && index >= 0 && this.cells[index]) {
        this.cells[index].classList.add('cell--core-danger');
      }
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
      this._barValues = { a: 0, b: 0 };
    }

    mount() {
      const q = id => document.getElementById(id);
      this.els = {
        app: q('app'),
        screens: {
          boot: q('screen-boot'),
          auth: q('screen-auth'),
          home: q('screen-home'),
          campaign: q('screen-campaign'),
          codex: q('screen-codex'),
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
        // home
        homeName: q('home-name'),
        homeElo: q('home-elo'),
        homeDivision: q('home-division'),
        homeRecord: q('home-record'),
        homeAvatar: q('home-avatar'),
        levelGroup: q('level-group'),
        campaignBadge: q('campaign-badge'),
        // campanha / códex
        campaignList: q('campaign-list'),
        campaignProgress: q('campaign-progress'),
        codexList: q('codex-list'),
        // áudio
        audioToggle: q('audio-toggle'),
        musicRange: q('music-range'),
        sfxRange: q('sfx-range'),
        // queue
        queueTimer: q('queue-timer'),
        queueCount: q('queue-count'),
        queueHint: q('queue-hint'),
        queueRing: q('queue-ring'),
        // game
        boardHost: q('board-host'),
        arenaName: q('arena-name'),
        plyCount: q('ply-count'),
        turnLabel: q('turn-label'),
        turnDot: q('turn-dot'),
        barA: q('bar-a'),
        barB: q('bar-b'),
        barLabelA: q('bar-label-a'),
        barLabelB: q('bar-label-b'),
        barGoal: q('bar-goal'),
        playerTop: q('player-top'),
        playerBottom: q('player-bottom'),
        topName: q('top-name'),
        topMeta: q('top-meta'),
        bottomName: q('bottom-name'),
        bottomMeta: q('bottom-meta'),
        rosterTop: q('roster-top'),
        rosterBottom: q('roster-bottom'),
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
        resultStars: q('result-stars'),
        resultNext: q('result-next'),
        // chrome
        langSelect: q('lang-select'),
        connBadge: q('conn-badge')
      };

      this.board = new BoardView(this.els.boardHost, this.bus);
      this._wireEvents();
      this._buildLanguageSelect();
      this._buildAudioControls();
      this.renderCodex();
      I.applyToDom();
      return this;
    }

    _wireEvents() {
      // Botões declarativos: data-action="home.playOnline"
      document.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        e.preventDefault();
        AUDIO.unlock();
        AUDIO.play('click');
        this.bus.emit('ui:action', {
          action: btn.dataset.action,
          value: btn.dataset.value,
          el: btn
        });
      }, true);

      // Primeiro gesto em qualquer lugar libera o áudio.
      const unlock = () => { AUDIO.unlock(); this.bus.emit('ui:audioUnlocked'); };
      document.addEventListener('pointerdown', unlock, { once: true });
      document.addEventListener('keydown', unlock, { once: true });

      this.els.authForm.addEventListener('submit', e => {
        e.preventDefault();
        this.bus.emit('ui:action', { action: 'auth.submit' });
      });

      this.els.confirmYes.addEventListener('click', () => this._resolveConfirm(true));
      this.els.confirmNo.addEventListener('click', () => this._resolveConfirm(false));

      I.onChange(() => {
        I.applyToDom();
        this.renderCodex();
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

    _buildAudioControls() {
      const toggle = this.els.audioToggle;
      const sync = () => {
        toggle.dataset.on = AUDIO.muted ? 'false' : 'true';
        toggle.setAttribute('aria-label', I.t(AUDIO.muted ? 'audio.off' : 'audio.on'));
        toggle.title = I.t(AUDIO.muted ? 'audio.off' : 'audio.on');
      };

      toggle.addEventListener('click', () => {
        AUDIO.unlock();
        AUDIO.setMuted(!AUDIO.muted);
        sync();
        if (!AUDIO.muted) AUDIO.play('toast');
        this.bus.emit('ui:audioToggled', !AUDIO.muted);
      });

      this.els.musicRange.value = String(Math.round(AUDIO.volumes.music * 100));
      this.els.sfxRange.value = String(Math.round(AUDIO.volumes.sfx * 100));

      this.els.musicRange.addEventListener('input', e => {
        AUDIO.unlock();
        AUDIO.setVolume('music', Number(e.target.value) / 100);
      });
      this.els.sfxRange.addEventListener('input', e => {
        AUDIO.unlock();
        AUDIO.setVolume('sfx', Number(e.target.value) / 100);
      });
      this.els.sfxRange.addEventListener('change', () => AUDIO.play('select', {}));

      I.onChange(sync);
      sync();
    }

    /* ----------------------- navegação ----------------------- */

    showScreen(name) {
      Object.keys(this.els.screens).forEach(key => {
        const node = this.els.screens[key];
        if (!node) return;
        const active = key === name;
        node.classList.toggle('screen--active', active);
        node.setAttribute('aria-hidden', active ? 'false' : 'true');
      });
      if (this.screen !== name) AUDIO.play('screen');
      this.screen = name;
      document.body.dataset.screen = name;
      window.scrollTo(0, 0);
    }

    /* ----------------------- feedback ----------------------- */

    toast(message, kind) {
      const node = el('div', { class: 'toast toast--' + (kind || 'info'), role: 'status' }, [
        el('span', { class: 'toast__text', text: message })
      ]);
      this.els.toastHost.appendChild(node);
      AUDIO.play('toast');
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
      this.els.connBadge.dataset.state = online ? 'on' : 'off';
      this.els.connBadge.textContent = online ? '' : I.t('game.reconnecting');
    }

    /* ----------------------- auth / home ----------------------- */

    setAuthMode(mode) {
      const isRegister = mode === 'register';
      this.els.authSubmit.textContent = I.t(isRegister ? 'auth.register' : 'auth.login');
      this.els.authSwitch.textContent = I.t(isRegister ? 'auth.switchToLogin' : 'auth.switchToRegister');
      this.els.authSwitch.dataset.value = isRegister ? 'login' : 'register';
      this.els.authPass.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    }

    setAuthError(code) {
      this.els.authError.textContent = code ? I.error(code) : '';
      this.els.authError.classList.toggle('field-error--on', !!code);
    }

    setAuthBusy(busy) {
      this.els.authSubmit.disabled = busy;
      this.els.authSubmit.classList.toggle('btn--busy', busy);
    }

    renderProfile(user) {
      this.els.homeName.textContent = I.t('home.greeting', { name: user.username });
      this.els.homeElo.textContent = I.t('result.elo', { elo: user.elo });
      this.els.homeDivision.textContent = I.t('division.' + (user.division || 'iron'));
      this.els.homeDivision.dataset.division = user.division || 'iron';
      this.els.homeAvatar.dataset.division = user.division || 'iron';
      this.els.homeRecord.textContent = I.t('home.record', {
        wins: user.wins || 0, losses: user.losses || 0
      });
    }

    setLevel(level) {
      $$('#level-group .chip').forEach(chip => {
        chip.classList.toggle('chip--on', chip.dataset.value === level);
      });
    }

    /* ----------------------- campanha ----------------------- */

    /**
     * `progress` = { cleared: {arenaId: stars}, unlockedUpTo: n }
     */
    renderCampaign(progress) {
      const host = this.els.campaignList;
      host.innerHTML = '';
      const phases = ARENAS.PHASES;
      let done = 0;

      phases.forEach(def => {
        const stars = progress.cleared[def.id] || 0;
        if (stars > 0) done++;
        const locked = def.order > progress.unlockedUpTo;

        const card = el('button', {
          class: 'phase' + (locked ? ' phase--locked' : '') + (stars ? ' phase--cleared' : ''),
          type: 'button',
          'data-action': locked ? 'campaign.locked' : 'campaign.play',
          'data-value': String(def.order),
          'data-arena': def.id
        }, [
          el('span', { class: 'phase__index', text: String(def.order) }),
          el('span', { class: 'phase__body' }, [
            el('span', { class: 'phase__name', text: I.t('arena.' + def.id) }),
            el('span', {
              class: 'phase__desc',
              text: locked ? I.t('campaign.lockedHint') : I.t('arena.' + def.id + '.desc')
            }),
            el('span', { class: 'phase__tags' }, [
              el('span', { class: 'tag tag--quiet', text: def.N + '×' + def.N }),
              el('span', { class: 'tag tag--quiet', text: I.t('level.' + def.level) })
            ])
          ]),
          el('span', { class: 'phase__stars', 'data-stars': String(stars) }, [
            el('span', { class: 'star' }),
            el('span', { class: 'star' }),
            el('span', { class: 'star' })
          ])
        ]);

        host.appendChild(card);
      });

      this.els.campaignProgress.textContent =
        I.t('campaign.progress', { done: done, total: phases.length });
      if (this.els.campaignBadge) {
        this.els.campaignBadge.textContent = done + '/' + phases.length;
      }
    }

    /* ----------------------- códex ----------------------- */

    renderCodex() {
      const host = this.els.codexList;
      if (!host) return;
      host.innerHTML = '';

      const entries = [
        { kind: R.CORE,   id: 'core',     move: '1 · 8 dir',        jump: null,           special: 'immune' },
        { kind: R.SENT,   id: 'sentinel', move: '1 · 8 dir',        jump: '8 dir',        special: null },
        { kind: R.BLADE,  id: 'blade',    move: '1–2 · ortogonal',  jump: 'ortogonal',    special: 'trail' },
        { kind: R.PRISM,  id: 'prism',    move: '1–2 · diagonal',   jump: 'diagonal',     special: 'radiate4' },
        { kind: R.WARDEN, id: 'warden',   move: '1 · ortogonal',    jump: null,           special: 'radiate4immune' }
      ];

      entries.forEach(entry => {
        host.appendChild(el('li', { class: 'codex-row' }, [
          el('span', { class: 'codex-row__art' }, [pieceNode(R.A, entry.kind, 'piece--showcase')]),
          el('span', { class: 'codex-row__body' }, [
            el('h3', { class: 'codex-row__name', text: I.t('piece.' + entry.id) }),
            el('p', { class: 'codex-row__desc', text: I.t('piece.' + entry.id + '.desc') }),
            el('span', { class: 'codex-row__stats' }, [
              el('span', { class: 'tag tag--quiet', text: I.t('codex.moves') + ': ' + entry.move }),
              el('span', {
                class: 'tag tag--quiet',
                text: I.t('codex.jump') + ': ' + (entry.jump || I.t('codex.none'))
              })
            ])
          ])
        ]));
      });
    }

    /* ----------------------- fila ----------------------- */

    renderQueue({ elapsedMs, queueSize, botInMs }) {
      this.els.queueTimer.textContent = formatDuration(elapsedMs);
      this.els.queueCount.textContent = I.t('queue.inQueue', { count: queueSize });
      const seconds = Math.max(0, Math.ceil(botInMs / 1000));
      this.els.queueHint.textContent = seconds > 0
        ? I.t('queue.botIn', { seconds })
        : I.t('queue.startingBot');
      const progress = clamp(elapsedMs / CFG.NET.BOT_FALLBACK_MS, 0, 1);
      this.els.queueRing.style.setProperty('--progress', progress.toFixed(3));
    }

    /* ----------------------- partida ----------------------- */

    renderMatchHeader({ you, players, botName, arena }) {
      const mine = you === 'A' ? players.A : players.B;
      const theirs = you === 'A' ? players.B : players.A;

      this.els.bottomName.textContent = mine.name || I.t('common.you');
      this.els.topName.textContent = theirs.name || botName || I.t('common.bot');
      this.els.playerBottom.dataset.side = you === 'A' ? 'a' : 'b';
      this.els.playerTop.dataset.side = you === 'A' ? 'b' : 'a';

      if (arena) {
        this.els.arenaName.textContent = I.t('arena.' + arena.id);
        this.els.barGoal.style.left = (arena.territoryRatio * 100).toFixed(1) + '%';
      }
    }

    /** Miniaturas do exército de cada lado, com as baixas apagadas. */
    _renderRoster(host, state, side) {
      const counts = R.countPieces(state, side);
      const map = [
        ['core', counts.cores], ['sentinel', counts.sentinels], ['blade', counts.blades],
        ['prism', counts.prisms], ['warden', counts.wardens]
      ];
      host.innerHTML = '';
      map.forEach(pair => {
        if (!pair[1]) return;
        host.appendChild(el('span', { class: 'roster__item', 'data-kind': pair[0] }, [
          el('span', { class: 'roster__glyph' }),
          el('span', { class: 'roster__n', text: '×' + pair[1] })
        ]));
      });
    }

    renderHud(state, { mySide, opponentName, thinking }) {
      const arena = state.arena;
      const myTurn = state.turn === mySide;
      this.els.turnDot.dataset.side = sideClass(state.turn);

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
      this.els.plyCount.textContent = I.t('game.ply', { n: state.ply });

      const t = R.territoryCount(state);
      const pctA = Math.round((t[R.A] / arena.playable) * 100);
      const pctB = Math.round((t[R.B] / arena.playable) * 100);
      this._animateBar('a', pctA);
      this._animateBar('b', pctB);

      this._renderRoster(this.els.rosterBottom, state, mySide);
      this._renderRoster(this.els.rosterTop, state, R.opponent(mySide));

      const mine = R.countPieces(state, mySide);
      const theirs = R.countPieces(state, R.opponent(mySide));
      this.els.bottomMeta.textContent = I.t('game.pieces', { count: mine.total });
      this.els.topMeta.textContent = I.t('game.pieces', { count: theirs.total });

      this.els.playerBottom.classList.toggle('player--active', myTurn && state.status === 'playing');
      this.els.playerTop.classList.toggle('player--active', !myTurn && state.status === 'playing');
    }

    /** Contador que anda até o valor novo em vez de pular. */
    _animateBar(side, pct) {
      const fill = side === 'a' ? this.els.barA : this.els.barB;
      const label = side === 'a' ? this.els.barLabelA : this.els.barLabelB;
      fill.style.width = pct + '%';

      const from = this._barValues[side];
      if (from === pct) return;
      this._barValues[side] = pct;

      if (prefersReducedMotion()) { label.textContent = pct + '%'; return; }
      const steps = Math.min(12, Math.abs(pct - from));
      let k = 0;
      const tick = () => {
        k++;
        const v = Math.round(from + (pct - from) * (k / steps));
        label.textContent = v + '%';
        if (k < steps) requestAnimationFrame(tick);
      };
      if (steps > 0) requestAnimationFrame(tick); else label.textContent = pct + '%';
    }

    showResult({ outcome, reason, elo, delta, stars, hasNext }) {
      const titleKey = outcome === 'win' ? 'result.victory'
        : outcome === 'loss' ? 'result.defeat' : 'result.draw';
      this.els.resultTitle.textContent = I.t(titleKey);
      this.els.result.dataset.outcome = outcome;
      this.els.resultReason.textContent = reason ? I.t('reason.' + reason) : '';

      if (elo !== null && elo !== undefined) {
        this.els.resultElo.textContent = I.t('result.elo', { elo });
        this.els.resultDelta.textContent = delta > 0 ? '+' + delta : String(delta);
        this.els.resultDelta.dataset.sign = delta >= 0 ? 'up' : 'down';
        this.els.resultElo.parentElement.hidden = false;
      } else {
        this.els.resultElo.parentElement.hidden = true;
      }

      if (stars === null || stars === undefined) {
        this.els.resultStars.hidden = true;
      } else {
        this.els.resultStars.hidden = false;
        this.els.resultStars.dataset.stars = String(stars);
        this.els.resultStars.innerHTML = '';
        for (let i = 0; i < 3; i++) {
          const star = el('span', { class: 'star' + (i < stars ? ' star--on' : '') });
          star.style.animationDelay = (i * 140) + 'ms';
          this.els.resultStars.appendChild(star);
        }
      }

      this.els.resultNext.hidden = !hasNext;
      this.els.result.classList.add('overlay--open');
      AUDIO.play(outcome === 'win' ? 'victory' : outcome === 'loss' ? 'defeat' : 'toast');
    }

    hideResult() { this.els.result.classList.remove('overlay--open'); }

    /* ----------------------- ranking ----------------------- */

    renderLeaderboard(entries, myName) {
      const host = this.els.rankList;
      host.innerHTML = '';
      if (!entries || !entries.length) {
        host.appendChild(el('p', { class: 'empty', text: I.t('rank.empty') }));
        return;
      }
      entries.forEach(e => {
        host.appendChild(el('li', {
          class: 'rank-row' + (e.username === myName ? ' rank-row--me' : ''),
          'data-division': e.division
        }, [
          el('span', { class: 'rank-row__pos', text: String(e.rank) }),
          el('span', { class: 'rank-row__badge', 'data-division': e.division }),
          el('span', { class: 'rank-row__name', text: e.username }),
          el('span', { class: 'rank-row__div', text: I.t('division.' + e.division) }),
          el('span', { class: 'rank-row__elo', text: String(e.elo) })
        ]));
      });
    }
  }

  root.AuraUI = { BoardView, UIManager, pieceNode };
})(typeof self !== 'undefined' ? self : this);
