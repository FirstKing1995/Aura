/**
 * ============================================================================
 *  AURA — Backend (Google Apps Script Web App)
 * ============================================================================
 *  Arquitetura:
 *    [Router] -> [Middleware] -> [Controller] -> [Service] -> [Repository] -> Sheets
 *
 *  Padrões aplicados:
 *    - Repository Pattern      (SheetRepository: CRUD genérico sobre abas)
 *    - Service Layer           (AuthService, MatchmakingService, MatchService, RankingService)
 *    - Front Controller        (doGet/doPost -> Router.dispatch)
 *    - DTO / Envelope          (ApiResponse)
 *    - Optimistic Concurrency  (coluna `version` em Partidas_Ativas)
 *    - Pessimistic Lock        (LockService no matchmaking e na aplicação de jogadas)
 *
 *  IMPORTANTE (deploy):
 *    1. Crie uma planilha e cole o ID em CONFIG.SPREADSHEET_ID (ou deixe vazio
 *       e vincule este script à planilha).
 *    2. Execute `setup()` uma vez pelo editor para criar as abas e o segredo HMAC.
 *    3. Implantar > Nova implantação > Tipo: App da Web
 *         - Executar como: Eu
 *         - Quem tem acesso: Qualquer pessoa
 *    4. Copie a URL /exec para js/config.js -> API.BASE_URL
 *
 *  Sobre CORS: o Apps Script não envia cabeçalhos CORS customizados. O
 *  front-end chama este endpoint com `Content-Type: text/plain;charset=utf-8`
 *  para evitar o preflight OPTIONS, e o corpo é um JSON serializado.
 * ============================================================================
 */

/* ========================================================================== */
/* 1. CONFIGURAÇÃO                                                            */
/* ========================================================================== */

var CONFIG = Object.freeze({
  SPREADSHEET_ID: '',            // vazio = usa a planilha vinculada ao script
  API_VERSION: '1.4.0',

  SHEETS: {
    USERS: 'Usuarios',
    QUEUE: 'Fila_Matchmaking',
    MATCHES: 'Partidas_Ativas',
    HISTORY: 'Historico_Partidas'
  },

  SCHEMA: {
    Usuarios: ['id', 'username', 'usernameKey', 'passHash', 'salt', 'elo', 'wins',
               'losses', 'draws', 'gamesPlayed', 'createdAt', 'lastSeenAt', 'status'],
    Fila_Matchmaking: ['queueId', 'userId', 'username', 'elo', 'joinedAt',
                       'heartbeatAt', 'status', 'matchId', 'side'],
    Partidas_Ativas: ['matchId', 'playerAId', 'playerAName', 'playerAElo',
                      'playerBId', 'playerBName', 'playerBElo', 'turn', 'version',
                      'status', 'winner', 'reason', 'stateJson', 'lastMoveJson',
                      'createdAt', 'updatedAt', 'heartbeatA', 'heartbeatB'],
    Historico_Partidas: ['matchId', 'playerAId', 'playerBId', 'winner', 'reason',
                         'eloDeltaA', 'eloDeltaB', 'plies', 'finishedAt']
  },

  SECURITY: {
    HASH_ITERATIONS: 1200,
    SESSION_TTL_MS: 1000 * 60 * 60 * 24 * 14,   // 14 dias
    MIN_PASSWORD: 4,
    MIN_USERNAME: 3,
    MAX_USERNAME: 16
  },

  MATCH: {
    QUEUE_TTL_MS: 45 * 1000,      // entrada na fila expira sem heartbeat
    TURN_TIMEOUT_MS: 120 * 1000,  // inatividade no turno = derrota por abandono
    MATCH_TTL_MS: 60 * 60 * 1000, // limpeza de partidas zumbis
    BOARD_SIZE: 9
  },

  ELO: {
    START: 1000,
    FLOOR: 100,
    K_NEW: 40,        // < 10 partidas
    K_NORMAL: 24,     // rating < 2000
    K_ELITE: 16,      // rating >= 2000
    NEW_PLAYER_GAMES: 10,
    DIVISIONS: [
      { id: 'iron',       min: 0    },
      { id: 'bronze',     min: 900  },
      { id: 'silver',     min: 1100 },
      { id: 'gold',       min: 1350 },
      { id: 'grandmaster',min: 1650 }
    ]
  },

  LOCK_TIMEOUT_MS: 12000,
  CACHE_TTL_S: 25
});

/* ========================================================================== */
/* 2. UTILITÁRIOS                                                             */
/* ========================================================================== */

var Util = (function () {

  function now() { return Date.now(); }

  function uuid() {
    return Utilities.getUuid().replace(/-/g, '').substring(0, 20);
  }

  function shortId(prefix) {
    return (prefix || '') + now().toString(36) + '-' +
           Math.floor(Math.random() * 1e6).toString(36);
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = (bytes[i] < 0 ? bytes[i] + 256 : bytes[i]).toString(16);
      out += (b.length === 1 ? '0' : '') + b;
    }
    return out;
  }

  function sha256(text) {
    return bytesToHex(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    );
  }

  function hmac256(text, key) {
    return bytesToHex(
      Utilities.computeHmacSha256Signature(text, key)
    );
  }

  /** Comparação em tempo (quase) constante para evitar timing attacks triviais. */
  function safeEquals(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return diff === 0;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function sanitizeUsername(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').substring(0, CONFIG.SECURITY.MAX_USERNAME);
  }

  function usernameKey(name) {
    return sanitizeUsername(name).toLowerCase();
  }

  function parseJsonSafe(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function withLock(fn) {
    var lock = LockService.getScriptLock();
    var acquired = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS);
    if (!acquired) throw new ApiError('SERVER_BUSY', 'Servidor ocupado, tente novamente.', 503);
    try { return fn(); }
    finally { try { lock.releaseLock(); } catch (e) {} }
  }

  return {
    now: now, uuid: uuid, shortId: shortId, sha256: sha256, hmac256: hmac256,
    safeEquals: safeEquals, clamp: clamp, sanitizeUsername: sanitizeUsername,
    usernameKey: usernameKey, parseJsonSafe: parseJsonSafe, withLock: withLock,
    bytesToHex: bytesToHex
  };
})();

