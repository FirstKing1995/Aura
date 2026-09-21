/**
 * ============================================================================
 *  AURA — Tutorial interativo (10 capítulos)
 * ============================================================================
 *  Ensina por AÇÃO, não por parágrafo: cada capítulo monta um tabuleiro
 *  mínimo, acende a peça certa e só avança quando o jogador executa o gesto.
 *  Se o gesto não for o esperado, o capítulo se remonta sozinho — nunca há
 *  estado sujo nem beco sem saída.
 *
 *      1  Mover          6  Portal
 *      2  Aura           7  Salto
 *      3  Lâmina         8  Salto encadeado
 *      4  Prisma         9  Cerco
 *      5  Guardião      10  Núcleo imune
 *
 *  Padrão: State Machine. Cada capítulo declara `arena`, `setup`, `hints` e
 *  `check` — dados, não código espalhado. Acrescentar um capítulo é
 *  acrescentar um objeto nesta lista.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const R = root.AuraRules;
  const I = root.AuraI18n;
  const AUDIO = root.AuraAudio;
  const { el, sleep, Storage } = root.AuraUtils;

  /* --- atalhos de coordenada ---------------------------------------- */
  const at9  = (r, c) => r * 9 + c;
  const at11 = (r, c) => r * 11 + c;

  const P = R.piece;
  const A = R.A, B = R.B;

  const CORE_A_HOME = at9(8, 8);
  const CORE_B_HOME = at9(0, 0);

  /** Monta um estado 9x9 com os dois Núcleos já no lugar (evita fim precoce). */
  function scene9(board, aura) {
    const b = Object.assign({}, board);
    const a = Object.assign({}, aura);
    if (b[CORE_A_HOME] === undefined) { b[CORE_A_HOME] = P(A, R.CORE); a[CORE_A_HOME] = A; }
    if (b[CORE_B_HOME] === undefined) { b[CORE_B_HOME] = P(B, R.CORE); a[CORE_B_HOME] = B; }
    return R.fromLayout(b, a, 'classic');
  }

  /* ------------------------------------------------------------------ */
  /* Capítulos                                                           */
  /* ------------------------------------------------------------------ */

  const STEPS = [
    {
      id: 'move',
      setup() {
        return scene9(
          { [at9(5, 4)]: P(A, R.SENT) },
          { [at9(5, 4)]: A }
        );
      },
      hints: { piece: at9(5, 4), targets: [at9(4, 4)] },
      check(move) { return move.from === at9(5, 4) && move.to === at9(4, 4); }
    },

    {
      id: 'aura',
      setup() {
        return scene9(
          { [at9(6, 4)]: P(A, R.SENT) },
          { [at9(6, 4)]: A }
        );
      },
      hints: { piece: at9(6, 4), targets: [at9(5, 4), at9(5, 3), at9(5, 5)] },
      // a lição é o rastro: a casa de origem E a de destino ficam acesas
      check(move, next) {
        return next.aura[move.from] === A && next.aura[move.to] === A;
      }
    },

    {
      id: 'blade',
      setup() {
        return scene9(
          { [at9(6, 4)]: P(A, R.BLADE) },
          { [at9(6, 4)]: A }
        );
      },
      hints: { piece: at9(6, 4), targets: [at9(4, 4)] },
      // precisa deslizar as DUAS casas, não uma
      check(move) { return move.kind === R.BLADE && move.path.length === 2; }
    },

    {
      id: 'prism',
      setup() {
        return scene9(
          { [at9(6, 4)]: P(A, R.PRISM) },
          { [at9(6, 4)]: A }
        );
      },
      hints: { piece: at9(6, 4), targets: [at9(4, 2), at9(4, 6)] },
      check(move, next) {
        return move.kind === R.PRISM && next.lastMove.radiated.length > 0;
      }
    },

    {
      id: 'warden',
      setup() {
        return scene9(
          { [at9(5, 4)]: P(A, R.WARDEN) },
          { [at9(5, 4)]: A }
        );
      },
      hints: { piece: at9(5, 4), targets: [at9(4, 4), at9(5, 3), at9(5, 5), at9(6, 4)] },
      check(move, next) {
        return move.kind === R.WARDEN && next.lastMove.radiated.length > 0;
      }
    },

    {
      id: 'portal',
      arena: 'portais',
      setup() {
        // Extremos do portal "1" desta arena: (3,0) e (7,10).
        return R.fromLayout({
          [at11(3, 0)]: P(A, R.SENT),
          [at11(10, 5)]: P(A, R.CORE),
          [at11(0, 5)]: P(B, R.CORE)
        }, {
          [at11(3, 0)]: A,
          [at11(10, 5)]: A,
          [at11(0, 5)]: B
        }, 'portais');
      },
      hints: { piece: at11(3, 0), targets: [at11(7, 10)] },
      check(move) { return move.type === 'portal'; }
    },

    {
      id: 'jump',
      setup() {
        return scene9({
          [at9(5, 4)]: P(A, R.SENT),
          [at9(4, 4)]: P(B, R.SENT)
        }, {
          [at9(5, 4)]: A,
          [at9(4, 4)]: B
        });
      },
      hints: { piece: at9(5, 4), targets: [at9(3, 4)] },
      check(move) { return move.captures.length > 0; }
    },

    {
      id: 'chain',
      setup() {
        return scene9({
          [at9(6, 4)]: P(A, R.SENT),
          [at9(5, 4)]: P(B, R.SENT),
          [at9(3, 4)]: P(B, R.SENT)
        }, {
          [at9(6, 4)]: A,
          [at9(5, 4)]: B,
          [at9(3, 4)]: B
        });
      },
      hints: { piece: at9(6, 4), targets: [at9(2, 4)] },
      check(move) { return move.captures.length >= 2; }
    },

    {
      id: 'siege',
      setup() {
        // Sentinela inimiga em (4,4) com três paredes; resta uma respiração.
        return scene9({
          [at9(4, 4)]: P(B, R.SENT),
          [at9(3, 4)]: P(A, R.SENT),
          [at9(4, 3)]: P(A, R.SENT),
          [at9(4, 5)]: P(A, R.SENT),
          [at9(6, 4)]: P(A, R.SENT)
        }, {
          [at9(4, 4)]: B,
          [at9(3, 4)]: A,
          [at9(4, 3)]: A,
          [at9(4, 5)]: A,
          [at9(6, 4)]: A
        });
      },
      hints: { piece: at9(6, 4), targets: [at9(5, 4)] },
      check(move, next) { return next.board[at9(4, 4)] === R.EMPTY; }
    },

    {
      id: 'immune',
      setup() {
        // O Núcleo inimigo está cercado por três lados. Saltar não resolve.
        return R.fromLayout({
          [at9(4, 4)]: P(B, R.CORE),
          [at9(3, 4)]: P(A, R.SENT),
          [at9(4, 3)]: P(A, R.SENT),
          [at9(4, 5)]: P(A, R.SENT),
          [at9(6, 4)]: P(A, R.WARDEN),
          [CORE_A_HOME]: P(A, R.CORE)
        }, {
          [at9(4, 4)]: B,
          [at9(3, 4)]: A,
          [at9(4, 3)]: A,
          [at9(4, 5)]: A,
          [at9(6, 4)]: A,
          [CORE_A_HOME]: A
        }, 'classic');
      },
      hints: { piece: at9(6, 4), targets: [at9(5, 4)] },
      check(move, next) { return next.board[at9(4, 4)] === R.EMPTY; }
    }
  ];

  /* ------------------------------------------------------------------ */
  /* Controlador                                                         */
  /* ------------------------------------------------------------------ */

  const HINT_DELAY_MS = 3800;

  class TutorialController {
    constructor(ui, bus) {
      this.ui = ui;
      this.bus = bus;
      this.active = false;
      this.index = 0;
      this.state = null;
      this.selected = null;
      this.onFinish = null;
      this._hintTimer = null;
      this._mountOverlay();
    }

    _mountOverlay() {
      this.overlay = document.getElementById('overlay-tutorial');
      this.title = document.getElementById('tut-title');
      this.caption = document.getElementById('tut-caption');
      this.counter = document.getElementById('tut-counter');
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
      clearTimeout(this._hintTimer);
      this.overlay.classList.remove('overlay--open');
      document.body.classList.remove('is-tutorial');
      this.ui.board.clearSelection();
      this.ui.board.highlight([], 'cell--hint');
      this.ui.board.highlight([], 'cell--hint-target');
    }

    finish() {
      this.title.textContent = I.t('tutorial.done');
      this.caption.textContent = '';
      Storage.set('tutorialDone', true);
      AUDIO.play('unlock');
      setTimeout(() => {
        this.stop();
        if (this.onFinish) this.onFinish();
      }, 1300);
    }

    _loadStep() {
      const step = STEPS[this.index];
      this.state = step.setup();
      this.selected = null;

      this.ui.board.render(this.state, { force: true });
      this.ui.board.clearSelection();
      this.ui.board.markLastMove(null);

      this.title.textContent = I.t('tut.' + step.id + '.title');
      this.caption.textContent = I.t('tut.' + step.id + '.text');
      this.counter.textContent = I.t('tutorial.chapter', {
        n: this.index + 1, total: STEPS.length
      });

      this._renderDots();
      this._applyHints(step);
      this._scheduleTargetHint(step);
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

    /** Se o jogador travar, os destinos acendem sozinhos depois de um tempo. */
    _scheduleTargetHint(step) {
      clearTimeout(this._hintTimer);
      this._hintTimer = setTimeout(() => {
        if (!this.active || this.selected !== null) return;
        this.ui.board.highlight(step.hints.targets, 'cell--hint-target');
      }, HINT_DELAY_MS);
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
        this._scheduleTargetHint(step);
        return;
      }

      // Trocar de peça
      if (R.ownerOf(this.state.board[index]) === R.A) {
        const targets = R.targetsFor(this.state, index);
        if (targets.size) {
          this.selected = index;
          this.ui.board.select(index, targets);
          this.ui.board.highlight(step.hints.targets, 'cell--hint-target');
          return;
        }
      }

      const move = this.ui.board.targets.get(index);
      if (!move) { this.ui.board.flashInvalid(index); return; }
      this._commit(step, move);
    }

    async _commit(step, move) {
      clearTimeout(this._hintTimer);
      const board = this.ui.board;
      board.setLocked(true);
      board.clearSelection();
      board.highlight([], 'cell--hint');
      board.highlight([], 'cell--hint-target');

      const next = R.applyMove(this.state, move);
      await board.animateMove(this.state, move);

      const lm = next.lastMove;
      if (lm.radiated && lm.radiated.length) await board.radiate(lm.to, lm.radiated, R.A);
      if (lm.siegeCaptures.length) await board.siegePulse(lm.siegeCaptures, R.A);

      const removed = lm.jumpCaptures.concat(lm.siegeCaptures);
      if (removed.length) await board.shatter(removed, R.A);

      this.state = next;
      board.render(this.state, { force: true });
      board.markLastMove(lm);
      board.setLocked(false);

      if (!step.check(move, next)) {
        this.title.textContent = I.t('tutorial.retry');
        AUDIO.play('invalid');
        await sleep(950);
        this._loadStep();
        return;
      }

      AUDIO.play('turn');
      await sleep(680);
      this.index++;
      if (this.index >= STEPS.length) this.finish();
      else this._loadStep();
    }
  }

  root.AuraTutorial = TutorialController;
  root.AuraTutorial.STEPS = STEPS;
})(typeof self !== 'undefined' ? self : this);
