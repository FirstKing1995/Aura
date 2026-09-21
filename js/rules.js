/**
 * ============================================================================
 *  AURA — Motor de Regras (puro, determinístico, sem DOM)
 * ============================================================================
 *  Este módulo é a ÚNICA fonte de verdade das regras no cliente. É carregado
 *  tanto pela thread principal quanto pelo Web Worker da IA (importScripts),
 *  por isso não pode tocar em `document`, `window` ou `localStorage`.
 *
 *  Espelha 1:1 o objeto `Rules` do Code.gs (servidor autoritativo).
 *
 *  Codificação do tabuleiro (Int8Array de 81 posições):
 *      0 vazio | 1 Núcleo A | 2 Sentinela A | 3 Núcleo B | 4 Sentinela B
 *  Aura (Int8Array de 81 posições):
 *      0 neutro | 1 território de A | 2 território de B
 * ============================================================================
 */
(function (root) {
  'use strict';

  const N = 9;
  const SIZE = N * N;

  const EMPTY = 0, CORE_A = 1, SENT_A = 2, CORE_B = 3, SENT_B = 4;
  const A = 1, B = 2;

  const DIRS  = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const ORTHO = [[-1,0],[1,0],[0,-1],[0,1]];

  /* ------------------------------------------------------------------ */
  /* Tabelas de vizinhança pré-computadas (evita recalcular em cada nó)  */
  /* ------------------------------------------------------------------ */
  const NEIGHBORS   = new Array(SIZE);   // 8 direções -> índice ou -1
  const ORTHO_NEIGH = new Array(SIZE);   // 4 direções -> array de índices
  const JUMPS       = new Array(SIZE);   // 8 direções -> {mid, land} ou null
  const CENTRALITY  = new Float32Array(SIZE);

  (function precompute() {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c;

        NEIGHBORS[i] = DIRS.map(([dr, dc]) => {
          const nr = r + dr, nc = c + dc;
          return (nr >= 0 && nr < N && nc >= 0 && nc < N) ? nr * N + nc : -1;
        });

        ORTHO_NEIGH[i] = ORTHO.map(([dr, dc]) => {
          const nr = r + dr, nc = c + dc;
          return (nr >= 0 && nr < N && nc >= 0 && nc < N) ? nr * N + nc : -1;
        }).filter(x => x >= 0);

        JUMPS[i] = DIRS.map(([dr, dc]) => {
          const mr = r + dr,     mc = c + dc;
          const lr = r + dr * 2, lc = c + dc * 2;
          if (lr < 0 || lr >= N || lc < 0 || lc >= N) return null;
          return { mid: mr * N + mc, land: lr * N + lc };
        });

        const mid = (N - 1) / 2;
        const dist = Math.max(Math.abs(r - mid), Math.abs(c - mid));
        CENTRALITY[i] = 1 - dist / mid;   // 1 no centro, 0 na borda
      }
    }
  })();

  /* ------------------------------------------------------------------ */
  /* Primitivas                                                          */
  /* ------------------------------------------------------------------ */
  const idx   = (r, c) => r * N + c;
  const rowOf = i => (i / N) | 0;
  const colOf = i => i % N;

  function ownerOf(piece) {
    if (piece === CORE_A || piece === SENT_A) return A;
    if (piece === CORE_B || piece === SENT_B) return B;
    return 0;
  }
  const isCore     = p => p === CORE_A || p === CORE_B;
  const isSentinel = p => p === SENT_A || p === SENT_B;
  const opponent   = p => (p === A ? B : A);

  /* ------------------------------------------------------------------ */
  /* Estado                                                              */
  /* ------------------------------------------------------------------ */

  /** Formação inicial: Núcleo na base central + 10 Sentinelas espelhadas. */
  function createInitialState() {
    const board = new Int8Array(SIZE);
    const aura  = new Int8Array(SIZE);

    const backSent  = [1, 2, 3, 5, 6, 7];
    const frontSent = [2, 3, 5, 6];

    board[idx(8, 4)] = CORE_A;
    backSent.forEach(c => { board[idx(8, c)] = SENT_A; });
    frontSent.forEach(c => { board[idx(7, c)] = SENT_A; });

    board[idx(0, 4)] = CORE_B;
    backSent.forEach(c => { board[idx(0, c)] = SENT_B; });
    frontSent.forEach(c => { board[idx(1, c)] = SENT_B; });

    for (let i = 0; i < SIZE; i++) {
      const o = ownerOf(board[i]);
      if (o) aura[i] = o;
    }

    return {
      board, aura,
      turn: A,
      ply: 0,
      status: 'playing',
      winner: null,
      reason: null,
      lastMove: null
    };
  }

  function cloneState(s) {
    return {
      board: s.board.slice(),
      aura: s.aura.slice(),
      turn: s.turn,
      ply: s.ply,
      status: s.status,
      winner: s.winner,
      reason: s.reason,
      lastMove: s.lastMove
    };
  }

  /* ------------------------------------------------------------------ */
  /* Geração de movimentos                                               */
  /* ------------------------------------------------------------------ */

  /** Passo simples: 1 casa em qualquer das 8 direções, para casa vazia. */
  function generateStepMoves(state, from, out) {
    const neigh = NEIGHBORS[from];
    for (let d = 0; d < 8; d++) {
      const to = neigh[d];
      if (to < 0 || state.board[to] !== EMPTY) continue;
      out.push({ from, to, path: [to], captures: [], type: 'step' });
    }
    return out;
  }

  /**
   * Saltos encadeados (estilo damas). Só Sentinelas inimigas podem ser
   * saltadas — o Núcleo é imune ao salto e só cai por Cerco.
   * Retorna apenas sequências maximais (não permite parar no meio da cadeia).
   */
  function generateJumpMoves(state, from, out) {
    const board = state.board;
    const me = ownerOf(board[from]);
    const piece = board[from];
    board[from] = EMPTY;              // a própria peça não bloqueia o pouso

    const path = [];
    const captured = [];

    (function dfs(pos) {
      let extended = false;
      const jumps = JUMPS[pos];
      for (let d = 0; d < 8; d++) {
        const j = jumps[d];
        if (!j) continue;
        const victim = board[j.mid];
        if (!isSentinel(victim) || ownerOf(victim) === me) continue;
        if (board[j.land] !== EMPTY) continue;

        extended = true;
        board[j.mid] = EMPTY;
        path.push(j.land);
        captured.push(j.mid);

        dfs(j.land);

        path.pop();
        captured.pop();
        board[j.mid] = victim;
      }
      if (!extended && path.length > 0) {
        out.push({
          from,
          to: pos,
          path: path.slice(),
          captures: captured.slice(),
          type: 'jump'
        });
      }
    })(from);

    board[from] = piece;
    return out;
  }

  function generateMovesForPiece(state, from) {
    if (state.board[from] === EMPTY) return [];
    const out = [];
    generateJumpMoves(state, from, out);
    generateStepMoves(state, from, out);
    return out;
  }

  function generateAllMoves(state, player = state.turn) {
    const out = [];
    for (let i = 0; i < SIZE; i++) {
      if (ownerOf(state.board[i]) !== player) continue;
      generateJumpMoves(state, i, out);
      generateStepMoves(state, i, out);
    }
    return out;
  }

  const moveKey = m => `${m.from}>${m.path.join('.')}`;

  function findMove(moves, from, path) {
    const key = `${from}>${path.join('.')}`;
    return moves.find(m => moveKey(m) === key) || null;
  }

  /* ------------------------------------------------------------------ */
  /* Cerco — Flood Fill de grupos e liberdades                           */
  /* ------------------------------------------------------------------ */

  /**
   * Percorre o tabuleiro agrupando peças do `victim` conectadas
   * ortogonalmente. Uma liberdade é uma casa vazia adjacente ao grupo cuja
   * Aura NÃO pertence ao `attacker`. Grupos com zero liberdades morrem.
   *
   * Complexidade: O(SIZE) amortizado — cada casa é visitada uma única vez.
   */
  function findSuffocatedGroups(state, victim, attacker) {
    const board = state.board, aura = state.aura;
    const visited = new Uint8Array(SIZE);
    const stack = new Int32Array(SIZE);
    const doomed = [];

    for (let start = 0; start < SIZE; start++) {
      if (visited[start]) continue;
      if (ownerOf(board[start]) !== victim) continue;

      let sp = 0;
      stack[sp++] = start;
      visited[start] = 1;

      const group = [];
      let liberties = 0;

      while (sp > 0) {
        const cur = stack[--sp];
        group.push(cur);

        const neigh = ORTHO_NEIGH[cur];
        for (let k = 0; k < neigh.length; k++) {
          const nb = neigh[k];
          const cell = board[nb];
          if (cell === EMPTY) {
            // Casa vazia só respira se não estiver dominada pelo atacante.
            if (aura[nb] !== attacker) liberties++;
          } else if (ownerOf(cell) === victim) {
            if (!visited[nb]) { visited[nb] = 1; stack[sp++] = nb; }
          }
          // peça inimiga adjacente = parede sólida
        }
      }

      if (liberties === 0) doomed.push(group);
    }
    return doomed;
  }

  /**
   * Resolve o cerco ao fim do turno: primeiro sufoca o inimigo, depois
   * verifica auto-sufocamento (suicídio) de quem jogou.
   * Retorna a lista de capturas para a camada de animação.
   */
  function resolveSiege(state, attacker) {
    const captured = [];
    const victim = opponent(attacker);

    findSuffocatedGroups(state, victim, attacker).forEach(group => {
      group.forEach(i => {
        captured.push({ index: i, piece: state.board[i], by: attacker, kind: 'siege' });
        state.board[i] = EMPTY;
        state.aura[i] = attacker;
      });
    });

    findSuffocatedGroups(state, attacker, victim).forEach(group => {
      group.forEach(i => {
        captured.push({ index: i, piece: state.board[i], by: victim, kind: 'suicide' });
        state.board[i] = EMPTY;
        state.aura[i] = victim;
      });
    });

    return captured;
  }

  /* ------------------------------------------------------------------ */
  /* Território e condições de vitória                                   */
  /* ------------------------------------------------------------------ */

  function territoryCount(state) {
    const t = [0, 0, 0];
    for (let i = 0; i < SIZE; i++) t[state.aura[i]]++;
    return { neutral: t[0], [A]: t[1], [B]: t[2] };
  }

  const territoryRatio = (state, player) => territoryCount(state)[player] / SIZE;

  function hasCore(state, player) {
    const target = player === A ? CORE_A : CORE_B;
    for (let i = 0; i < SIZE; i++) if (state.board[i] === target) return true;
    return false;
  }

  function countPieces(state, player) {
    let cores = 0, sentinels = 0;
    for (let i = 0; i < SIZE; i++) {
      const p = state.board[i];
      if (ownerOf(p) !== player) continue;
      if (isCore(p)) cores++; else sentinels++;
    }
    return { cores, sentinels };
  }

  const TERRITORY_THRESHOLD = Math.ceil(SIZE * 0.70);   // 57 de 81

  /**
   * Trava de segurança: duas Auras bem defendidas podem repintar as mesmas
   * casas indefinidamente. Ao atingir o teto, arbitra-se pelo território.
   */
  const MAX_PLIES = 300;

  function evaluateTermination(state) {
    const aCore = hasCore(state, A);
    const bCore = hasCore(state, B);
    if (!aCore && !bCore) return { winner: 0, reason: 'double_core' };
    if (!bCore) return { winner: A, reason: 'core' };
    if (!aCore) return { winner: B, reason: 'core' };

    const t = territoryCount(state);
    if (t[A] >= TERRITORY_THRESHOLD) return { winner: A, reason: 'territory' };
    if (t[B] >= TERRITORY_THRESHOLD) return { winner: B, reason: 'territory' };

    if (generateAllMoves(state, state.turn).length === 0) {
      return { winner: opponent(state.turn), reason: 'stalemate' };
    }

    if (state.ply >= MAX_PLIES) {
      if (t[A] === t[B]) return { winner: 0, reason: 'adjudication' };
      return { winner: t[A] > t[B] ? A : B, reason: 'adjudication' };
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Aplicação de jogada                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Aplica um movimento e devolve um NOVO estado (imutável para o chamador).
   * Ordem: mover -> pintar Aura -> remover saltadas -> Cerco -> término.
   */
  function applyMove(state, move) {
    const next = cloneState(state);
    const piece = next.board[move.from];
    const player = ownerOf(piece);

    next.board[move.from] = EMPTY;
    next.aura[move.from] = player;                      // "a casa onde passou"

    for (let i = 0; i < move.path.length; i++) next.aura[move.path[i]] = player;
    for (let i = 0; i < move.captures.length; i++) {
      next.aura[move.captures[i]] = player;
      next.board[move.captures[i]] = EMPTY;
    }

    next.board[move.to] = piece;

    const siege = resolveSiege(next, player);

    next.ply = state.ply + 1;
    next.turn = opponent(player);
    next.lastMove = {
      from: move.from,
      to: move.to,
      path: move.path.slice(),
      jumpCaptures: move.captures.slice(),
      siegeCaptures: siege.map(c => c.index),
      siegeDetail: siege,
      by: player,
      type: move.type
    };

    const end = evaluateTermination(next);
    if (end) {
      next.status = 'finished';
      next.winner = end.winner;
      next.reason = end.reason;
    }
    return next;
  }

  /* ------------------------------------------------------------------ */
  /* Serialização compacta (mesma do servidor)                           */
  /* ------------------------------------------------------------------ */

  function serialize(state) {
    return {
      b: Array.from(state.board).join(''),
      a: Array.from(state.aura).join(''),
      t: state.turn,
      p: state.ply,
      s: state.status,
      w: state.winner,
      r: state.reason,
      m: state.lastMove
    };
  }

  function deserialize(o) {
    if (!o) return createInitialState();
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return createInitialState(); } }
    const board = new Int8Array(SIZE);
    const aura  = new Int8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      board[i] = Number(o.b[i]) || 0;
      aura[i]  = Number(o.a[i]) || 0;
    }
    return {
      board, aura,
      turn: o.t,
      ply: o.p,
      status: o.s,
      winner: (o.w === undefined ? null : o.w),
      reason: o.r || null,
      lastMove: o.m || null
    };
  }

  /* ------------------------------------------------------------------ */
  /* Utilidades para a UI                                                */
  /* ------------------------------------------------------------------ */

  /** Mapa índiceDestino -> movimento, para desenhar os alvos válidos. */
  function targetsFor(state, from) {
    const map = new Map();
    generateMovesForPiece(state, from).forEach(m => {
      const existing = map.get(m.to);
      // prioriza o salto (mais capturas) quando dois movimentos terminam igual
      if (!existing || m.captures.length > existing.captures.length) map.set(m.to, m);
    });
    return map;
  }

  /** Cria um estado a partir de uma descrição declarativa (tutorial/testes). */
  function fromLayout(layout, auraLayout) {
    const s = {
      board: new Int8Array(SIZE),
      aura: new Int8Array(SIZE),
      turn: A, ply: 0, status: 'playing', winner: null, reason: null, lastMove: null
    };
    Object.entries(layout || {}).forEach(([i, piece]) => { s.board[Number(i)] = piece; });
    Object.entries(auraLayout || {}).forEach(([i, owner]) => { s.aura[Number(i)] = owner; });
    return s;
  }

  root.AuraRules = {
    N, SIZE, A, B, EMPTY, CORE_A, SENT_A, CORE_B, SENT_B,
    DIRS, ORTHO, NEIGHBORS, ORTHO_NEIGH, JUMPS, CENTRALITY,
    TERRITORY_THRESHOLD, MAX_PLIES,
    idx, rowOf, colOf, ownerOf, isCore, isSentinel, opponent,
    createInitialState, cloneState, fromLayout,
    generateStepMoves, generateJumpMoves, generateMovesForPiece, generateAllMoves,
    moveKey, findMove, targetsFor,
    findSuffocatedGroups, resolveSiege,
    territoryCount, territoryRatio, hasCore, countPieces,
    evaluateTermination, applyMove,
    serialize, deserialize
  };
})(typeof self !== 'undefined' ? self : this);