/** Erro de domínio com código estável para o front-end traduzir (i18n). */
function ApiError(code, message, httpish) {
  this.name = 'ApiError';
  this.code = code || 'UNKNOWN';
  this.message = message || 'Erro desconhecido';
  this.httpish = httpish || 400;
}
ApiError.prototype = Object.create(Error.prototype);

/* ========================================================================== */
/* 3. REPOSITORY — acesso genérico às abas                                    */
/* ========================================================================== */

var SheetRepository = (function () {

  var _ss = null;

  function ss() {
    if (_ss) return _ss;
    _ss = CONFIG.SPREADSHEET_ID
      ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!_ss) throw new ApiError('NO_SPREADSHEET', 'Planilha não configurada.', 500);
    return _ss;
  }

  function sheet(name) {
    var sh = ss().getSheetByName(name);
    if (!sh) sh = createSheet(name);
    return sh;
  }

  function createSheet(name) {
    var headers = CONFIG.SCHEMA[name];
    if (!headers) throw new ApiError('UNKNOWN_SHEET', 'Aba desconhecida: ' + name, 500);
    var sh = ss().insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#0f172a')
      .setFontColor('#e2e8f0');
    return sh;
  }

  function headers(name) { return CONFIG.SCHEMA[name].slice(); }

  function colIndex(name, field) {
    var i = CONFIG.SCHEMA[name].indexOf(field);
    if (i < 0) throw new ApiError('UNKNOWN_FIELD', 'Campo inexistente: ' + name + '.' + field, 500);
    return i;
  }

  /** Lê todas as linhas de dados como objetos (+ _row = número físico da linha). */
  function findAll(name) {
    var sh = sheet(name);
    var last = sh.getLastRow();
    if (last < 2) return [];
    var cols = CONFIG.SCHEMA[name];
    var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
    var out = [];
    for (var r = 0; r < values.length; r++) {
      var row = values[r];
      if (!row[0] && row[0] !== 0) continue;   // linha vazia
      var obj = { _row: r + 2 };
      for (var c = 0; c < cols.length; c++) obj[cols[c]] = row[c];
      out.push(obj);
    }
    return out;
  }

  function findBy(name, field, value) {
    var all = findAll(name);
    for (var i = 0; i < all.length; i++) {
      if (String(all[i][field]) === String(value)) return all[i];
    }
    return null;
  }

  function filterBy(name, predicate) {
    return findAll(name).filter(predicate);
  }

  function insert(name, obj) {
    var sh = sheet(name);
    var cols = CONFIG.SCHEMA[name];
    var row = cols.map(function (c) {
      var v = obj[c];
      return (v === undefined || v === null) ? '' : v;
    });
    sh.appendRow(row);
    obj._row = sh.getLastRow();
    return obj;
  }

  /** Atualiza apenas os campos informados (patch), usando o _row do objeto. */
  function update(name, rowNumber, patch) {
    var sh = sheet(name);
    var cols = CONFIG.SCHEMA[name];
    Object.keys(patch).forEach(function (field) {
      var idx = cols.indexOf(field);
      if (idx < 0) return;
      var v = patch[field];
      sh.getRange(rowNumber, idx + 1).setValue(v === undefined || v === null ? '' : v);
    });
    return true;
  }

  /** Atualiza a linha inteira de uma vez (mais barato que múltiplos setValue). */
  function replaceRow(name, rowNumber, obj) {
    var sh = sheet(name);
    var cols = CONFIG.SCHEMA[name];
    var row = cols.map(function (c) {
      var v = obj[c];
      return (v === undefined || v === null) ? '' : v;
    });
    sh.getRange(rowNumber, 1, 1, cols.length).setValues([row]);
    return true;
  }

  function remove(name, rowNumber) {
    sheet(name).deleteRow(rowNumber);
  }

  /** Remove várias linhas de baixo para cima (evita deslocamento de índices). */
  function removeMany(name, rowNumbers) {
    rowNumbers.slice().sort(function (a, b) { return b - a; })
      .forEach(function (r) { sheet(name).deleteRow(r); });
  }

  function ensureAll() {
    Object.keys(CONFIG.SCHEMA).forEach(function (n) { sheet(n); });
  }

  return {
    ss: ss, sheet: sheet, headers: headers, colIndex: colIndex,
    findAll: findAll, findBy: findBy, filterBy: filterBy,
    insert: insert, update: update, replaceRow: replaceRow,
    remove: remove, removeMany: removeMany, ensureAll: ensureAll
  };
})();

/* ========================================================================== */
/* 4. MOTOR DE REGRAS (espelho autoritativo do rules.js do front-end)         */
/* ========================================================================== */
/**
 * O servidor NUNCA confia no cliente: ele recebe apenas {from, path} e
 * recalcula a jogada inteira. Se a jogada não estiver na lista de
 * movimentos legais gerada aqui, é rejeitada.
 */
