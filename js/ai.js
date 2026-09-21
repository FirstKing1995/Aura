/**
 * ============================================================================
 *  AURA — Inteligência Artificial
 * ============================================================================
 *  Engine de busca adversarial:
 *    - Negamax com poda Alpha-Beta
 *    - Aprofundamento iterativo com controle de tempo (deadline)
 *    - Tabela de transposição com hashing Zobrist (flags EXACT/LOWER/UPPER)
 *    - Ordenação de movimentos: TT-move > capturas > killer moves > history
 *    - Busca de quiescência sobre saltos (evita o efeito horizonte)
 *    - Função de avaliação multi-fator (material, território, mobilidade,
 *      segurança do Núcleo, pressão de cerco, centralidade)
 *
 *  O arquivo é carregado tanto na thread principal quanto no Web Worker,
 *  portanto não depende de DOM.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const R = root.AuraRules;
  if (!R) throw new Error('ai.js requer rules.js carregado antes.');

  const INF = 1e9;
  const MATE = 1e7;
  const TIMEOUT = { __timeout: true };

  /* ------------------------------------------------------------------ */
  /* Zobrist hashing                                                     */
  /* ------------------------------------------------------------------ */
  const Zobrist = (() => {
    // PRNG determinístico (xorshift32) para que o hash seja reprodutível.
    let seed = 0x9E3779B9;
    const next = () => {
      seed ^= seed << 13; seed |= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;  seed |= 0;
      return seed >>> 0;
    };

    const piece = [];   // [cell][pieceCode] -> [h1,h2]
    const aura  = [];   // [cell][owner]     -> [h1,h2]
    for (let i = 0; i < R.SIZE; i++) {
      piece[i] = [];
      for (let p = 0; p <= 4; p++) piece[i][p] = [next(), next()];
      aura[i] = [];
      for (let o = 0; o <= 2; o++) aura[i][o] = [next(), next()];
    }
    const side = [next(), next()];

    function hash(state) {
      let h1 = 0, h2 = 0;
      for (let i = 0; i < R.SIZE; i++) {
        const p = state.board[i];
        if (p) { h1 ^= piece[i][p][0]; h2 ^= piece[i][p][1]; }
        const a = state.aura[i];
        if (a) { h1 ^= aura[i][a][0]; h2 ^= aura[i][a][1]; }
      }
      if (state.turn === R.B) { h1 ^= side[0]; h2 ^= side[1]; }
      return ((h1 >>> 0).toString(36)) + ':' + ((h2 >>> 0).toString(36));
    }

    return { hash };
  })();

  /* ------------------------------------------------------------------ */
  /* Pesos da avaliação                                                  */
  /* ------------------------------------------------------------------ */
  const W = Object.freeze({
    CORE: 100000,
    SENTINEL: 320,
    TERRITORY: 26,
    MOBILITY: 4,
    JUMP_THREAT: 46,
    CENTRALITY: 12,
    CORE_LIBERTY: 22,
    CORE_PANIC: 2600,
    GROUP_PRESSURE: 34,
    ADVANCE: 6,
    TERRITORY_RUSH: 140    // bônus acelerado perto do limiar de 70%
  });

  /* ------------------------------------------------------------------ */
  /* Avaliação                                                           */
  /* ------------------------------------------------------------------ */

  /** Liberdades do grupo que contém `origin` (flood fill local). */
  function groupLiberties(state, origin, attacker) {
    const owner = R.ownerOf(state.board[origin]);
    if (!owner) return 0;
    const seen = new Set([origin]);
    const stack = [origin];
    let liberties = 0;
    while (stack.length) {
      const cur = stack.pop();
      const neigh = R.ORTHO_NEIGH[cur];
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

  function coreIndex(state, player) {
    const target = player === R.A ? R.CORE_A : R.CORE_B;
    for (let i = 0; i < R.SIZE; i++) if (state.board[i] === target) return i;
    return -1;
  }

  /** Quantos saltos `player` tem disponíveis (pressão tática). */
  function countJumpThreats(state, player) {
    let count = 0;
    for (let i = 0; i < R.SIZE; i++) {
      if (R.ownerOf(state.board[i]) !== player) continue;
      const jumps = R.JUMPS[i];
      for (let d = 0; d < 8; d++) {
        const j = jumps[d];
        if (!j) continue;
        const victim = state.board[j.mid];
        if (R.isSentinel(victim) && R.ownerOf(victim) !== player &&
            state.board[j.land] === R.EMPTY) count++;
      }
    }
    return count;
  }

  /**
   * Score do ponto de vista de `me` (positivo = bom para `me`).
   * Todos os termos são simétricos: calcula-se para os dois lados e subtrai.
   */
  function evaluate(state, me) {
    const foe = R.opponent(me);

    if (state.status === 'finished') {
      if (state.winner === me) return MATE - state.ply;
      if (state.winner === foe) return -MATE + state.ply;
      return 0;
    }

    const mine = R.countPieces(state, me);
    const theirs = R.countPieces(state, foe);

    let score = 0;

    // 1. Material
    score += (mine.cores - theirs.cores) * W.CORE;
    score += (mine.sentinels - theirs.sentinels) * W.SENTINEL;

    // 2. Território (com aceleração perto do limiar de vitória)
    const t = R.territoryCount(state);
    const myT = t[me], foeT = t[foe];
    score += (myT - foeT) * W.TERRITORY;
    const threshold = R.TERRITORY_THRESHOLD;
    if (myT > threshold * 0.72) score += (myT - threshold * 0.72) * W.TERRITORY_RUSH;
    if (foeT > threshold * 0.72) score -= (foeT - threshold * 0.72) * W.TERRITORY_RUSH;

    // 3. Estrutura: centralidade e avanço
    for (let i = 0; i < R.SIZE; i++) {
      const p = state.board[i];
      if (!p) continue;
      const owner = R.ownerOf(p);
      const sign = owner === me ? 1 : -1;
      score += sign * R.CENTRALITY[i] * W.CENTRALITY;
      // avanço em direção ao campo inimigo
      const row = R.rowOf(i);
      const advance = owner === R.A ? (8 - row) : row;
      if (!R.isCore(p)) score += sign * advance * W.ADVANCE;
    }

    // 4. Segurança do Núcleo
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

    // 5. Pressão tática
    score += (countJumpThreats(state, me) - countJumpThreats(state, foe)) * W.JUMP_THREAT;

    // 6. Mobilidade (cara: só conta para o lado da vez + estimativa do outro)
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
    constructor(options = {}) {
      this.maxDepth = options.depth || 3;
      this.timeMs = options.timeMs || 1500;
      this.noise = options.noise || 0;
      this.quiescenceDepth = options.quiescenceDepth ?? 3;
      this.tt = new Map();
      this.killers = [];
      this.history = new Int32Array(R.SIZE * R.SIZE);
      this.nodes = 0;
      this.deadline = 0;
      this.aborted = false;
    }

    /* --- ordenação --------------------------------------------------- */

    scoreMove(move, ply, ttKey) {
      let s = 0;
      if (ttKey && move.__ttBest) s += 1e6;
      s += move.captures.length * 9000;
      const killer = this.killers[ply];
      if (killer && killer === R.moveKey(move)) s += 4200;
      s += this.history[move.from * R.SIZE + move.to];
      s += R.CENTRALITY[move.to] * 120;
      return s;
    }

    orderMoves(moves, ply, ttMoveKey) {
      for (const m of moves) {
        m.__ttBest = ttMoveKey && R.moveKey(m) === ttMoveKey;
        m.__score = this.scoreMove(m, ply, ttMoveKey);
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

      for (const m of captures) {
        const child = R.applyMove(state, m);
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

        // Late Move Reduction: movimentos tardios e sem captura vão 1 nível a menos.
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
            this.history[m.from * R.SIZE + m.to] += depth * depth;
          }
          break;
        }
      }

      const flag = best <= alphaOrig ? 'UPPER' : (best >= betaOrig ? 'LOWER' : 'EXACT');
      this.tt.set(key, { depth, score: best, flag, best: bestKey });
      if (this.tt.size > 220000) this.tt.clear();

      return best;
    }

    /* --- raiz com aprofundamento iterativo ---------------------------- */

    findBestMove(state, player) {
      const started = Date.now();
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
        let alpha = -INF, beta = INF;
        let localBest = null, localScore = -INF;
        const ordered = this.orderMoves(rootMoves.slice(), 0, R.moveKey(bestMove));

        try {
          for (const m of ordered) {
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
        if (Math.abs(bestScore) > MATE / 2) break;         // vitória/derrota forçada
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
    return { from: m.from, to: m.to, path: m.path.slice(), captures: m.captures.slice(), type: m.type };
  }

  /* ------------------------------------------------------------------ */
  /* API síncrona (usada pelo Worker e como fallback)                    */
  /* ------------------------------------------------------------------ */
  function think(state, player, options) {
    const engine = new SearchEngine(options || {});
    return engine.findBestMove(state, player);
  }

  root.AuraAI = { SearchEngine, evaluate, think, Zobrist, WEIGHTS: W, groupLiberties, coreIndex };
})(typeof self !== 'undefined' ? self : this);
