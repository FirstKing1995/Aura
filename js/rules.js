/**
 * ============================================================================
 *  AURA — Motor de regras (puro, determinístico, sem DOM)
 * ============================================================================
 *  Este arquivo é a ÚNICA fonte de verdade das regras. Ele roda em três
 *  lugares diferentes, byte a byte idêntico:
 *
 *    1. na thread principal do navegador (validação otimista + UI)
 *    2. dentro do Web Worker da IA (busca Negamax)
 *    3. dentro do Google Apps Script (árbitro autoritativo do online)
 *
 *  Por isso: nada de `document`, `window`, `fetch` ou sintaxe que o motor V8
 *  do Apps Script não aceite. Só matemática.
 *
 *  ── Codificação ────────────────────────────────────────────────────────────
 *  Uma peça cabe em um byte:   peça = (dono << 3) | tipo
 *      dono: 0 vazio | 1 (A, ciano) | 2 (B, magenta)
 *      tipo: 1 Núcleo | 2 Sentinela | 3 Lâmina | 4 Prisma | 5 Guardião
 *  Valor máximo = (2<<3)|5 = 21, o que permite serializar cada casa em UM
 *  caractere base36 — importante porque o estado inteiro viaja em uma célula
 *  de planilha a cada polling.
 *
 *  ── Movimento por tipo ─────────────────────────────────────────────────────
 *    Núcleo     1 casa, 8 direções.                    Imune a salto.
 *    Sentinela  1 casa, 8 direções.                    Salta em 8 direções.
 *    Lâmina     desliza 1–2 casas, 4 ortogonais.       Salta ortogonal.
 *    Prisma     desliza 1–2 casas, 4 diagonais.        Salta diagonal.
 *                 · ao parar, irradia Aura nas 4 diagonais vizinhas
 *    Guardião   1 casa, 4 ortogonais.                  Imune a salto.
 *                 · ao parar, irradia Aura nas 4 ortogonais vizinhas
 *
 *  Qualquer peça parada sobre um PORTAL pode atravessar para a casa gêmea.
 *
 *  ── Ordem de resolução de um lance ─────────────────────────────────────────
 *    mover → pintar origem/rastro → remover saltadas → irradiar → CERCO →
 *    checar término
 * ============================================================================
 */