var Rules = (function () {

  var N = CONFIG.MATCH.BOARD_SIZE;
  var SIZE = N * N;

  var EMPTY = 0, CORE_A = 1, SENT_A = 2, CORE_B = 3, SENT_B = 4;
  var A = 1, B = 2;

  var DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  var ORTHO = [[-1,0],[1,0],[0,-1],[0,1]];
  var MAX_PLIES = 300;

  function idx(r, c) { return r * N + c; }
  function rowOf(i) { return Math.floor(i / N); }
  function colOf(i) { return i % N; }
  function inBounds(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

  function ownerOf(piece) {
    if (piece === CORE_A || piece === SENT_A) return A;
    if (piece === CORE_B || piece === SENT_B) return B;
    return 0;
  }
  function isCore(piece) { return piece === CORE_A || piece === CORE_B; }
  function isSentinel(piece) { return piece === SENT_A || piece === SENT_B; }
  function opponent(p) { return p === A ? B : A; }

  function createInitialState() {
    var board = new Array(SIZE).fill(EMPTY);
    var aura  = new Array(SIZE).fill(0);

    // Formação espelhada: Núcleo ao centro da linha de base, 10 Sentinelas.
    var backSent  = [1, 2, 3, 5, 6, 7];
    var frontSent = [2, 3, 5, 6];

    board[idx(8, 4)] = CORE_A;
    backSent.forEach(function (c) { board[idx(8, c)] = SENT_A; });
    frontSent.forEach(function (c) { board[idx(7, c)] = SENT_A; });

    board[idx(0, 4)] = CORE_B;
    backSent.forEach(function (c) { board[idx(0, c)] = SENT_B; });
    frontSent.forEach(function (c) { board[idx(1, c)] = SENT_B; });

    // A aura inicial nasce sob as peças de cada lado.
    for (var i = 0; i < SIZE; i++) {
      var o = ownerOf(board[i]);
      if (o) aura[i] = o;
    }

    return {
      board: board,
      aura: aura,
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
      lastMove: s.lastMove ? JSON.parse(JSON.stringify(s.lastMove)) : null
    };
  }

  /* ---------------- geração de movimentos ---------------- */

  function generateStepMoves(state, from) {
    var moves = [];
    var r = rowOf(from), c = colOf(from);
    for (var d = 0; d < DIRS.length; d++) {
      var nr = r + DIRS[d][0], nc = c + DIRS[d][1];
      if (!inBounds(nr, nc)) continue;
      var to = idx(nr, nc);
      if (state.board[to] !== EMPTY) continue;
      moves.push({ from: from, to: to, path: [to], captures: [], type: 'step' });
    }
    return moves;
  }

  /** DFS de saltos encadeados (só Sentinelas inimigas podem ser saltadas). */
  function generateJumpMoves(state, from) {
    var results = [];
    var me = ownerOf(state.board[from]);
    var board = state.board.slice();
    var piece = board[from];
    board[from] = EMPTY;

    function dfs(pos, path, captured) {
      var extended = false;
      var r = rowOf(pos), c = colOf(pos);
      for (var d = 0; d < DIRS.length; d++) {
        var mr = r + DIRS[d][0], mc = c + DIRS[d][1];
        var lr = r + DIRS[d][0] * 2, lc = c + DIRS[d][1] * 2;
        if (!inBounds(lr, lc)) continue;
        var mid = idx(mr, mc), land = idx(lr, lc);
        var victim = board[mid];
        if (!isSentinel(victim) || ownerOf(victim) === me) continue;
        if (captured.indexOf(mid) !== -1) continue;
        if (board[land] !== EMPTY) continue;

        extended = true;
        board[mid] = EMPTY;
        dfs(land, path.concat([land]), captured.concat([mid]));
        board[mid] = victim;
      }
      if (!extended && path.length > 0) {
        results.push({
          from: from,
          to: pos,
          path: path.slice(),
          captures: captured.slice(),
          type: 'jump'
        });
      }
    }

    dfs(from, [], []);
    board[from] = piece;
    return results;
  }

  function generateMovesForPiece(state, from) {
    var piece = state.board[from];
    if (piece === EMPTY) return [];
    return generateJumpMoves(state, from).concat(generateStepMoves(state, from));
  }

  function generateAllMoves(state, player) {
    player = player || state.turn;
    var moves = [];
    for (var i = 0; i < SIZE; i++) {
      if (ownerOf(state.board[i]) !== player) continue;
      moves = moves.concat(generateMovesForPiece(state, i));
    }
    return moves;
  }

  function moveKey(m) { return m.from + '>' + m.path.join('.'); }

  function findLegalMove(state, from, path) {
    var wanted = from + '>' + (path || []).join('.');
    var all = generateAllMoves(state, state.turn);
    for (var i = 0; i < all.length; i++) {
      if (moveKey(all[i]) === wanted) return all[i];
    }
    return null;
  }

  /* ---------------- cerco (flood fill / liberdades) ---------------- */

  /**
   * Um grupo é o conjunto de peças do mesmo dono conectadas ortogonalmente.
   * Uma liberdade é uma casa vazia adjacente cuja aura NÃO pertence ao
   * atacante. Zero liberdades = grupo capturado.
   */
  function findGroupsWithoutLiberties(state, victimPlayer, attacker) {
    var visited = new Array(SIZE).fill(false);
    var doomed = [];

    for (var i = 0; i < SIZE; i++) {
      if (visited[i]) continue;
      if (ownerOf(state.board[i]) !== victimPlayer) continue;

      var stack = [i], group = [], liberties = 0;
      visited[i] = true;

      while (stack.length) {
        var cur = stack.pop();
        group.push(cur);
        var r = rowOf(cur), c = colOf(cur);
        for (var d = 0; d < ORTHO.length; d++) {
          var nr = r + ORTHO[d][0], nc = c + ORTHO[d][1];
          if (!inBounds(nr, nc)) continue;
          var nb = idx(nr, nc);
          var cell = state.board[nb];
          if (cell === EMPTY) {
            if (state.aura[nb] !== attacker) liberties++;
          } else if (ownerOf(cell) === victimPlayer) {
            if (!visited[nb]) { visited[nb] = true; stack.push(nb); }
          }
          // peça inimiga adjacente = parede, não conta liberdade
        }
      }

      if (liberties === 0) doomed.push(group);
    }
    return doomed;
  }

  function resolveSiege(state, attacker) {
    var captured = [];
    var victim = opponent(attacker);

    // 1) grupos inimigos sufocados
    var enemyGroups = findGroupsWithoutLiberties(state, victim, attacker);
    enemyGroups.forEach(function (g) {
      g.forEach(function (i) {
        captured.push({ index: i, piece: state.board[i], by: attacker });
        state.board[i] = EMPTY;
        state.aura[i] = attacker;
      });
    });

    // 2) auto-sufocamento (suicídio) do atacante, avaliado depois
    var ownGroups = findGroupsWithoutLiberties(state, attacker, victim);
    ownGroups.forEach(function (g) {
      g.forEach(function (i) {
        captured.push({ index: i, piece: state.board[i], by: victim });
        state.board[i] = EMPTY;
        state.aura[i] = victim;
      });
    });

    return captured;
  }

  /* ---------------- território e vitória ---------------- */

  function territoryCount(state) {
    var t = { 1: 0, 2: 0, 0: 0 };
    for (var i = 0; i < SIZE; i++) t[state.aura[i]]++;
    return t;
  }

  function territoryRatio(state, player) {
    return territoryCount(state)[player] / SIZE;
  }

  function hasCore(state, player) {
    var target = player === A ? CORE_A : CORE_B;
    for (var i = 0; i < SIZE; i++) if (state.board[i] === target) return true;
    return false;
  }

  function evaluateTermination(state) {
    var aCore = hasCore(state, A), bCore = hasCore(state, B);
    if (!aCore && !bCore) return { winner: 0, reason: 'double_core' };
    if (!bCore) return { winner: A, reason: 'core' };
    if (!aCore) return { winner: B, reason: 'core' };

    var t = territoryCount(state);
    var threshold = Math.ceil(SIZE * 0.70);
    if (t[A] >= threshold) return { winner: A, reason: 'territory' };
    if (t[B] >= threshold) return { winner: B, reason: 'territory' };

    if (generateAllMoves(state, state.turn).length === 0) {
      return { winner: opponent(state.turn), reason: 'stalemate' };
    }

    // Trava de segurança contra partidas infinitas: arbitra pelo território.
    if (state.ply >= MAX_PLIES) {
      if (t[A] === t[B]) return { winner: 0, reason: 'adjudication' };
      return { winner: t[A] > t[B] ? A : B, reason: 'adjudication' };
    }
    return null;
  }

  /* ---------------- aplicação da jogada ---------------- */

  function applyMove(state, move) {
    var next = cloneState(state);
    var player = ownerOf(next.board[move.from]);
    var piece = next.board[move.from];

    next.board[move.from] = EMPTY;
    next.aura[move.from] = player;

    // Pinta a trilha: casas de pouso e casas saltadas.
    move.path.forEach(function (p) { next.aura[p] = player; });
    move.captures.forEach(function (p) { next.aura[p] = player; });

    move.captures.forEach(function (p) { next.board[p] = EMPTY; });
    next.board[move.to] = piece;

    var siegeCaptured = resolveSiege(next, player);

    next.ply = state.ply + 1;
    next.turn = opponent(player);
    next.lastMove = {
      from: move.from,
      to: move.to,
      path: move.path.slice(),
      jumpCaptures: move.captures.slice(),
      siegeCaptures: siegeCaptured.map(function (c) { return c.index; }),
      by: player,
      type: move.type
    };

    var end = evaluateTermination(next);
    if (end) {
      next.status = 'finished';
      next.winner = end.winner;
      next.reason = end.reason;
    }
    return next;
  }

  /* ---------------- serialização compacta ---------------- */

  function serialize(state) {
    return JSON.stringify({
      b: state.board.join(''),
      a: state.aura.join(''),
      t: state.turn,
      p: state.ply,
      s: state.status,
      w: state.winner,
      r: state.reason,
      m: state.lastMove
    });
  }

  function deserialize(raw) {
    var o = Util.parseJsonSafe(raw, null);
    if (!o) return createInitialState();
    return {
      board: o.b.split('').map(Number),
      aura: o.a.split('').map(Number),
      turn: o.t,
      ply: o.p,
      status: o.s,
      winner: o.w === null || o.w === undefined ? null : o.w,
      reason: o.r || null,
      lastMove: o.m || null
    };
  }

  return {
    N: N, SIZE: SIZE, A: A, B: B,
    EMPTY: EMPTY, CORE_A: CORE_A, SENT_A: SENT_A, CORE_B: CORE_B, SENT_B: SENT_B,
    idx: idx, rowOf: rowOf, colOf: colOf, ownerOf: ownerOf, opponent: opponent,
    isCore: isCore, isSentinel: isSentinel,
    createInitialState: createInitialState, cloneState: cloneState,
    generateMovesForPiece: generateMovesForPiece, generateAllMoves: generateAllMoves,
    findLegalMove: findLegalMove, applyMove: applyMove,
    territoryCount: territoryCount, territoryRatio: territoryRatio,
    evaluateTermination: evaluateTermination,
    serialize: serialize, deserialize: deserialize
  };
})();

/* ========================================================================== */
/* 5. SERVIÇOS                                                                */
/* ========================================================================== */

/* ----------------------------- 5.1 Auth ---------------------------------- */

var AuthService = (function () {

  function secret() {
    var props = PropertiesService.getScriptProperties();
    var s = props.getProperty('AURA_SECRET');
    if (!s) {
      s = Utilities.getUuid() + Utilities.getUuid();
      props.setProperty('AURA_SECRET', s);
    }
    return s;
  }

  /** SHA-256 iterado com salt — "hash básico" solicitado, sem dependências. */
  function hashPassword(password, salt) {
    var h = Util.sha256(salt + '::' + password);
    for (var i = 0; i < CONFIG.SECURITY.HASH_ITERATIONS; i++) {
      h = Util.sha256(h + salt);
    }
    return h;
  }

  function issueToken(userId) {
    var exp = Util.now() + CONFIG.SECURITY.SESSION_TTL_MS;
    var payload = userId + '.' + exp;
    return payload + '.' + Util.hmac256(payload, secret());
  }

  function verifyToken(token) {
    if (!token) throw new ApiError('NO_TOKEN', 'Sessão ausente.', 401);
    var parts = String(token).split('.');
    if (parts.length !== 3) throw new ApiError('BAD_TOKEN', 'Sessão inválida.', 401);
    var userId = parts[0], exp = Number(parts[1]), sig = parts[2];
    if (!Util.safeEquals(sig, Util.hmac256(userId + '.' + exp, secret()))) {
      throw new ApiError('BAD_TOKEN', 'Sessão inválida.', 401);
    }
    if (Util.now() > exp) throw new ApiError('EXPIRED_TOKEN', 'Sessão expirada.', 401);
    return userId;
  }

  function publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      elo: Number(u.elo) || CONFIG.ELO.START,
      wins: Number(u.wins) || 0,
      losses: Number(u.losses) || 0,
      draws: Number(u.draws) || 0,
      gamesPlayed: Number(u.gamesPlayed) || 0,
      division: RankingService.divisionFor(Number(u.elo) || CONFIG.ELO.START)
    };
  }

  function register(username, password) {
    var clean = Util.sanitizeUsername(username);
    var key = Util.usernameKey(clean);

    if (clean.length < CONFIG.SECURITY.MIN_USERNAME) {
      throw new ApiError('USERNAME_SHORT', 'Nome muito curto.', 422);
    }
    if (!/^[a-z0-9 _.-]+$/i.test(clean)) {
      throw new ApiError('USERNAME_INVALID', 'Use letras, números, ponto, hífen ou _.', 422);
    }
    if (String(password || '').length < CONFIG.SECURITY.MIN_PASSWORD) {
      throw new ApiError('PASSWORD_SHORT', 'Senha muito curta.', 422);
    }

    return Util.withLock(function () {
      if (SheetRepository.findBy(CONFIG.SHEETS.USERS, 'usernameKey', key)) {
        throw new ApiError('USERNAME_TAKEN', 'Esse nome já existe.', 409);
      }
      var salt = Util.uuid();
      var user = {
        id: Util.uuid(),
        username: clean,
        usernameKey: key,
        passHash: hashPassword(password, salt),
        salt: salt,
        elo: CONFIG.ELO.START,
        wins: 0, losses: 0, draws: 0, gamesPlayed: 0,
        createdAt: Util.now(),
        lastSeenAt: Util.now(),
        status: 'active'
      };
      SheetRepository.insert(CONFIG.SHEETS.USERS, user);
      return { token: issueToken(user.id), user: publicUser(user) };
    });
  }

  function login(username, password) {
    var key = Util.usernameKey(username);
    var user = SheetRepository.findBy(CONFIG.SHEETS.USERS, 'usernameKey', key);
    if (!user) throw new ApiError('BAD_CREDENTIALS', 'Nome ou senha incorretos.', 401);
    var hash = hashPassword(password, user.salt);
    if (!Util.safeEquals(hash, user.passHash)) {
      throw new ApiError('BAD_CREDENTIALS', 'Nome ou senha incorretos.', 401);
    }
    SheetRepository.update(CONFIG.SHEETS.USERS, user._row, { lastSeenAt: Util.now() });
    return { token: issueToken(user.id), user: publicUser(user) };
  }

  function requireUser(token) {
    var userId = verifyToken(token);
    var user = SheetRepository.findBy(CONFIG.SHEETS.USERS, 'id', userId);
    if (!user) throw new ApiError('USER_NOT_FOUND', 'Usuário não encontrado.', 401);
    return user;
  }

  return {
    register: register, login: login, requireUser: requireUser,
    publicUser: publicUser, issueToken: issueToken, hashPassword: hashPassword
  };
})();

