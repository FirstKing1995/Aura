/**
 * ============================================================================
 *  AURA — Inteligência Artificial
 * ============================================================================
 *  Engine de busca adversarial:
 *    - Negamax com poda Alpha-Beta
 *    - Aprofundamento iterativo com controle de tempo (deadline)
 *    - Tabela de transposição com hashing Zobrist (EXACT/LOWER/UPPER)
 *    - Ordenação: TT-move > capturas > killer moves > history > centralidade
 *    - Quiescência sobre saltos (mata o efeito horizonte)
 *    - Avaliação multi-fator, agora ciente de 5 tipos de peça, casas
 *      bloqueadas, portais e do poder de pintura de cada peça
 *
 *  Roda tanto na thread principal quanto dentro do Web Worker: zero DOM.
 *  Como as arenas têm tamanhos diferentes, todas as tabelas dependentes de
 *  tamanho são criadas sob demanda e cacheadas por N.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const R = root.AuraRules;
  if (!R) throw new Error('ai.js requer rules.js carregado antes.');

  const INF = 1e9;
  const MATE = 1e7;
  const TIMEOUT = { __timeout: true };

  const MAX_PIECE_CODE = (2 << 3) | 5;          // 21

  /* ------------------------------------------------------------------ */
  /* Zobrist hashing (uma tabela por tamanho de tabuleiro)               */
  /* ------------------------------------------------------------------ */
  const Zobrist = (function () {
    const TABLES = new Map();

    function tableFor(size) {
      const cached = TABLES.get(size);
      if (cached) return cached;

      // PRNG determinístico (xorshift32): o hash é reprodutível entre sessões.
      let seed = 0x9E3779B9 ^ size;
      const next = function () {
        seed ^= seed << 13; seed |= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5;  seed |= 0;
        return seed >>> 0;
      };

      const piece = [];   // [casa][código] -> [h1,h2]
      const aura  = [];   // [casa][dono]   -> [h1,h2]
      for (let i = 0; i < size; i++) {
        piece[i] = [];
        for (let p = 0; p <= MAX_PIECE_CODE; p++) piece[i][p] = [next(), next()];
        aura[i] = [];
        for (let o = 0; o <= 2; o++) aura[i][o] = [next(), next()];
      }
      const side = [next(), next()];

      const t = { piece: piece, aura: aura, side: side };
      TABLES.set(size, t);
      return t;
    }

    function hash(state) {
      const size = state.arena.SIZE;
      const t = tableFor(size);
      let h1 = 0, h2 = 0;
      for (let i = 0; i < size; i++) {
        const p = state.board[i];
        if (p) { h1 ^= t.piece[i][p][0]; h2 ^= t.piece[i][p][1]; }
        const a = state.aura[i];
        if (a) { h1 ^= t.aura[i][a][0]; h2 ^= t.aura[i][a][1]; }
      }
      if (state.turn === R.B) { h1 ^= t.side[0]; h2 ^= t.side[1]; }
      return ((h1 >>> 0).toString(36)) + ':' + ((h2 >>> 0).toString(36));
    }

    return { hash: hash, tableFor: tableFor };
  })();

  /* ------------------------------------------------------------------ */
  /* Pesos                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Valor material por tipo. O Guardião vale mais que a Sentinela porque é
   * imune a salto e pinta 4 casas por lance; o Prisma vale quase o mesmo
   * (pinta 4, mas é saltável); a Lâmina troca pintura por alcance.
   */
  const PIECE_VALUE = {
    1: 100000,   // Núcleo
    2: 320,      // Sentinela
    3: 430,      // Lâmina
    4: 500,      // Prisma
    5: 560       // Guardião
  };

  const W = Object.freeze({
    TERRITORY: 26,
    MOBILITY: 4,
    JUMP_THREAT: 46,
    CENTRALITY: 12,
    CORE_LIBERTY: 22,
    CORE_PANIC: 2600,
    ADVANCE: 6,
    TERRITORY_RUSH: 140,   // aceleração perto do limiar de vitória
    PORTAL_HOLD: 34,       // ocupar um portal é posição, não sorte
    RADIATOR_SPACE: 9,     // Prisma/Guardião com espaço livre em volta pintam mais
    PIECE_VALUE: PIECE_VALUE
  });

  /* ------------------------------------------------------------------ */
  /* Avaliação                                                           */
  /* ------------------------------------------------------------------ */

  /** Liberdades do grupo que contém `origin`, do ponto de vista do atacante. */
  function groupLiberties(state, origin, attacker) {
    const arena = state.arena;
    const owner = R.ownerOf(state.board[origin]);
    if (!owner) return 0;
    const seen = new Set([origin]);
    const stack = [origin];
    let liberties = 0;
    while (stack.length) {
      const cur = stack.pop();
      const neigh = arena.adjSiege[cur];
      for (let k = 0; k < neigh.length; k++) {
        const nb = neigh[k];
        const cell = state.board[nb];
        if (cell === R.EMPTY) {
          if (state.aura[nb] !== attacker) liberties++;
        } else if (R.ownerOf(cell) === owner && !seen.has(nb)) {
          seen.add(nb); stack.push(nb);
        }
      }
    }
    return liberties;
  }

  const coreIndex = (state, player) => R.coreIndex(state, player);

  /** Saltos disponíveis para `player` — pressão tática imediata. */
  function countJumpThreats(state, player) {
    const arena = state.arena;
    let count = 0;
    for (let i = 0; i < arena.SIZE; i++) {
      const p = state.board[i];
      if (R.ownerOf(p) !== player) continue;
      const kind = R.kindOf(p);
      let dirs;
      if (kind === R.SENT) dirs = R.ALL_D;
      else if (kind === R.BLADE) dirs = R.ORTHO_D;
      else if (kind === R.PRISM) dirs = R.DIAG_D;
      else continue;                              // Núcleo e Guardião não saltam

      for (let d = 0; d < dirs.length; d++) {
        const j = arena.geo.JUMPS[i][dirs[d]];
        if (!j) continue;
        if (arena.blocked[j.mid] || arena.blocked[j.land]) continue;
        const victim = state.board[j.mid];
        if (R.isJumpable(victim) && R.ownerOf(victim) !== player &&
            state.board[j.land] === R.EMPTY) count++;
      }
    }
    return count;
  }

  /**
   * Score do ponto de vista de `me` (positivo = bom para `me`).
   * Todos os termos são simétricos: calculados para os dois lados e subtraídos.
   */
  function evaluate(state, me) {
    const arena = state.arena;
    const foe = R.opponent(me);

    if (state.status === 'finished') {
      if (state.winner === me) return MATE - state.ply;
      if (state.winner === foe) return -MATE + state.ply;
      return 0;
    }

    let score = 0;
    const lastRow = arena.N - 1;

    // 1. Material + estrutura, em uma única varredura
    for (let i = 0; i < arena.SIZE; i++) {
      const p = state.board[i];
      if (!p) continue;
      const owner = R.ownerOf(p);
      const kind = R.kindOf(p);
      const sign = owner === me ? 1 : -1;

      score += sign * PIECE_VALUE[kind];
      score += sign * arena.geo.CENTRALITY[i] * W.CENTRALITY;

      if (kind !== R.CORE) {
        const row = R.rowOn(arena, i);
        const advance = owner === R.A ? (lastRow - row) : row;
        score += sign * advance * W.ADVANCE;
      }

      if (arena.portal[i] >= 0) score += sign * W.PORTAL_HOLD;

      // peças que irradiam valem mais com vizinhança livre para pintar
      if (kind === R.PRISM || kind === R.WARDEN) {
        const beam = R.radiationOf(arena, kind, i);
        let free = 0;
        for (let k = 0; k < beam.length; k++) if (state.aura[beam[k]] !== owner) free++;
        score += sign * free * W.RADIATOR_SPACE;
      }
    }

    // 2. Território (com aceleração perto do limiar)
    const t = R.territoryCount(state);
    const myT = t[me], foeT = t[foe];
    score += (myT - foeT) * W.TERRITORY;
    const threshold = arena.territoryThreshold;
    if (myT > threshold * 0.72) score += (myT - threshold * 0.72) * W.TERRITORY_RUSH;
    if (foeT > threshold * 0.72) score -= (foeT - threshold * 0.72) * W.TERRITORY_RUSH;

    // 3. Segurança do Núcleo
    const myCore = coreIndex(state, me);
    const foeCore = coreIndex(state, foe);
    if (myCore >= 0) {
      const lib = groupLiberties(state, myCore, foe);
      score += lib * W.CORE_LIBERTY;
      if (lib <= 1) score -= W.CORE_PANIC;
      else if (lib === 2) score -= W.CORE_PANIC * 0.35;
    }
    if (foeCore >= 0) {
      const lib = groupLiberties(state, foeCore, me);
      score -= lib * W.CORE_LIBERTY;
      if (lib <= 1) score += W.CORE_PANIC;
      else if (lib === 2) score += W.CORE_PANIC * 0.35;
    }

    // 4. Pressão tática
    score += (countJumpThreats(state, me) - countJumpThreats(state, foe)) * W.JUMP_THREAT;

    // 5. Mobilidade
    const myMoves = R.generateAllMoves(state, me).length;
    const foeMoves = R.generateAllMoves(state, foe).length;
    score += (myMoves - foeMoves) * W.MOBILITY;
    if (myMoves === 0) score -= MATE / 2;
    if (foeMoves === 0) score += MATE / 2;

    return score;
  }

  /* ------------------------------------------------------------------ */
  /* Motor de busca                                                      */
  /* ------------------------------------------------------------------ */

  class SearchEngine {
    constructor(options) {
      const o = options || {};
      this.maxDepth = o.depth || 3;
      this.timeMs = o.timeMs || 1500;
      this.noise = o.noise || 0;
      this.quiescenceDepth = o.quiescenceDepth === undefined ? 3 : o.quiescenceDepth;
      this.tt = new Map();
      this.killers = [];
      this.history = null;          // dimensionada na raiz, já sabendo a arena
      this.size = 0;
      this.nodes = 0;
      this.deadline = 0;
      this.aborted = false;
    }

    _prepare(state) {
      const size = state.arena.SIZE;
      if (this.size !== size || !this.history) {
        this.size = size;
        this.history = new Int32Array(size * size);
      }
      this.centrality = state.arena.geo.CENTRALITY;
    }

    /* --- ordenação --------------------------------------------------- */

    scoreMove(move, ply) {
      let s = 0;
      if (move.__ttBest) s += 1e6;
      s += move.captures.length * 9000;
      const killer = this.killers[ply];
      if (killer && killer === R.moveKey(move)) s += 4200;
      s += this.history[move.from * this.size + move.to];
      s += this.centrality[move.to] * 120;
      // lances que pintam mais casas sobem: território é vitória
      s += move.path.length * 55;
      if (move.kind === R.PRISM || move.kind === R.WARDEN) s += 40;
      if (move.type === 'portal') s += 70;
      return s;
    }

    orderMoves(moves, ply, ttMoveKey) {
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        m.__ttBest = !!ttMoveKey && R.moveKey(m) === ttMoveKey;
        m.__score = this.scoreMove(m, ply);
      }
      moves.sort((a, b) => b.__score - a.__score);
      return moves;
    }

    checkTime() {
      if ((this.nodes & 511) === 0 && Date.now() > this.deadline) {
        this.aborted = true;
        throw TIMEOUT;
      }
    }

    /* --- quiescência -------------------------------------------------- */

    quiescence(state, me, alpha, beta, qdepth) {
      this.nodes++;
      this.checkTime();

      const standPat = evaluate(state, me);
      if (state.status === 'finished' || qdepth <= 0) return standPat;

      const maximizing = state.turn === me;
      if (maximizing) {
        if (standPat >= beta) return beta;
        if (standPat > alpha) alpha = standPat;
      } else {
        if (standPat <= alpha) return alpha;
        if (standPat < beta) beta = standPat;
      }

      const captures = R.generateAllMoves(state, state.turn)
        .filter(m => m.captures.length > 0)
        .sort((a, b) => b.captures.length - a.captures.length);

      if (!captures.length) return standPat;

      for (let i = 0; i < captures.length; i++) {
        const child = R.applyMove(state, captures[i]);
        const score = this.quiescence(child, me, alpha, beta, qdepth - 1);
        if (maximizing) {
          if (score >= beta) return beta;
          if (score > alpha) alpha = score;
        } else {
          if (score <= alpha) return alpha;
          if (score < beta) beta = score;
        }
      }
      return maximizing ? alpha : beta;
    }

    /* --- alpha-beta --------------------------------------------------- */

    search(state, me, depth, alpha, beta, ply) {
      this.nodes++;
      this.checkTime();

      if (state.status === 'finished') return evaluate(state, me);

      const key = Zobrist.hash(state);
      const entry = this.tt.get(key);
      let ttMoveKey = null;

      if (entry) {
        ttMoveKey = entry.best;
        if (entry.depth >= depth) {
          if (entry.flag === 'EXACT') return entry.score;
          if (entry.flag === 'LOWER' && entry.score > alpha) alpha = entry.score;
          else if (entry.flag === 'UPPER' && entry.score < beta) beta = entry.score;
          if (alpha >= beta) return entry.score;
        }
      }

      if (depth <= 0) return this.quiescence(state, me, alpha, beta, this.quiescenceDepth);

      const moves = this.orderMoves(R.generateAllMoves(state, state.turn), ply, ttMoveKey);
      if (!moves.length) return evaluate(state, me);

      const maximizing = state.turn === me;
      const alphaOrig = alpha, betaOrig = beta;
      let best = maximizing ? -INF : INF;
      let bestKey = null;

      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const child = R.applyMove(state, m);

        // Late Move Reduction: lances tardios e sem captura vão 1 nível a menos.
        let reduction = 0;
        if (depth >= 3 && i >= 6 && m.captures.length === 0) reduction = 1;

        let score = this.search(child, me, depth - 1 - reduction, alpha, beta, ply + 1);
        if (reduction && ((maximizing && score > alpha) || (!maximizing && score < beta))) {
          score = this.search(child, me, depth - 1, alpha, beta, ply + 1);   // re-busca
        }

        if (maximizing) {
          if (score > best) { best = score; bestKey = R.moveKey(m); }
          if (best > alpha) alpha = best;
        } else {
          if (score < best) { best = score; bestKey = R.moveKey(m); }
          if (best < beta) beta = best;
        }

        if (alpha >= beta) {
          if (m.captures.length === 0) {
            this.killers[ply] = R.moveKey(m);
            this.history[m.from * this.size + m.to] += depth * depth;
          }
          break;
        }
      }

      const flag = best <= alphaOrig ? 'UPPER' : (best >= betaOrig ? 'LOWER' : 'EXACT');
      this.tt.set(key, { depth: depth, score: best, flag: flag, best: bestKey });
      if (this.tt.size > 220000) this.tt.clear();

      return best;
    }

    /* --- raiz com aprofundamento iterativo ---------------------------- */

    findBestMove(state, player) {
      const started = Date.now();
      this._prepare(state);
      this.deadline = started + this.timeMs;
      this.nodes = 0;
      this.aborted = false;
      this.killers = [];

      const rootMoves = R.generateAllMoves(state, player);
      if (!rootMoves.length) return { move: null, score: 0, depth: 0, nodes: 0, ms: 0 };
      if (rootMoves.length === 1) {
        return { move: strip(rootMoves[0]), score: 0, depth: 0, nodes: 1, ms: Date.now() - started };
      }

      let bestMove = rootMoves[0];
      let bestScore = -INF;
      let reachedDepth = 0;

      for (let depth = 1; depth <= this.maxDepth; depth++) {
        let alpha = -INF;
        const beta = INF;
        let localBest = null, localScore = -INF;
        const ordered = this.orderMoves(rootMoves.slice(), 0, R.moveKey(bestMove));

        try {
          for (let i = 0; i < ordered.length; i++) {
            const m = ordered[i];
            const child = R.applyMove(state, m);
            let score = this.search(child, player, depth - 1, alpha, beta, 1);

            // Ruído controlado dá personalidade aos níveis mais fáceis.
            if (this.noise) score += (Math.random() * 2 - 1) * this.noise;

            if (score > localScore) { localScore = score; localBest = m; }
            if (score > alpha) alpha = score;
          }
        } catch (err) {
          if (err !== TIMEOUT) throw err;
          break;                        // mantém o resultado da profundidade anterior
        }

        if (localBest) {
          bestMove = localBest;
          bestScore = localScore;
          reachedDepth = depth;
        }
        if (Math.abs(bestScore) > MATE / 2) break;        // vitória/derrota forçada
        if (Date.now() > this.deadline) break;
      }

      return {
        move: strip(bestMove),
        score: Math.round(bestScore),
        depth: reachedDepth,
        nodes: this.nodes,
        ms: Date.now() - started
      };
    }
  }

  /** Remove campos internos antes de cruzar a fronteira do Worker. */
  function strip(m) {
    return {
      from: m.from, to: m.to,
      path: m.path.slice(), captures: m.captures.slice(),
      type: m.type, kind: m.kind
    };
  }

  /* ------------------------------------------------------------------ */
  /* API síncrona (usada pelo Worker e como fallback)                    */
  /* ------------------------------------------------------------------ */
  function think(state, player, options) {
    const engine = new SearchEngine(options || {});
    return engine.findBestMove(state, player);
  }

  root.AuraAI = {
    SearchEngine: SearchEngine,
    evaluate: evaluate,
    think: think,
    Zobrist: Zobrist,
    WEIGHTS: W,
    PIECE_VALUE: PIECE_VALUE,
    groupLiberties: groupLiberties,
    coreIndex: coreIndex,
    countJumpThreats: countJumpThreats
  };
})(typeof self !== 'undefined' ? self : this);