(function (root) {
  'use strict';

  const ARENAS = root.AuraArenas;

  /* ================================================================== */
  /* 1. Vocabulário                                                     */
  /* ================================================================== */

  const EMPTY = 0;
  const A = 1, B = 2;

  const CORE = 1, SENT = 2, BLADE = 3, PRISM = 4, WARDEN = 5;

  const KIND_NAMES = { 1: 'core', 2: 'sentinel', 3: 'blade', 4: 'prism', 5: 'warden' };
  const KIND_FROM_CHAR = { K: CORE, S: SENT, L: BLADE, P: PRISM, G: WARDEN };

  const OWNER_SHIFT = 3;
  const KIND_MASK = 7;

  const piece    = (owner, kind) => (owner << OWNER_SHIFT) | kind;
  const ownerOf  = p => (p ? (p >> OWNER_SHIFT) : 0);
  const kindOf   = p => (p & KIND_MASK);
  const opponent = p => (p === A ? B : A);

  const isCore     = p => p !== EMPTY && kindOf(p) === CORE;
  const isSentinel = p => p !== EMPTY && kindOf(p) === SENT;

  /** Núcleo e Guardião não podem ser saltados: só caem por Cerco. */
  const isJumpable = p => {
    if (p === EMPTY) return false;
    const k = kindOf(p);
    return k !== CORE && k !== WARDEN;
  };

  // Aliases herdados da versão de peça única, mantidos para não quebrar
  // código antigo que ainda fale em CORE_A / SENT_B.
  const CORE_A = piece(A, CORE), SENT_A = piece(A, SENT);
  const CORE_B = piece(B, CORE), SENT_B = piece(B, SENT);

  /* ================================================================== */
  /* 2. Geometria (cacheada por tamanho de tabuleiro)                   */
  /* ================================================================== */

  const DIRS    = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const ORTHO_D = [1, 3, 4, 6];     // índices dentro de DIRS
  const DIAG_D  = [0, 2, 5, 7];

  const GEO_CACHE = new Map();

  /**
   * Tabelas puramente geométricas: não conhecem bloqueios nem portais.
   * Recalculá-las é caro; cada tamanho é computado uma única vez.
   */
  function geometry(N) {
    const cached = GEO_CACHE.get(N);
    if (cached) return cached;

    const SIZE = N * N;
    const NEIGH = new Array(SIZE);    // [8] -> índice ou -1
    const JUMPS = new Array(SIZE);    // [8] -> {mid, land} ou null
    const RAYS  = new Array(SIZE);    // [8] -> Int32Array com a reta inteira
    const CENTRALITY = new Float32Array(SIZE);
    const mid = (N - 1) / 2;

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c;

        NEIGH[i] = DIRS.map(function (d) {
          const nr = r + d[0], nc = c + d[1];
          return (nr >= 0 && nr < N && nc >= 0 && nc < N) ? nr * N + nc : -1;
        });

        JUMPS[i] = DIRS.map(function (d) {
          const mr = r + d[0],     mc = c + d[1];
          const lr = r + d[0] * 2, lc = c + d[1] * 2;
          if (lr < 0 || lr >= N || lc < 0 || lc >= N) return null;
          return { mid: mr * N + mc, land: lr * N + lc };
        });

        RAYS[i] = DIRS.map(function (d) {
          const line = [];
          let nr = r + d[0], nc = c + d[1];
          while (nr >= 0 && nr < N && nc >= 0 && nc < N) {
            line.push(nr * N + nc);
            nr += d[0]; nc += d[1];
          }
          return Int32Array.from(line);
        });

        const dist = Math.max(Math.abs(r - mid), Math.abs(c - mid));
        CENTRALITY[i] = 1 - dist / mid;
      }
    }

    const geo = { N: N, SIZE: SIZE, NEIGH: NEIGH, JUMPS: JUMPS, RAYS: RAYS, CENTRALITY: CENTRALITY };
    GEO_CACHE.set(N, geo);
    return geo;
  }

  /* ================================================================== */
  /* 3. Compilação de arenas                                            */
  /* ================================================================== */

  const ARENA_CACHE = new Map();

  function assert(cond, message) {
    if (!cond) throw new Error('[aura/arena] ' + message);
  }

  /**
   * Transforma a grade de texto em estruturas tipadas e valida as invariantes
   * que o resto do motor trata como verdade absoluta.
   */
  function buildArena(def) {
    const cached = ARENA_CACHE.get(def.id);
    if (cached) return cached;

    const N = def.N;
    const SIZE = N * N;
    const geo = geometry(N);

    assert(def.grid.length === N, def.id + ': a grade tem ' + def.grid.length + ' linhas, esperava ' + N);

    const blocked = new Uint8Array(SIZE);
    const portal  = new Int32Array(SIZE).fill(-1);
    const portalBuckets = {};
    const formation = [];

    for (let r = 0; r < N; r++) {
      const line = def.grid[r];
      assert(line.length === N, def.id + ': linha ' + r + ' tem ' + line.length + ' colunas, esperava ' + N);

      for (let c = 0; c < N; c++) {
        const ch = line.charAt(c);
        const i = r * N + c;

        if (ch === '.') continue;
        if (ch === '#') { blocked[i] = 1; continue; }

        if (ch >= '1' && ch <= '9') {
          if (!portalBuckets[ch]) portalBuckets[ch] = [];
          portalBuckets[ch].push(i);
          continue;
        }

        const kind = KIND_FROM_CHAR[ch];
        assert(kind, def.id + ': símbolo desconhecido "' + ch + '" em (' + r + ',' + c + ')');
        formation.push({ index: i, kind: kind });
      }
    }

    // --- portais: exatamente dois extremos por dígito ------------------
    Object.keys(portalBuckets).forEach(function (key) {
      const ends = portalBuckets[key];
      assert(ends.length === 2, def.id + ': portal "' + key + '" tem ' + ends.length + ' extremos, precisa de 2');
      portal[ends[0]] = ends[1];
      portal[ends[1]] = ends[0];
    });

    // --- simetria central: o terreno precisa ser justo -----------------
    const mirror = function (i) { return SIZE - 1 - i; };   // rotação de 180°
    for (let i = 0; i < SIZE; i++) {
      assert(blocked[i] === blocked[mirror(i)], def.id + ': bloqueio assimétrico na casa ' + i);
      assert((portal[i] === -1) === (portal[mirror(i)] === -1), def.id + ': portal assimétrico na casa ' + i);
    }

    // --- exército de A + espelho de B ---------------------------------
    const pieces = [];
    let cores = 0;
    formation.forEach(function (f) {
      const j = mirror(f.index);
      assert(!blocked[f.index], def.id + ': peça sobre casa bloqueada (' + f.index + ')');
      assert(!blocked[j], def.id + ': o espelho da peça ' + f.index + ' cai em casa bloqueada');
      assert(portal[f.index] === -1, def.id + ': peça começa sobre um portal (' + f.index + ')');
      pieces.push({ index: f.index, owner: A, kind: f.kind });
      pieces.push({ index: j, owner: B, kind: f.kind });
      if (f.kind === CORE) cores++;
    });
    assert(cores === 1, def.id + ': cada lado precisa de exatamente 1 Núcleo (achei ' + cores + ')');

    // --- adjacências derivadas ----------------------------------------
    const adjStep8 = new Array(SIZE);   // passo livre, 8 direções
    const adjStep4 = new Array(SIZE);   // passo livre, 4 ortogonais
    const adjSiege = new Array(SIZE);   // ortogonal + portal (conectividade do Cerco)

    for (let i = 0; i < SIZE; i++) {
      const n8 = [], n4 = [], siege = [];
      for (let d = 0; d < 8; d++) {
        const nb = geo.NEIGH[i][d];
        if (nb < 0 || blocked[nb]) continue;
        n8.push(nb);
        if (ORTHO_D.indexOf(d) >= 0) { n4.push(nb); siege.push(nb); }
      }
      if (portal[i] >= 0 && !blocked[portal[i]]) siege.push(portal[i]);
      adjStep8[i] = Int32Array.from(n8);
      adjStep4[i] = Int32Array.from(n4);
      adjSiege[i] = Int32Array.from(siege);
    }

    let playable = 0;
    for (let i = 0; i < SIZE; i++) if (!blocked[i]) playable++;

    const ratio = def.territoryRatio || 0.70;

    const arena = Object.freeze({
      id: def.id,
      order: def.order || 0,
      level: def.level || 'adept',
      teaches: def.teaches || [],
      N: N, SIZE: SIZE, geo: geo,
      blocked: blocked, portal: portal,
      adjStep8: adjStep8, adjStep4: adjStep4, adjSiege: adjSiege,
      pieces: pieces,
      playable: playable,
      territoryRatio: ratio,
      territoryThreshold: Math.ceil(playable * ratio),
      maxPlies: def.maxPlies || 300,
      hasPortals: Object.keys(portalBuckets).length > 0
    });

    ARENA_CACHE.set(def.id, arena);
    return arena;
  }

  function arenaById(id) {
    return buildArena(ARENAS.byId(id));
  }

  /* ================================================================== */
  /* 4. Estado                                                          */
  /* ================================================================== */

  function createInitialState(arenaId) {
    const arena = arenaById(arenaId || ARENAS.CLASSIC_ID);
    const board = new Int8Array(arena.SIZE);
    const aura  = new Int8Array(arena.SIZE);

    arena.pieces.forEach(function (p) {
      board[p.index] = piece(p.owner, p.kind);
      aura[p.index] = p.owner;          // cada exército nasce sobre a própria luz
    });

    return {
      arena: arena,
      board: board, aura: aura,
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
      arena: s.arena,
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

  /** Estado a partir de uma descrição declarativa (tutorial, testes). */
  function fromLayout(layout, auraLayout, arenaId) {
    const arena = arenaById(arenaId || ARENAS.CLASSIC_ID);
    const s = {
      arena: arena,
      board: new Int8Array(arena.SIZE),
      aura: new Int8Array(arena.SIZE),
      turn: A, ply: 0, status: 'playing', winner: null, reason: null, lastMove: null
    };
    Object.keys(layout || {}).forEach(function (k) { s.board[Number(k)] = layout[k]; });
    Object.keys(auraLayout || {}).forEach(function (k) { s.aura[Number(k)] = auraLayout[k]; });
    return s;
  }

  /* ---- coordenadas ------------------------------------------------- */
  const idxOn = function (arena, r, c) { return r * arena.N + c; };
  const rowOn = function (arena, i) { return (i / arena.N) | 0; };
  const colOn = function (arena, i) { return i % arena.N; };
  // versões livres (assumem 9x9 se N não for passado)
  const idx   = function (r, c, N) { return r * (N || 9) + c; };
  const rowOf = function (i, N) { return (i / (N || 9)) | 0; };
  const colOf = function (i, N) { return i % (N || 9); };

  /* ================================================================== */
  /* 5. Geração de movimentos                                           */
  /* ================================================================== */

  function mkMove(from, to, path, captures, type, kind) {
    return { from: from, to: to, path: path, captures: captures, type: type, kind: kind };
  }

  /** Passo simples de 1 casa no conjunto de direções da peça. */
  function generateStepMoves(state, from, out) {
    const arena = state.arena;
    const kind = kindOf(state.board[from]);
    const list = (kind === WARDEN) ? arena.adjStep4[from] : arena.adjStep8[from];
    for (let k = 0; k < list.length; k++) {
      const to = list[k];
      if (state.board[to] !== EMPTY) continue;
      out.push(mkMove(from, to, [to], [], 'step', kind));
    }
    return out;
  }

  /**
   * Deslize de até `range` casas numa reta: toda casa atravessada precisa
   * estar vazia e TODAS entram no `path` — logo, todas são pintadas. É isso
   * que faz da Lâmina e do Prisma peças de território, não de combate.
   */
  function generateSlideMoves(state, from, dirSet, range, out) {
    const arena = state.arena;
    const kind = kindOf(state.board[from]);
    const rays = arena.geo.RAYS[from];

    for (let d = 0; d < dirSet.length; d++) {
      const ray = rays[dirSet[d]];
      const path = [];
      const limit = Math.min(range, ray.length);
      for (let step = 0; step < limit; step++) {
        const cell = ray[step];
        if (arena.blocked[cell] || state.board[cell] !== EMPTY) break;
        path.push(cell);
        out.push(mkMove(from, cell, path.slice(), [], step === 0 ? 'step' : 'slide', kind));
      }
    }
    return out;
  }

  /** Travessia de portal: 1 lance, disponível para qualquer peça. */
  function generatePortalMoves(state, from, out) {
    const arena = state.arena;
    const exit = arena.portal[from];
    if (exit < 0) return out;
    if (arena.blocked[exit] || state.board[exit] !== EMPTY) return out;
    out.push(mkMove(from, exit, [exit], [], 'portal', kindOf(state.board[from])));
    return out;
  }

  /**
   * Saltos encadeados (busca em profundidade). Só as sequências MAXIMAIS são
   * legais: se ainda dá para saltar, você é obrigado a continuar — isso
   * elimina meio-saltos que deixariam a peça pendurada no meio do caminho.
   */
  function generateJumpMoves(state, from, dirSet, out) {
    const arena = state.arena;
    const board = state.board;
    const me = ownerOf(board[from]);
    const kind = kindOf(board[from]);
    const jumps = arena.geo.JUMPS;

    const path = [];
    const captured = [];

    const walk = function (pos) {
      let extended = false;

      for (let d = 0; d < dirSet.length; d++) {
        const j = jumps[pos][dirSet[d]];
        if (!j) continue;
        if (arena.blocked[j.mid] || arena.blocked[j.land]) continue;

        const victim = board[j.mid];
        if (!isJumpable(victim) || ownerOf(victim) === me) continue;
        if (captured.indexOf(j.mid) >= 0) continue;            // nunca duas vezes a mesma
        if (board[j.land] !== EMPTY && j.land !== from) continue;

        extended = true;
        path.push(j.land);
        captured.push(j.mid);
        walk(j.land);
        path.pop();
        captured.pop();
      }

      if (!extended && path.length) {
        out.push(mkMove(from, pos, path.slice(), captured.slice(), 'jump', kind));
      }
    };

    walk(from);
    return out;
  }

  const ALL_D = [0, 1, 2, 3, 4, 5, 6, 7];

  function generateMovesForPiece(state, from) {
    const p = state.board[from];
    if (p === EMPTY) return [];
    const out = [];

    switch (kindOf(p)) {
      case CORE:
        generateStepMoves(state, from, out);
        break;
      case SENT:
        generateStepMoves(state, from, out);
        generateJumpMoves(state, from, ALL_D, out);
        break;
      case BLADE:
        generateSlideMoves(state, from, ORTHO_D, 2, out);
        generateJumpMoves(state, from, ORTHO_D, out);
        break;
      case PRISM:
        generateSlideMoves(state, from, DIAG_D, 2, out);
        generateJumpMoves(state, from, DIAG_D, out);
        break;
      case WARDEN:
        generateStepMoves(state, from, out);
        break;
    }

    generatePortalMoves(state, from, out);
    return out;
  }

  function generateAllMoves(state, player) {
    const who = player || state.turn;
    const out = [];
    for (let i = 0; i < state.arena.SIZE; i++) {
      if (ownerOf(state.board[i]) !== who) continue;
      const moves = generateMovesForPiece(state, i);
      for (let m = 0; m < moves.length; m++) out.push(moves[m]);
    }
    return out;
  }

  function moveKey(m) { return m.from + '>' + m.path.join('.'); }

  function findMove(moves, from, path) {
    const key = from + '>' + path.join('.');
    for (let i = 0; i < moves.length; i++) if (moveKey(moves[i]) === key) return moves[i];
    return null;
  }

  /** Usado pelo servidor: regenera os lances legais e confere o recebido. */
  function findLegalMove(state, from, path) {
    if (ownerOf(state.board[from]) !== state.turn) return null;
    return findMove(generateMovesForPiece(state, from), from, path);
  }

  /** Mapa destino -> movimento, para a UI acender os alvos. */
  function targetsFor(state, from) {
    const map = new Map();
    generateMovesForPiece(state, from).forEach(function (m) {
      const existing = map.get(m.to);
      // dois lances terminando na mesma casa: vence o que captura mais
      if (!existing || m.captures.length > existing.captures.length) map.set(m.to, m);
    });
    return map;
  }

  /* ================================================================== */
  /* 6. Cerco (Flood Fill)                                              */
  /* ================================================================== */

  /**
   * Um grupo é um conjunto de peças do mesmo dono ligadas ortogonalmente
   * (portais contam como ligação). Uma "respiração" é uma casa vazia vizinha
   * cuja Aura NÃO pertence ao atacante — pintar o chão em volta sufoca.
   */
  function findSuffocatedGroups(state, victim, attacker) {
    const arena = state.arena;
    const board = state.board, aura = state.aura;
    const visited = new Uint8Array(arena.SIZE);
    const stack = new Int32Array(arena.SIZE);
    const doomed = [];

    for (let start = 0; start < arena.SIZE; start++) {
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

        const neigh = arena.adjSiege[cur];
        for (let k = 0; k < neigh.length; k++) {
          const nb = neigh[k];
          const cell = board[nb];
          if (cell === EMPTY) {
            if (aura[nb] !== attacker) liberties++;
          } else if (ownerOf(cell) === victim && !visited[nb]) {
            visited[nb] = 1;
            stack[sp++] = nb;
          }
        }
      }

      if (liberties === 0) doomed.push(group);
    }

    return doomed;
  }

  /** Sufoca o inimigo primeiro; depois cobra o suicídio de quem jogou. */
  function resolveSiege(state, attacker) {
    const captured = [];
    const victim = opponent(attacker);

    findSuffocatedGroups(state, victim, attacker).forEach(function (group) {
      group.forEach(function (i) {
        captured.push({ index: i, piece: state.board[i], by: attacker, kind: 'siege' });
        state.board[i] = EMPTY;
        state.aura[i] = attacker;
      });
    });

    findSuffocatedGroups(state, attacker, victim).forEach(function (group) {
      group.forEach(function (i) {
        captured.push({ index: i, piece: state.board[i], by: victim, kind: 'suicide' });
        state.board[i] = EMPTY;
        state.aura[i] = victim;
      });
    });

    return captured;
  }

  /* ================================================================== */
  /* 7. Território e término                                            */
  /* ================================================================== */

  function territoryCount(state) {
    const arena = state.arena;
    const t = [0, 0, 0];
    for (let i = 0; i < arena.SIZE; i++) {
      if (arena.blocked[i]) continue;
      t[state.aura[i]]++;
    }
    return { neutral: t[0], 1: t[1], 2: t[2] };
  }

  function territoryRatio(state, player) {
    return territoryCount(state)[player] / state.arena.playable;
  }

  function hasCore(state, player) {
    const target = piece(player, CORE);
    for (let i = 0; i < state.arena.SIZE; i++) if (state.board[i] === target) return true;
    return false;
  }

  function coreIndex(state, player) {
    const target = piece(player, CORE);
    for (let i = 0; i < state.arena.SIZE; i++) if (state.board[i] === target) return i;
    return -1;
  }

  /** Contagem por tipo — alimenta o HUD e a avaliação da IA. */
  function countPieces(state, player) {
    const out = { cores: 0, sentinels: 0, blades: 0, prisms: 0, wardens: 0, total: 0, minions: 0 };
    for (let i = 0; i < state.arena.SIZE; i++) {
      const p = state.board[i];
      if (ownerOf(p) !== player) continue;
      out.total++;
      switch (kindOf(p)) {
        case CORE:   out.cores++; break;
        case SENT:   out.sentinels++; out.minions++; break;
        case BLADE:  out.blades++;    out.minions++; break;
        case PRISM:  out.prisms++;    out.minions++; break;
        case WARDEN: out.wardens++;   out.minions++; break;
      }
    }
    return out;
  }

  function evaluateTermination(state) {
    const aCore = hasCore(state, A);
    const bCore = hasCore(state, B);
    if (!aCore && !bCore) return { winner: 0, reason: 'double_core' };
    if (!bCore) return { winner: A, reason: 'core' };
    if (!aCore) return { winner: B, reason: 'core' };

    const t = territoryCount(state);
    const threshold = state.arena.territoryThreshold;
    if (t[A] >= threshold) return { winner: A, reason: 'territory' };
    if (t[B] >= threshold) return { winner: B, reason: 'territory' };

    if (generateAllMoves(state, state.turn).length === 0) {
      return { winner: opponent(state.turn), reason: 'stalemate' };
    }

    // Trava anti-loop: duas Auras bem defendidas repintam as mesmas casas
    // indefinidamente. No teto, arbitra-se pelo território.
    if (state.ply >= state.arena.maxPlies) {
      if (t[A] === t[B]) return { winner: 0, reason: 'adjudication' };
      return { winner: t[A] > t[B] ? A : B, reason: 'adjudication' };
    }
    return null;
  }

  /* ================================================================== */
  /* 8. Aplicação de jogada                                             */
  /* ================================================================== */

  /** Casas que a peça acende ao PARAR (Prisma e Guardião). */
  function radiationOf(arena, kind, at) {
    if (kind === WARDEN) return arena.adjStep4[at];
    if (kind === PRISM) {
      const out = [];
      for (let d = 0; d < DIAG_D.length; d++) {
        const nb = arena.geo.NEIGH[at][DIAG_D[d]];
        if (nb >= 0 && !arena.blocked[nb]) out.push(nb);
      }
      return out;
    }
    return null;
  }

  /** Aplica um lance e devolve um NOVO estado (o original fica intacto). */
  function applyMove(state, move) {
    const arena = state.arena;
    const next = cloneState(state);
    const moving = next.board[move.from];
    const player = ownerOf(moving);
    const kind = kindOf(moving);

    next.board[move.from] = EMPTY;
    if (!arena.blocked[move.from]) next.aura[move.from] = player;

    for (let i = 0; i < move.path.length; i++) next.aura[move.path[i]] = player;

    for (let i = 0; i < move.captures.length; i++) {
      next.aura[move.captures[i]] = player;
      next.board[move.captures[i]] = EMPTY;
    }

    next.board[move.to] = moving;

    // irradiação (Prisma / Guardião)
    const radiated = [];
    const beam = radiationOf(arena, kind, move.to);
    if (beam) {
      for (let k = 0; k < beam.length; k++) {
        const cell = beam[k];
        if (next.aura[cell] !== player) { next.aura[cell] = player; radiated.push(cell); }
      }
    }

    const siege = resolveSiege(next, player);

    next.ply = state.ply + 1;
    next.turn = opponent(player);
    next.lastMove = {
      from: move.from,
      to: move.to,
      path: move.path.slice(),
      jumpCaptures: move.captures.slice(),
      siegeCaptures: siege.map(function (c) { return c.index; }),
      siegeDetail: siege,
      radiated: radiated,
      by: player,
      kind: kind,
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

  /* ================================================================== */
  /* 9. Serialização (uma casa = um caractere base36)                   */
  /* ================================================================== */

  function serialize(state) {
    let b = '', a = '';
    for (let i = 0; i < state.arena.SIZE; i++) {
      b += state.board[i].toString(36);
      a += String(state.aura[i]);
    }
    return {
      v: 2,
      ar: state.arena.id,
      b: b,
      a: a,
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
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (e) { return createInitialState(); }
    }
    const arena = arenaById(o.ar);
    const board = new Int8Array(arena.SIZE);
    const aura  = new Int8Array(arena.SIZE);
    for (let i = 0; i < arena.SIZE; i++) {
      board[i] = parseInt(o.b.charAt(i), 36) || 0;
      aura[i]  = Number(o.a.charAt(i)) || 0;
    }
    return {
      arena: arena, board: board, aura: aura,
      turn: o.t,
      ply: o.p,
      status: o.s,
      winner: (o.w === undefined ? null : o.w),
      reason: o.r || null,
      lastMove: o.m || null
    };
  }

  /* ================================================================== */

  root.AuraRules = {
    // vocabulário
    A: A, B: B, EMPTY: EMPTY,
    CORE: CORE, SENT: SENT, BLADE: BLADE, PRISM: PRISM, WARDEN: WARDEN,
    KIND_NAMES: KIND_NAMES,
    CORE_A: CORE_A, SENT_A: SENT_A, CORE_B: CORE_B, SENT_B: SENT_B,
    DIRS: DIRS, ORTHO_D: ORTHO_D, DIAG_D: DIAG_D, ALL_D: ALL_D,

    piece: piece, ownerOf: ownerOf, kindOf: kindOf, opponent: opponent,
    isCore: isCore, isSentinel: isSentinel, isJumpable: isJumpable,
    idx: idx, rowOf: rowOf, colOf: colOf, idxOn: idxOn, rowOn: rowOn, colOn: colOn,

    // arenas
    geometry: geometry, buildArena: buildArena, arenaById: arenaById,

    // estado
    createInitialState: createInitialState, cloneState: cloneState, fromLayout: fromLayout,

    // movimentos
    generateStepMoves: generateStepMoves, generateSlideMoves: generateSlideMoves,
    generatePortalMoves: generatePortalMoves, generateJumpMoves: generateJumpMoves,
    generateMovesForPiece: generateMovesForPiece, generateAllMoves: generateAllMoves,
    moveKey: moveKey, findMove: findMove, findLegalMove: findLegalMove, targetsFor: targetsFor,

    // cerco / território
    findSuffocatedGroups: findSuffocatedGroups, resolveSiege: resolveSiege,
    radiationOf: radiationOf,
    territoryCount: territoryCount, territoryRatio: territoryRatio,
    hasCore: hasCore, coreIndex: coreIndex, countPieces: countPieces,

    // ciclo
    evaluateTermination: evaluateTermination, applyMove: applyMove,
    serialize: serialize, deserialize: deserialize
  };
})(typeof self !== 'undefined' ? self : this);