/* ---------------------------- 5.2 Ranking -------------------------------- */

var RankingService = (function () {

  function divisionFor(elo) {
    var divs = CONFIG.ELO.DIVISIONS;
    var current = divs[0].id;
    for (var i = 0; i < divs.length; i++) if (elo >= divs[i].min) current = divs[i].id;
    return current;
  }

  function kFactor(user) {
    var games = Number(user.gamesPlayed) || 0;
    var elo = Number(user.elo) || CONFIG.ELO.START;
    if (games < CONFIG.ELO.NEW_PLAYER_GAMES) return CONFIG.ELO.K_NEW;
    if (elo >= 2000) return CONFIG.ELO.K_ELITE;
    return CONFIG.ELO.K_NORMAL;
  }

  function expectedScore(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  }

  /** scoreA: 1 vitória A, 0 vitória B, 0.5 empate. */
  function computeElo(userA, userB, scoreA) {
    var ra = Number(userA.elo) || CONFIG.ELO.START;
    var rb = Number(userB.elo) || CONFIG.ELO.START;
    var ea = expectedScore(ra, rb);
    var eb = 1 - ea;
    var ka = kFactor(userA), kb = kFactor(userB);

    var newA = Math.round(ra + ka * (scoreA - ea));
    var newB = Math.round(rb + kb * ((1 - scoreA) - eb));

    newA = Math.max(CONFIG.ELO.FLOOR, newA);
    newB = Math.max(CONFIG.ELO.FLOOR, newB);

    return { newA: newA, newB: newB, deltaA: newA - ra, deltaB: newB - rb };
  }

  function applyResult(userA, userB, scoreA) {
    var r = computeElo(userA, userB, scoreA);
    var patchA = {
      elo: r.newA,
      gamesPlayed: (Number(userA.gamesPlayed) || 0) + 1,
      wins: (Number(userA.wins) || 0) + (scoreA === 1 ? 1 : 0),
      losses: (Number(userA.losses) || 0) + (scoreA === 0 ? 1 : 0),
      draws: (Number(userA.draws) || 0) + (scoreA === 0.5 ? 1 : 0),
      lastSeenAt: Util.now()
    };
    var patchB = {
      elo: r.newB,
      gamesPlayed: (Number(userB.gamesPlayed) || 0) + 1,
      wins: (Number(userB.wins) || 0) + (scoreA === 0 ? 1 : 0),
      losses: (Number(userB.losses) || 0) + (scoreA === 1 ? 1 : 0),
      draws: (Number(userB.draws) || 0) + (scoreA === 0.5 ? 1 : 0),
      lastSeenAt: Util.now()
    };
    SheetRepository.update(CONFIG.SHEETS.USERS, userA._row, patchA);
    SheetRepository.update(CONFIG.SHEETS.USERS, userB._row, patchB);
    return r;
  }

  function leaderboard(limit) {
    limit = Util.clamp(Number(limit) || 25, 1, 100);
    var users = SheetRepository.findAll(CONFIG.SHEETS.USERS);
    users.sort(function (a, b) { return (Number(b.elo) || 0) - (Number(a.elo) || 0); });
    return users.slice(0, limit).map(function (u, i) {
      return {
        rank: i + 1,
        username: u.username,
        elo: Number(u.elo) || CONFIG.ELO.START,
        wins: Number(u.wins) || 0,
        losses: Number(u.losses) || 0,
        division: divisionFor(Number(u.elo) || CONFIG.ELO.START)
      };
    });
  }

  return {
    divisionFor: divisionFor, expectedScore: expectedScore,
    computeElo: computeElo, applyResult: applyResult, leaderboard: leaderboard
  };
})();

