/**
 * ============================================================================
 *  AURA — Tutorial interativo (3 desafios)
 * ============================================================================
 *  Ensina por ação, não por texto: cada passo monta um tabuleiro mínimo, acende
 *  a peça certa e a casa certa, e só avança quando o jogador executa o gesto.
 *
 *    1. Movimento — deslocar 1 casa
 *    2. Salto     — capturar pulando a Sentinela inimiga
 *    3. Cerco     — tirar a última respiração de uma peça cercada
 *
 *  Padrão: State Machine. Cada passo declara `setup`, `hints` e `check`.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const R = root.AuraRules;
  const I = root.AuraI18n;
  const { $, el, sleep } = root.AuraUtils;

  const CORE_A_AT = R.idx(8, 8);
  const CORE_B_AT = R.idx(0, 0);

  /** Cada passo é uma configuração declarativa validada por um predicado. */
  const STEPS = [
    {
      id: 'move',
      captionKey: 'tutorial.move',
      setup() {
        return R.fromLayout({
          [CORE_A_AT]: R.CORE_A,
          [CORE_B_AT]: R.CORE_B,
          [R.idx(5, 4)]: R.SENT_A
        }, {
          [CORE_A_AT]: R.A,
          [CORE_B_AT]: R.B,
          [R.idx(5, 4)]: R.A
        });
      },
      hints: { piece: R.idx(5, 4), targets: [R.idx(4, 4)] },
      check(move) { return move.from === R.idx(5, 4) && move.to === R.idx(4, 4); }
    },

    {
      id: 'jump',
      captionKey: 'tutorial.jump',
      setup() {
        return R.fromLayout({
          [CORE_A_AT]: R.CORE_A,
          [CORE_B_AT]: R.CORE_B,
          [R.idx(5, 4)]: R.SENT_A,
          [R.idx(4, 4)]: R.SENT_B
        }, {
          [CORE_A_AT]: R.A,
          [CORE_B_AT]: R.B,
          [R.idx(5, 4)]: R.A,
          [R.idx(4, 4)]: R.B
        });
      },
      hints: { piece: R.idx(5, 4), targets: [R.idx(3, 4)] },
      check(move) { return move.captures.length > 0; }
    },

    {
      id: 'siege',
      captionKey: 'tutorial.siege',
      setup() {
        // Sentinela inimiga em (4,4) com três paredes; resta uma respiração.
        return R.fromLayout({
          [CORE_A_AT]: R.CORE_A,
          [CORE_B_AT]: R.CORE_B,
          [R.idx(4, 4)]: R.SENT_B,
          [R.idx(3, 4)]: R.SENT_A,
          [R.idx(4, 3)]: R.SENT_A,
          [R.idx(4, 5)]: R.SENT_A,
          [R.idx(6, 4)]: R.SENT_A
        }, {
          [CORE_A_AT]: R.A,
          [CORE_B_AT]: R.B,
          [R.idx(4, 4)]: R.B,
          [R.idx(3, 4)]: R.A,
          [R.idx(4, 3)]: R.A,
          [R.idx(4, 5)]: R.A,
          [R.idx(6, 4)]: R.A
        });
      },
      hints: { piece: R.idx(6, 4), targets: [R.idx(5, 4)] },
      check(move, nextState) {
        return nextState.board[R.idx(4, 4)] === R.EMPTY;
      }
    }
  ];

  class TutorialController {
    constructor(ui, bus) {
      this.ui = ui;
      this.bus = bus;
      this.active = false;
      this.index = 0;
      this.state = null;
      this.selected = null;
      this.onFinish = null;
      this._mountOverlay();
    }

    _mountOverlay() {
      this.overlay = document.getElementById('overlay-tutorial');
      this.caption = document.getElementById('tut-caption');
      this.dots = document.getElementById('tut-dots');
    }

    start(onFinish) {
      this.active = true;
      this.index = 0;
      this.onFinish = onFinish || null;
      this.overlay.classList.add('overlay--open');
      this.ui.showScreen('game');
      this.ui.board.setPerspective(R.A);
      this.ui.board.setLocked(false);
      document.body.classList.add('is-tutorial');
      this._loadStep();
    }

    stop() {
      this.active = false;
      this.overlay.classList.remove('overlay--open');
      document.body.classList.remove('is-tutorial');
      this.ui.board.clearSelection();
      this.ui.board.highlight([], 'cell--hint');
      this.ui.board.highlight([], 'cell--hint-target');
    }

    finish() {
      this.caption.textContent = I.t('tutorial.done');
      root.AuraUtils.Storage.set('tutorialDone', true);
      setTimeout(() => {
        this.stop();
        if (this.onFinish) this.onFinish();
      }, 1100);
    }

    _loadStep() {
      const step = STEPS[this.index];
      this.state = step.setup();
      this.selected = null;

      this.ui.board.render(this.state, { force: true });
      this.ui.board.clearSelection();
      this.ui.board.markLastMove(null);
      this.caption.textContent = I.t(step.captionKey);
      this._renderDots();
      this._applyHints(step);
    }

    _renderDots() {
      this.dots.innerHTML = '';
      STEPS.forEach((s, i) => {
        this.dots.appendChild(el('span', {
          class: 'tut-dot' + (i === this.index ? ' tut-dot--on' : '') +
                 (i < this.index ? ' tut-dot--done' : '')
        }));
      });
    }

    _applyHints(step) {
      this.ui.board.highlight([step.hints.piece], 'cell--hint');
      this.ui.board.highlight([], 'cell--hint-target');
    }

    /** Intercepta os toques enquanto o tutorial está ativo. */
    handleTap(index) {
      if (!this.active || !this.state) return;
      const step = STEPS[this.index];

      // Selecionar peça
      if (this.selected === null) {
        if (R.ownerOf(this.state.board[index]) !== R.A) {
          this.ui.board.flashInvalid(index);
          return;
        }
        const targets = R.targetsFor(this.state, index);
        if (!targets.size) { this.ui.board.flashInvalid(index); return; }
        this.selected = index;
        this.ui.board.select(index, targets);
        this.ui.board.highlight(step.hints.targets, 'cell--hint-target');
        return;
      }

      // Cancelar seleção
      if (index === this.selected) {
        this.selected = null;
        this.ui.board.clearSelection();
        this._applyHints(step);
        return;
      }

      const move = this.ui.board.targets.get(index);
      if (!move) {
        this.ui.board.flashInvalid(index);
        return;
      }
      this._commit(step, move);
    }

    async _commit(step, move) {
      this.ui.board.setLocked(true);
      this.ui.board.clearSelection();
      this.ui.board.highlight([], 'cell--hint');
      this.ui.board.highlight([], 'cell--hint-target');

      const next = R.applyMove(this.state, move);
      await this.ui.board.animateMove(this.state, move);

      const removed = next.lastMove.jumpCaptures.concat(next.lastMove.siegeCaptures);
      if (next.lastMove.siegeCaptures.length) {
        await this.ui.board.siegePulse(next.lastMove.siegeCaptures, R.A);
      }
      if (removed.length) await this.ui.board.shatter(removed, R.A);

      this.state = next;
      this.ui.board.render(this.state, { force: true });
      this.ui.board.markLastMove(next.lastMove);
      this.ui.board.setLocked(false);

      const passed = step.check(move, next);
      if (!passed) {
        this.caption.textContent = I.t('tutorial.retry');
        await sleep(850);
        this._loadStep();
        return;
      }

      await sleep(620);
      this.index++;
      if (this.index >= STEPS.length) this.finish();
      else this._loadStep();
    }
  }

  root.AuraTutorial = TutorialController;
  root.AuraTutorial.STEPS = STEPS;
})(typeof self !== 'undefined' ? self : this);
