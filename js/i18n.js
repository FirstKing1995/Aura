/**
 * ============================================================================
 *  AURA — Internacionalização
 * ============================================================================
 *  Dicionário plano com chaves em notação de ponto. Detecta o idioma do
 *  navegador, permite troca manual e persiste a escolha. A aplicação em DOM
 *  é declarativa via atributos:
 *      data-i18n="chave"            -> textContent
 *      data-i18n-attr="placeholder:chave;aria-label:outra"
 *  Interpolação: t('queue.elapsed', { time: '00:12' })
 * ============================================================================
 */
(function (root) {
  'use strict';

  const DICTIONARIES = {

    /* ------------------------------ Português ------------------------------ */
    pt: {
      'app.tagline': 'Domine o tabuleiro. Domine a luz.',
      'app.loading': 'Acendendo a aura',

      'auth.welcome': 'Entre para jogar',
      'auth.username': 'Nome de jogador',
      'auth.password': 'Senha',
      'auth.login': 'Entrar',
      'auth.register': 'Criar conta',
      'auth.switchToRegister': 'Não tem conta? Criar uma',
      'auth.switchToLogin': 'Já tenho conta',
      'auth.offline': 'Jogar sem conta',
      'auth.offlineHint': 'Partidas contra a IA, sem ranking.',

      'home.greeting': 'Olá, {name}',
      'home.record': '{wins}V · {losses}D',
      'home.playOnline': 'Partida online',
      'home.playBot': 'Jogar contra a IA',
      'home.ranking': 'Ranking',
      'home.tutorial': 'Como se joga',
      'home.logout': 'Sair',
      'home.difficulty': 'Dificuldade da IA',

      'level.novice': 'Iniciante',
      'level.adept': 'Adepto',
      'level.master': 'Mestre',

      'queue.searching': 'Procurando oponente',
      'queue.elapsed': '{time} na fila',
      'queue.inQueue': '{count} na fila',
      'queue.botIn': 'IA entra em {seconds}s',
      'queue.startingBot': 'Ninguém por perto. Chamando a IA.',
      'queue.cancel': 'Cancelar busca',
      'queue.matched': 'Oponente encontrado',

      'game.yourTurn': 'Seu turno',
      'game.opponentTurn': 'Turno de {name}',
      'game.thinking': '{name} está pensando',
      'game.territory': 'Território',
      'game.sentinels': 'Sentinelas',
      'game.resign': 'Desistir',
      'game.resignConfirm': 'Desistir da partida?',
      'game.yes': 'Desistir',
      'game.no': 'Continuar',
      'game.reconnecting': 'Reconectando',
      'game.captured': '{count} capturada(s)',
      'game.siege': 'Cerco fechado',
      'game.coreWarning': 'Seu Núcleo está sem ar',

      'result.victory': 'Vitória',
      'result.defeat': 'Derrota',
      'result.draw': 'Empate',
      'result.rematch': 'Jogar de novo',
      'result.home': 'Voltar ao início',
      'result.elo': '{elo} Elo',

      'reason.core': 'Núcleo capturado',
      'reason.territory': '70% do território dominado',
      'reason.stalemate': 'Sem movimentos possíveis',
      'reason.resign': 'Desistência',
      'reason.timeout': 'Tempo esgotado',
      'reason.double_core': 'Os dois Núcleos caíram',
      'reason.adjudication': 'Decidido pelo território',

      'rank.title': 'Ranking',
      'rank.empty': 'Ninguém pontuou ainda. Seja o primeiro.',
      'rank.elo': 'Elo',
      'rank.player': 'Jogador',

      'division.iron': 'Ferro',
      'division.bronze': 'Bronze',
      'division.silver': 'Prata',
      'division.gold': 'Ouro',
      'division.grandmaster': 'Grão-Mestre',

      'tutorial.title': 'Três passos',
      'tutorial.move': 'Toque na peça e mova 1 casa.',
      'tutorial.jump': 'Salte sobre a peça inimiga.',
      'tutorial.siege': 'Feche o cerco e capture.',
      'tutorial.done': 'Pronto. Boa partida.',
      'tutorial.skip': 'Pular',
      'tutorial.next': 'Continuar',
      'tutorial.retry': 'Tente de novo',

      'error.NETWORK': 'Sem conexão com o servidor.',
      'error.TIMEOUT': 'O servidor demorou demais.',
      'error.BAD_CREDENTIALS': 'Nome ou senha incorretos.',
      'error.USERNAME_TAKEN': 'Esse nome já existe.',
      'error.USERNAME_SHORT': 'Use pelo menos 3 caracteres.',
      'error.USERNAME_INVALID': 'Use letras, números, ponto, hífen ou _.',
      'error.PASSWORD_SHORT': 'A senha precisa de 4 caracteres.',
      'error.NOT_YOUR_TURN': 'Não é seu turno.',
      'error.ILLEGAL_MOVE': 'Jogada não permitida.',
      'error.STALE_STATE': 'Sincronizando o tabuleiro.',
      'error.MATCH_NOT_FOUND': 'Partida não encontrada.',
      'error.EXPIRED_TOKEN': 'Sessão expirada. Entre de novo.',
      'error.BAD_TOKEN': 'Sessão inválida. Entre de novo.',
      'error.SERVER_BUSY': 'Servidor ocupado. Tentando de novo.',
      'error.UNKNOWN': 'Algo deu errado.',

      'common.back': 'Voltar',
      'common.close': 'Fechar',
      'common.language': 'Idioma',
      'common.you': 'Você',
      'common.bot': 'IA'
    },

    /* ------------------------------- English ------------------------------- */
    en: {
      'app.tagline': 'Own the board. Own the light.',
      'app.loading': 'Lighting the aura',

      'auth.welcome': 'Sign in to play',
      'auth.username': 'Player name',
      'auth.password': 'Password',
      'auth.login': 'Sign in',
      'auth.register': 'Create account',
      'auth.switchToRegister': 'No account? Create one',
      'auth.switchToLogin': 'I already have an account',
      'auth.offline': 'Play without an account',
      'auth.offlineHint': 'Games against the AI, no ranking.',

      'home.greeting': 'Hi, {name}',
      'home.record': '{wins}W · {losses}L',
      'home.playOnline': 'Online match',
      'home.playBot': 'Play the AI',
      'home.ranking': 'Ranking',
      'home.tutorial': 'How to play',
      'home.logout': 'Sign out',
      'home.difficulty': 'AI difficulty',

      'level.novice': 'Novice',
      'level.adept': 'Adept',
      'level.master': 'Master',

      'queue.searching': 'Looking for an opponent',
      'queue.elapsed': '{time} in queue',
      'queue.inQueue': '{count} in queue',
      'queue.botIn': 'AI joins in {seconds}s',
      'queue.startingBot': 'Nobody around. Calling the AI.',
      'queue.cancel': 'Cancel search',
      'queue.matched': 'Opponent found',

      'game.yourTurn': 'Your turn',
      'game.opponentTurn': "{name}'s turn",
      'game.thinking': '{name} is thinking',
      'game.territory': 'Territory',
      'game.sentinels': 'Sentinels',
      'game.resign': 'Resign',
      'game.resignConfirm': 'Resign this match?',
      'game.yes': 'Resign',
      'game.no': 'Keep playing',
      'game.reconnecting': 'Reconnecting',
      'game.captured': '{count} captured',
      'game.siege': 'Siege closed',
      'game.coreWarning': 'Your Core is out of air',

      'result.victory': 'Victory',
      'result.defeat': 'Defeat',
      'result.draw': 'Draw',
      'result.rematch': 'Play again',
      'result.home': 'Back to start',
      'result.elo': '{elo} Elo',

      'reason.core': 'Core captured',
      'reason.territory': '70% of the board owned',
      'reason.stalemate': 'No moves left',
      'reason.resign': 'Resignation',
      'reason.timeout': 'Time ran out',
      'reason.double_core': 'Both Cores fell',
      'reason.adjudication': 'Decided on territory',

      'rank.title': 'Ranking',
      'rank.empty': 'No scores yet. Be the first.',
      'rank.elo': 'Elo',
      'rank.player': 'Player',

      'division.iron': 'Iron',
      'division.bronze': 'Bronze',
      'division.silver': 'Silver',
      'division.gold': 'Gold',
      'division.grandmaster': 'Grandmaster',

      'tutorial.title': 'Three steps',
      'tutorial.move': 'Tap a piece and move 1 square.',
      'tutorial.jump': 'Jump over the enemy piece.',
      'tutorial.siege': 'Close the siege and capture.',
      'tutorial.done': 'Done. Good game.',
      'tutorial.skip': 'Skip',
      'tutorial.next': 'Continue',
      'tutorial.retry': 'Try again',

      'error.NETWORK': 'No connection to the server.',
      'error.TIMEOUT': 'The server took too long.',
      'error.BAD_CREDENTIALS': 'Wrong name or password.',
      'error.USERNAME_TAKEN': 'That name is taken.',
      'error.USERNAME_SHORT': 'Use at least 3 characters.',
      'error.USERNAME_INVALID': 'Use letters, numbers, dot, hyphen or _.',
      'error.PASSWORD_SHORT': 'Password needs 4 characters.',
      'error.NOT_YOUR_TURN': 'Not your turn.',
      'error.ILLEGAL_MOVE': 'That move is not allowed.',
      'error.STALE_STATE': 'Syncing the board.',
      'error.MATCH_NOT_FOUND': 'Match not found.',
      'error.EXPIRED_TOKEN': 'Session expired. Sign in again.',
      'error.BAD_TOKEN': 'Invalid session. Sign in again.',
      'error.SERVER_BUSY': 'Server busy. Retrying.',
      'error.UNKNOWN': 'Something went wrong.',

      'common.back': 'Back',
      'common.close': 'Close',
      'common.language': 'Language',
      'common.you': 'You',
      'common.bot': 'AI'
    },

    /* ------------------------------- Español ------------------------------- */
    es: {
      'app.tagline': 'Domina el tablero. Domina la luz.',
      'app.loading': 'Encendiendo el aura',

      'auth.welcome': 'Entra para jugar',
      'auth.username': 'Nombre de jugador',
      'auth.password': 'Contraseña',
      'auth.login': 'Entrar',
      'auth.register': 'Crear cuenta',
      'auth.switchToRegister': '¿Sin cuenta? Crear una',
      'auth.switchToLogin': 'Ya tengo cuenta',
      'auth.offline': 'Jugar sin cuenta',
      'auth.offlineHint': 'Partidas contra la IA, sin ranking.',

      'home.greeting': 'Hola, {name}',
      'home.record': '{wins}G · {losses}P',
      'home.playOnline': 'Partida en línea',
      'home.playBot': 'Jugar contra la IA',
      'home.ranking': 'Clasificación',
      'home.tutorial': 'Cómo se juega',
      'home.logout': 'Salir',
      'home.difficulty': 'Dificultad de la IA',

      'level.novice': 'Principiante',
      'level.adept': 'Adepto',
      'level.master': 'Maestro',

      'queue.searching': 'Buscando rival',
      'queue.elapsed': '{time} en la cola',
      'queue.inQueue': '{count} en la cola',
      'queue.botIn': 'La IA entra en {seconds}s',
      'queue.startingBot': 'No hay nadie. Llamando a la IA.',
      'queue.cancel': 'Cancelar búsqueda',
      'queue.matched': 'Rival encontrado',

      'game.yourTurn': 'Tu turno',
      'game.opponentTurn': 'Turno de {name}',
      'game.thinking': '{name} está pensando',
      'game.territory': 'Territorio',
      'game.sentinels': 'Centinelas',
      'game.resign': 'Rendirse',
      'game.resignConfirm': '¿Rendirse en esta partida?',
      'game.yes': 'Rendirse',
      'game.no': 'Seguir jugando',
      'game.reconnecting': 'Reconectando',
      'game.captured': '{count} capturada(s)',
      'game.siege': 'Cerco cerrado',
      'game.coreWarning': 'Tu Núcleo se queda sin aire',

      'result.victory': 'Victoria',
      'result.defeat': 'Derrota',
      'result.draw': 'Empate',
      'result.rematch': 'Jugar otra vez',
      'result.home': 'Volver al inicio',
      'result.elo': '{elo} Elo',

      'reason.core': 'Núcleo capturado',
      'reason.territory': '70% del territorio dominado',
      'reason.stalemate': 'Sin movimientos posibles',
      'reason.resign': 'Rendición',
      'reason.timeout': 'Tiempo agotado',
      'reason.double_core': 'Cayeron los dos Núcleos',
      'reason.adjudication': 'Decidido por territorio',

      'rank.title': 'Clasificación',
      'rank.empty': 'Nadie ha puntuado. Sé el primero.',
      'rank.elo': 'Elo',
      'rank.player': 'Jugador',

      'division.iron': 'Hierro',
      'division.bronze': 'Bronce',
      'division.silver': 'Plata',
      'division.gold': 'Oro',
      'division.grandmaster': 'Gran Maestro',

      'tutorial.title': 'Tres pasos',
      'tutorial.move': 'Toca una pieza y muévela 1 casilla.',
      'tutorial.jump': 'Salta sobre la pieza enemiga.',
      'tutorial.siege': 'Cierra el cerco y captura.',
      'tutorial.done': 'Listo. Buena partida.',
      'tutorial.skip': 'Saltar',
      'tutorial.next': 'Continuar',
      'tutorial.retry': 'Inténtalo de nuevo',

      'error.NETWORK': 'Sin conexión con el servidor.',
      'error.TIMEOUT': 'El servidor tardó demasiado.',
      'error.BAD_CREDENTIALS': 'Nombre o contraseña incorrectos.',
      'error.USERNAME_TAKEN': 'Ese nombre ya existe.',
      'error.USERNAME_SHORT': 'Usa al menos 3 caracteres.',
      'error.USERNAME_INVALID': 'Usa letras, números, punto, guion o _.',
      'error.PASSWORD_SHORT': 'La contraseña necesita 4 caracteres.',
      'error.NOT_YOUR_TURN': 'No es tu turno.',
      'error.ILLEGAL_MOVE': 'Ese movimiento no vale.',
      'error.STALE_STATE': 'Sincronizando el tablero.',
      'error.MATCH_NOT_FOUND': 'Partida no encontrada.',
      'error.EXPIRED_TOKEN': 'Sesión caducada. Entra de nuevo.',
      'error.BAD_TOKEN': 'Sesión inválida. Entra de nuevo.',
      'error.SERVER_BUSY': 'Servidor ocupado. Reintentando.',
      'error.UNKNOWN': 'Algo salió mal.',

      'common.back': 'Volver',
      'common.close': 'Cerrar',
      'common.language': 'Idioma',
      'common.you': 'Tú',
      'common.bot': 'IA'
    }
  };

  const SUPPORTED = Object.keys(DICTIONARIES);
  const FALLBACK = 'en';

  class I18n {
    constructor() {
      this.lang = FALLBACK;
      this.listeners = new Set();
    }

    detect() {
      const saved = root.AuraUtils && root.AuraUtils.Storage.get('lang');
      if (saved && SUPPORTED.includes(saved)) return saved;

      const candidates = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language || navigator.userLanguage || FALLBACK];

      for (const raw of candidates) {
        const base = String(raw).toLowerCase().split('-')[0];
        if (SUPPORTED.includes(base)) return base;
      }
      return FALLBACK;
    }

    init() {
      this.setLanguage(this.detect(), { silent: true });
      return this;
    }

    setLanguage(lang, { silent = false } = {}) {
      if (!SUPPORTED.includes(lang)) lang = FALLBACK;
      this.lang = lang;
      if (root.AuraUtils) root.AuraUtils.Storage.set('lang', lang);
      if (typeof document !== 'undefined') {
        document.documentElement.lang = lang;
        this.applyToDom();
      }
      if (!silent) this.listeners.forEach(fn => fn(lang));
      return lang;
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    /** Traduz uma chave com interpolação `{var}`. */
    t(key, vars) {
      const dict = DICTIONARIES[this.lang] || DICTIONARIES[FALLBACK];
      let str = dict[key];
      if (str === undefined) str = DICTIONARIES[FALLBACK][key];
      if (str === undefined) return key;
      if (!vars) return str;
      return str.replace(/\{(\w+)\}/g, (m, name) =>
        (vars[name] === undefined ? m : String(vars[name])));
    }

    /** Traduz o código de erro do backend para linguagem humana. */
    error(code) {
      const key = 'error.' + (code || 'UNKNOWN');
      const out = this.t(key);
      return out === key ? this.t('error.UNKNOWN') : out;
    }

    applyToDom(scope = document) {
      scope.querySelectorAll('[data-i18n]').forEach(node => {
        node.textContent = this.t(node.getAttribute('data-i18n'));
      });
      scope.querySelectorAll('[data-i18n-attr]').forEach(node => {
        node.getAttribute('data-i18n-attr').split(';').forEach(pair => {
          const [attr, key] = pair.split(':').map(s => s && s.trim());
          if (attr && key) node.setAttribute(attr, this.t(key));
        });
      });
    }

    get supported() { return SUPPORTED.slice(); }
  }

  root.AuraI18n = new I18n();
  root.AuraI18n.DICTIONARIES = DICTIONARIES;
})(typeof self !== 'undefined' ? self : this);