/* --------------------------- 5.3 Matchmaking ----------------------------- */

var MatchmakingService = (function () {

  function purgeStale() {
    var cutoff = Util.now() - CONFIG.MATCH.QUEUE_TTL_MS;
    var stale = SheetRepository.filterBy(CONFIG.SHEETS.QUEUE, function (q) {
      return q.status === 'waiting' && Number(q.heartbeatAt || q.joinedAt) < cutoff;
    });
    if (stale.length) {
      SheetRepository.removeMany(CONFIG.SHEETS.QUEUE, stale.map(function (s) { return s._row; }));
    }
  }

  /** Emparelha por proximidade de Elo, com janela que abre com o tempo. */
  function pickOpponent(entries, me) {
    var best = null, bestScore = Infinity;
    var myElo = Number(me.elo) || CONFIG.ELO.START;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.userId === me.userId) continue;
      if (e.status !== 'waiting') continue;
      var waitedS = (Util.now() - Number(e.joinedAt)) / 1000;
      var window = 120 + waitedS * 20;          // janela cresce 20 pts/seg
      var diff = Math.abs((Number(e.elo) || CONFIG.ELO.START) - myElo);
      if (diff > window) continue;
      if (diff < bestScore) { bestScore = diff; best = e; }
    }
    return best;
  }

  function enqueue(user) {
    return Util.withLock(function () {
      purgeStale();

      // Já está em partida ativa? devolve a partida.
      var active = MatchService.findActiveByUser(user.id);
      if (active) return { status: 'matched', matchId: active.matchId };

      var entries = SheetRepository.findAll(CONFIG.SHEETS.QUEUE);
      var mine = entries.filter(function (q) { return q.userId === user.id; })[0];

      if (mine && mine.status === 'matched' && mine.matchId) {
        return { status: 'matched', matchId: mine.matchId, side: mine.side };
      }

      if (!mine) {
        mine = {
          queueId: Util.shortId('q_'),
          userId: user.id,
          username: user.username,
          elo: Number(user.elo) || CONFIG.ELO.START,
          joinedAt: Util.now(),
          heartbeatAt: Util.now(),
          status: 'waiting',
          matchId: '',
          side: ''
        };
        SheetRepository.insert(CONFIG.SHEETS.QUEUE, mine);
        entries.push(mine);
      } else {
        SheetRepository.update(CONFIG.SHEETS.QUEUE, mine._row, { heartbeatAt: Util.now() });
        mine.heartbeatAt = Util.now();
      }

      var rival = pickOpponent(entries, mine);
      if (!rival) {
        return {
          status: 'waiting',
          queueId: mine.queueId,
          waitingMs: Util.now() - Number(mine.joinedAt),
          queueSize: entries.filter(function (q) { return q.status === 'waiting'; }).length
        };
      }

      // Determinismo no lado: quem entrou primeiro joga com A (inicia).
      var first = Number(rival.joinedAt) <= Number(mine.joinedAt) ? rival : mine;
      var second = first === rival ? mine : rival;

      var match = MatchService.create(first, second);

      SheetRepository.update(CONFIG.SHEETS.QUEUE, first._row,
        { status: 'matched', matchId: match.matchId, side: 'A' });
      SheetRepository.update(CONFIG.SHEETS.QUEUE, second._row,
        { status: 'matched', matchId: match.matchId, side: 'B' });

      return {
        status: 'matched',
        matchId: match.matchId,
        side: mine.userId === first.userId ? 'A' : 'B'
      };
    });
  }

  function poll(user) {
    purgeStale();
    var active = MatchService.findActiveByUser(user.id);
    if (active) {
      return {
        status: 'matched',
        matchId: active.matchId,
        side: String(active.playerAId) === String(user.id) ? 'A' : 'B'
      };
    }
    var mine = SheetRepository.findBy(CONFIG.SHEETS.QUEUE, 'userId', user.id);
    if (!mine) return { status: 'idle' };

    SheetRepository.update(CONFIG.SHEETS.QUEUE, mine._row, { heartbeatAt: Util.now() });

    if (mine.status === 'matched' && mine.matchId) {
      return { status: 'matched', matchId: mine.matchId, side: mine.side };
    }
    var waiting = SheetRepository.filterBy(CONFIG.SHEETS.QUEUE, function (q) {
      return q.status === 'waiting';
    }).length;
    return {
      status: 'waiting',
      waitingMs: Util.now() - Number(mine.joinedAt),
      queueSize: waiting
    };
  }

  function leave(user) {
    return Util.withLock(function () {
      var mine = SheetRepository.findBy(CONFIG.SHEETS.QUEUE, 'userId', user.id);
      if (mine && mine.status === 'waiting') {
        SheetRepository.remove(CONFIG.SHEETS.QUEUE, mine._row);
      }
      return { status: 'left' };
    });
  }

  function clearEntry(userId) {
    var mine = SheetRepository.findBy(CONFIG.SHEETS.QUEUE, 'userId', userId);
    if (mine) SheetRepository.remove(CONFIG.SHEETS.QUEUE, mine._row);
  }

  return { enqueue: enqueue, poll: poll, leave: leave, clearEntry: clearEntry, purgeStale: purgeStale };
})();

/* ----------------------------- 5.4 Partidas ------------------------------ */

var MatchService = (function () {

  function findById(matchId) {
    return SheetRepository.findBy(CONFIG.SHEETS.MATCHES, 'matchId', matchId);
  }

  function findActiveByUser(userId) {
    var rows = SheetRepository.filterBy(CONFIG.SHEETS.MATCHES, function (m) {
      return m.status === 'playing' &&
             (String(m.playerAId) === String(userId) || String(m.playerBId) === String(userId));
    });
    return rows.length ? rows[rows.length - 1] : null;
  }

  function create(queueA, queueB) {
    var state = Rules.createInitialState();
    var match = {
      matchId: Util.shortId('m_'),
      playerAId: queueA.userId,
      playerAName: queueA.username,
      playerAElo: queueA.elo,
      playerBId: queueB.userId,
      playerBName: queueB.username,
      playerBElo: queueB.elo,
      turn: 'A',
      version: 1,
      status: 'playing',
      winner: '',
      reason: '',
      stateJson: Rules.serialize(state),
      lastMoveJson: '',
      createdAt: Util.now(),
      updatedAt: Util.now(),
      heartbeatA: Util.now(),
      heartbeatB: Util.now()
    };
    SheetRepository.insert(CONFIG.SHEETS.MATCHES, match);
    return match;
  }

  function sideOf(match, userId) {
    if (String(match.playerAId) === String(userId)) return 'A';
    if (String(match.playerBId) === String(userId)) return 'B';
    return null;
  }

  function toDto(match, side) {
    return {
      matchId: match.matchId,
      version: Number(match.version),
      status: match.status,
      turn: match.turn,
      winner: match.winner === '' ? null : Number(match.winner),
      reason: match.reason || null,
      you: side,
      players: {
        A: { name: match.playerAName, elo: Number(match.playerAElo) },
        B: { name: match.playerBName, elo: Number(match.playerBElo) }
      },
      state: Util.parseJsonSafe(match.stateJson, null),
      lastMove: Util.parseJsonSafe(match.lastMoveJson, null),
      updatedAt: Number(match.updatedAt)
    };
  }

  function get(user, matchId, knownVersion) {
    var match = findById(matchId);
    if (!match) throw new ApiError('MATCH_NOT_FOUND', 'Partida não encontrada.', 404);
    var side = sideOf(match, user.id);
    if (!side) throw new ApiError('NOT_A_PLAYER', 'Você não está nessa partida.', 403);

    // heartbeat do observador
    var patch = {};
    patch[side === 'A' ? 'heartbeatA' : 'heartbeatB'] = Util.now();
    SheetRepository.update(CONFIG.SHEETS.MATCHES, match._row, patch);

    if (knownVersion !== undefined && knownVersion !== null &&
        Number(knownVersion) === Number(match.version)) {
      return { changed: false, version: Number(match.version), status: match.status, you: side };
    }
    var dto = toDto(match, side);
    dto.changed = true;
    return dto;
  }

  function submitMove(user, matchId, from, path, clientVersion) {
    return Util.withLock(function () {
      var match = findById(matchId);
      if (!match) throw new ApiError('MATCH_NOT_FOUND', 'Partida não encontrada.', 404);
      if (match.status !== 'playing') throw new ApiError('MATCH_OVER', 'Partida encerrada.', 409);

      var side = sideOf(match, user.id);
      if (!side) throw new ApiError('NOT_A_PLAYER', 'Você não está nessa partida.', 403);
      if (match.turn !== side) throw new ApiError('NOT_YOUR_TURN', 'Não é seu turno.', 409);

      if (clientVersion && Number(clientVersion) !== Number(match.version)) {
        throw new ApiError('STALE_STATE', 'Estado desatualizado, sincronizando.', 409);
      }

      var state = Rules.deserialize(match.stateJson);
      var expectedTurn = side === 'A' ? Rules.A : Rules.B;
      if (state.turn !== expectedTurn) throw new ApiError('NOT_YOUR_TURN', 'Não é seu turno.', 409);

      var move = Rules.findLegalMove(state, Number(from), (path || []).map(Number));
      if (!move) throw new ApiError('ILLEGAL_MOVE', 'Jogada ilegal.', 422);

      var next = Rules.applyMove(state, move);

      var patch = {
        stateJson: Rules.serialize(next),
        lastMoveJson: JSON.stringify(next.lastMove),
        turn: next.turn === Rules.A ? 'A' : 'B',
        version: Number(match.version) + 1,
        updatedAt: Util.now()
      };

      if (next.status === 'finished') {
        patch.status = 'finished';
        patch.winner = next.winner;
        patch.reason = next.reason;
      }
      SheetRepository.update(CONFIG.SHEETS.MATCHES, match._row, patch);

      var ranking = null;
      if (next.status === 'finished') {
        ranking = finalize(match.matchId, next.winner, next.reason, next.ply);
      }

      var dto = toDto(
        Object.assign({}, match, patch, { _row: match._row }),
        side
      );
      dto.changed = true;
      dto.ranking = ranking;
      return dto;
    });
  }

  function resign(user, matchId) {
    return Util.withLock(function () {
      var match = findById(matchId);
      if (!match) throw new ApiError('MATCH_NOT_FOUND', 'Partida não encontrada.', 404);
      var side = sideOf(match, user.id);
      if (!side) throw new ApiError('NOT_A_PLAYER', 'Você não está nessa partida.', 403);
      if (match.status !== 'playing') return toDto(match, side);

      var winner = side === 'A' ? Rules.B : Rules.A;
      SheetRepository.update(CONFIG.SHEETS.MATCHES, match._row, {
        status: 'finished', winner: winner, reason: 'resign',
        version: Number(match.version) + 1, updatedAt: Util.now()
      });
      var ranking = finalize(matchId, winner, 'resign', 0);
      var dto = toDto(findById(matchId), side);
      dto.ranking = ranking;
      dto.changed = true;
      return dto;
    });
  }

  /** Aplica Elo, grava histórico e limpa a fila dos dois jogadores. */
  function finalize(matchId, winner, reason, plies) {
    var match = findById(matchId);
    if (!match) return null;

    var userA = SheetRepository.findBy(CONFIG.SHEETS.USERS, 'id', match.playerAId);
    var userB = SheetRepository.findBy(CONFIG.SHEETS.USERS, 'id', match.playerBId);
    if (!userA || !userB) return null;

    var scoreA = winner === Rules.A ? 1 : (winner === Rules.B ? 0 : 0.5);
    var result = RankingService.applyResult(userA, userB, scoreA);

    SheetRepository.insert(CONFIG.SHEETS.HISTORY, {
      matchId: matchId,
      playerAId: match.playerAId,
      playerBId: match.playerBId,
      winner: winner,
      reason: reason,
      eloDeltaA: result.deltaA,
      eloDeltaB: result.deltaB,
      plies: plies || 0,
      finishedAt: Util.now()
    });

    MatchmakingService.clearEntry(match.playerAId);
    MatchmakingService.clearEntry(match.playerBId);

    return {
      A: { elo: result.newA, delta: result.deltaA, division: RankingService.divisionFor(result.newA) },
      B: { elo: result.newB, delta: result.deltaB, division: RankingService.divisionFor(result.newB) }
    };
  }

  /** Encerra partidas cujo jogador da vez sumiu. Chamada pelo poll e pelo cron. */
  function sweepTimeouts() {
    var cutoff = Util.now() - CONFIG.MATCH.TURN_TIMEOUT_MS;
    var open = SheetRepository.filterBy(CONFIG.SHEETS.MATCHES, function (m) {
      return m.status === 'playing';
    });
    open.forEach(function (m) {
      var hb = m.turn === 'A' ? Number(m.heartbeatA) : Number(m.heartbeatB);
      if (hb && hb < cutoff) {
        var winner = m.turn === 'A' ? Rules.B : Rules.A;
        SheetRepository.update(CONFIG.SHEETS.MATCHES, m._row, {
          status: 'finished', winner: winner, reason: 'timeout',
          version: Number(m.version) + 1, updatedAt: Util.now()
        });
        finalize(m.matchId, winner, 'timeout', 0);
      }
    });
  }

  return {
    create: create, get: get, submitMove: submitMove, resign: resign,
    findById: findById, findActiveByUser: findActiveByUser,
    finalize: finalize, sweepTimeouts: sweepTimeouts, sideOf: sideOf, toDto: toDto
  };
})();

/* ========================================================================== */
/* 6. CONTROLLERS + ROUTER                                                    */
/* ========================================================================== */

var ApiResponse = {
  ok: function (data) {
    return { ok: true, version: CONFIG.API_VERSION, serverTime: Util.now(), data: data || {} };
  },
  fail: function (err) {
    var isApi = err instanceof ApiError || err.code;
    return {
      ok: false,
      version: CONFIG.API_VERSION,
      serverTime: Util.now(),
      error: {
        code: isApi ? err.code : 'INTERNAL',
        message: err.message || 'Erro interno',
        status: isApi ? err.httpish : 500
      }
    };
  }
};

var Controllers = {

  ping: function () {
    return { pong: true, api: CONFIG.API_VERSION };
  },

  register: function (p) {
    return AuthService.register(p.username, p.password);
  },

  login: function (p) {
    return AuthService.login(p.username, p.password);
  },

  me: function (p, user) {
    return { user: AuthService.publicUser(user) };
  },

  queueJoin: function (p, user) {
    return MatchmakingService.enqueue(user);
  },

  queuePoll: function (p, user) {
    return MatchmakingService.poll(user);
  },

  queueLeave: function (p, user) {
    return MatchmakingService.leave(user);
  },

  matchGet: function (p, user) {
    return MatchService.get(user, p.matchId, p.version);
  },

  matchMove: function (p, user) {
    return MatchService.submitMove(user, p.matchId, p.from, p.path, p.version);
  },

  matchResign: function (p, user) {
    return MatchService.resign(user, p.matchId);
  },

  leaderboard: function (p) {
    return { entries: RankingService.leaderboard(p.limit) };
  },

  /** Reporta o resultado de uma partida contra a IA (não altera Elo ranqueado). */
  reportBotResult: function (p, user) {
    var won = !!p.won;
    SheetRepository.update(CONFIG.SHEETS.USERS, user._row, { lastSeenAt: Util.now() });
    return { recorded: true, won: won, elo: Number(user.elo) };
  }
};

var Router = (function () {

  // rota -> { handler, auth }
  var ROUTES = {
    'ping':            { fn: Controllers.ping,           auth: false },
    'auth.register':   { fn: Controllers.register,       auth: false },
    'auth.login':      { fn: Controllers.login,          auth: false },
    'auth.me':         { fn: Controllers.me,             auth: true  },
    'queue.join':      { fn: Controllers.queueJoin,      auth: true  },
    'queue.poll':      { fn: Controllers.queuePoll,      auth: true  },
    'queue.leave':     { fn: Controllers.queueLeave,     auth: true  },
    'match.get':       { fn: Controllers.matchGet,       auth: true  },
    'match.move':      { fn: Controllers.matchMove,      auth: true  },
    'match.resign':    { fn: Controllers.matchResign,    auth: true  },
    'rank.leaderboard':{ fn: Controllers.leaderboard,    auth: false },
    'bot.report':      { fn: Controllers.reportBotResult,auth: true  }
  };

  function dispatch(payload) {
    var action = payload && payload.action;
    var route = ROUTES[action];
    if (!route) throw new ApiError('UNKNOWN_ACTION', 'Ação desconhecida: ' + action, 404);

    var user = null;
    if (route.auth) user = AuthService.requireUser(payload.token);

    return route.fn(payload, user);
  }

  return { dispatch: dispatch, ROUTES: ROUTES };
})();

/* ========================================================================== */
/* 7. ENTRYPOINTS HTTP                                                        */
/* ========================================================================== */

function jsonOut(obj, callback) {
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(obj) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * GET — usado para leituras e como fallback JSONP quando o navegador
 * bloqueia a resposta opaca do POST. Parâmetros via querystring; `payload`
 * pode conter o JSON inteiro codificado.
 */
function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var payload = params.payload
      ? Util.parseJsonSafe(decodeURIComponent(params.payload), {})
      : params;
    var result = Router.dispatch(payload);
    return jsonOut(ApiResponse.ok(result), params.callback);
  } catch (err) {
    return jsonOut(ApiResponse.fail(err), (e && e.parameter && e.parameter.callback));
  }
}

/**
 * POST — canal principal. O corpo chega como text/plain para evitar preflight.
 */
function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    var payload = Util.parseJsonSafe(raw, {});
    if (!payload.action && e && e.parameter && e.parameter.action) {
      payload.action = e.parameter.action;
    }
    var result = Router.dispatch(payload);
    return jsonOut(ApiResponse.ok(result));
  } catch (err) {
    return jsonOut(ApiResponse.fail(err));
  }
}

/* ========================================================================== */
/* 8. MANUTENÇÃO / SETUP                                                      */
/* ========================================================================== */

/** Execute uma vez no editor: cria abas, índices e o segredo de sessão. */
function setup() {
  SheetRepository.ensureAll();
  PropertiesService.getScriptProperties().getProperty('AURA_SECRET') ||
    PropertiesService.getScriptProperties().setProperty('AURA_SECRET',
      Utilities.getUuid() + Utilities.getUuid());
  Logger.log('Aura backend pronto. Abas: ' + Object.keys(CONFIG.SCHEMA).join(', '));
}

/** Gatilho por tempo sugerido: a cada 5 minutos. */
function cronMaintenance() {
  try {
    MatchmakingService.purgeStale();
    MatchService.sweepTimeouts();
    archiveOldMatches();
  } catch (e) {
    Logger.log('cronMaintenance: ' + e);
  }
}

function archiveOldMatches() {
  var cutoff = Util.now() - CONFIG.MATCH.MATCH_TTL_MS;
  var old = SheetRepository.filterBy(CONFIG.SHEETS.MATCHES, function (m) {
    return m.status === 'finished' && Number(m.updatedAt) < cutoff;
  });
  if (old.length) {
    SheetRepository.removeMany(CONFIG.SHEETS.MATCHES, old.map(function (m) { return m._row; }));
  }
}

/** Teste rápido do motor de regras dentro do próprio GAS. */
function selfTest() {
  var s = Rules.createInitialState();
  var moves = Rules.generateAllMoves(s, Rules.A);
  Logger.log('Movimentos iniciais de A: ' + moves.length);
  var next = Rules.applyMove(s, moves[0]);
  Logger.log('Território A: ' + Rules.territoryCount(next)[Rules.A]);
  Logger.log('Serialização OK: ' + (Rules.deserialize(Rules.serialize(next)).ply === next.ply));
}
