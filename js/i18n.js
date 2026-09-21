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
 *
 *  Invariante testada no CI: os três dicionários têm EXATAMENTE o mesmo
 *  conjunto de chaves. Chave faltando em um idioma é bug, não detalhe.
 * ============================================================================
 */
(function (root) {
  'use strict';

  const DICTIONARIES = {

    /* ====================== Português ====================== */
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
      'auth.offlineHint': 'Campanha e partidas contra a IA, sem ranking.',

      'home.greeting': 'Olá, {name}',
      'home.record': '{wins}V · {losses}D',
      'home.playOnline': 'Partida online',
      'home.playBot': 'Partida rápida',
      'home.campaign': 'Campanha',
      'home.ranking': 'Ranking',
      'home.tutorial': 'Como se joga',
      'home.codex': 'Códex das peças',
      'home.logout': 'Sair',
      'home.difficulty': 'Dificuldade da IA',
      'home.audio': 'Som',

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
      'game.pieces': '{count} peças',
      'game.ply': 'Lance {n}',
      'game.resign': 'Desistir',
      'game.resignConfirm': 'Desistir da partida?',
      'game.yes': 'Desistir',
      'game.no': 'Continuar',
      'game.reconnecting': 'Reconectando',
      'game.captured': '{count} capturada(s)',
      'game.siege': 'Cerco fechado',
      'game.coreWarning': 'Seu Núcleo está sem ar',
      'game.portalUsed': 'Portal atravessado',

      'result.victory': 'Vitória',
      'result.defeat': 'Derrota',
      'result.draw': 'Empate',
      'result.rematch': 'Jogar de novo',
      'result.home': 'Voltar ao início',
      'result.next': 'Próxima fase',
      'result.elo': '{elo} Elo',
      'result.stars': '{n} de 3',

      'reason.core': 'Núcleo capturado',
      'reason.territory': 'Território dominado',
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

      'campaign.title': 'Campanha',
      'campaign.subtitle': 'Seis arenas. Cada uma muda o jogo.',
      'campaign.locked': 'Bloqueada',
      'campaign.lockedHint': 'Vença a fase anterior para abrir.',
      'campaign.play': 'Entrar',
      'campaign.replay': 'Jogar de novo',
      'campaign.cleared': 'Concluída',
      'campaign.progress': '{done} de {total} arenas',
      'campaign.unlocked': 'Nova arena liberada: {name}',
      'campaign.allClear': 'Campanha inteira concluída. O tabuleiro é seu.',
      'campaign.phase': 'Fase {n}',
      'campaign.stars': 'Estrelas',

      'arena.classic': 'Arena Clássica',
      'arena.classic.desc': 'Nove por nove, nada escondido. O padrão do online.',
      'arena.limiar': 'O Limiar',
      'arena.limiar.desc': 'Campo aberto. Aprenda a pintar antes de aprender a matar.',
      'arena.fenda': 'A Fenda',
      'arena.fenda.desc': 'Abismos cortam o centro. Rotas viram bens escassos.',
      'arena.pilares': 'Os Pilares',
      'arena.pilares.desc': 'Onze por onze com colunas de pedra. Cerco vira arte.',
      'arena.portais': 'Os Portais',
      'arena.portais.desc': 'Duas fendas gêmeas ligam bordas opostas do mundo.',
      'arena.coroa': 'A Coroa',
      'arena.coroa.desc': 'Treze por treze, cantos cortados, exército completo.',
      'arena.eclipse': 'O Eclipse',
      'arena.eclipse.desc': 'Um anel morto no centro e quatro portais. O teste final.',

      'piece.core': 'Núcleo',
      'piece.core.desc': 'Anda 1 casa em qualquer direção. Não pode ser saltado: só cai por Cerco. Perdeu o Núcleo, perdeu a partida.',
      'piece.sentinel': 'Sentinela',
      'piece.sentinel.desc': 'Anda 1 casa em qualquer direção e salta em todas as 8. Sua peça de combate.',
      'piece.blade': 'Lâmina',
      'piece.blade.desc': 'Desliza até 2 casas em linha reta e pinta tudo por onde passa. Salta apenas na ortogonal.',
      'piece.prism': 'Prisma',
      'piece.prism.desc': 'Desliza até 2 casas na diagonal e, ao parar, acende as 4 diagonais vizinhas. Salta na diagonal.',
      'piece.warden': 'Guardião',
      'piece.warden.desc': 'Anda 1 casa na ortogonal e acende as 4 vizinhas ao parar. Imune a salto, como o Núcleo.',

      'codex.title': 'Códex das peças',
      'codex.subtitle': 'Cinco peças, cinco jeitos de tomar o tabuleiro.',
      'codex.moves': 'Movimento',
      'codex.jump': 'Salto',
      'codex.special': 'Especial',
      'codex.none': 'Nenhum',

      'audio.title': 'Som',
      'audio.music': 'Trilha',
      'audio.sfx': 'Efeitos',
      'audio.on': 'Som ligado',
      'audio.off': 'Som desligado',

      'tutorial.title': 'Como se joga',
      'tutorial.skip': 'Pular',
      'tutorial.next': 'Continuar',
      'tutorial.retry': 'Quase. Tente de novo.',
      'tutorial.done': 'Pronto. O tabuleiro é seu.',
      'tutorial.goal': 'Objetivo',
      'tutorial.chapter': '{n} de {total}',

      'tut.move.title': 'Mover',
      'tut.move.text': 'Toque na Sentinela e depois na casa acesa.',
      'tut.aura.title': 'Aura',
      'tut.aura.text': 'Tudo por onde você passa fica da sua cor. Território é vitória.',
      'tut.blade.title': 'Lâmina',
      'tut.blade.text': 'Deslize 2 casas em linha reta e pinte o rastro inteiro.',
      'tut.prism.title': 'Prisma',
      'tut.prism.text': 'Mova na diagonal. Ao parar, ele acende as 4 diagonais vizinhas.',
      'tut.warden.title': 'Guardião',
      'tut.warden.text': 'Anda pouco, pinta muito: acende as 4 casas ortogonais ao parar.',
      'tut.portal.title': 'Portal',
      'tut.portal.text': 'Quem está sobre um portal atravessa para a casa gêmea.',
      'tut.jump.title': 'Salto',
      'tut.jump.text': 'Pule por cima da peça inimiga para capturá-la.',
      'tut.chain.title': 'Salto encadeado',
      'tut.chain.text': 'Se ainda dá para saltar, você é obrigado a continuar.',
      'tut.siege.title': 'Cerco',
      'tut.siege.text': 'Tire a última respiração do grupo inimigo e ele cai inteiro.',
      'tut.immune.title': 'Núcleo imune',
      'tut.immune.text': 'O Núcleo não pode ser saltado. Sufoque-o com Aura.',

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
      'common.bot': 'IA',
      'common.locked': 'Bloqueado'
    },

    /* ====================== English ====================== */
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
      'auth.offlineHint': 'Campaign and AI matches, no ranking.',

      'home.greeting': 'Hi, {name}',
      'home.record': '{wins}W · {losses}L',
      'home.playOnline': 'Online match',
      'home.playBot': 'Quick match',
      'home.campaign': 'Campaign',
      'home.ranking': 'Ranking',
      'home.tutorial': 'How to play',
      'home.codex': 'Piece codex',
      'home.logout': 'Sign out',
      'home.difficulty': 'AI difficulty',
      'home.audio': 'Sound',

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
      'game.pieces': '{count} pieces',
      'game.ply': 'Move {n}',
      'game.resign': 'Resign',
      'game.resignConfirm': 'Resign this match?',
      'game.yes': 'Resign',
      'game.no': 'Keep playing',
      'game.reconnecting': 'Reconnecting',
      'game.captured': '{count} captured',
      'game.siege': 'Siege closed',
      'game.coreWarning': 'Your Core is out of air',
      'game.portalUsed': 'Portal crossed',

      'result.victory': 'Victory',
      'result.defeat': 'Defeat',
      'result.draw': 'Draw',
      'result.rematch': 'Play again',
      'result.home': 'Back home',
      'result.next': 'Next arena',
      'result.elo': '{elo} Elo',
      'result.stars': '{n} of 3',

      'reason.core': 'Core captured',
      'reason.territory': 'Territory dominated',
      'reason.stalemate': 'No legal moves left',
      'reason.resign': 'Resignation',
      'reason.timeout': 'Time ran out',
      'reason.double_core': 'Both Cores fell',
      'reason.adjudication': 'Decided on territory',

      'rank.title': 'Ranking',
      'rank.empty': 'Nobody has scored yet. Be the first.',
      'rank.elo': 'Elo',
      'rank.player': 'Player',

      'division.iron': 'Iron',
      'division.bronze': 'Bronze',
      'division.silver': 'Silver',
      'division.gold': 'Gold',
      'division.grandmaster': 'Grandmaster',

      'campaign.title': 'Campaign',
      'campaign.subtitle': 'Six arenas. Each one changes the game.',
      'campaign.locked': 'Locked',
      'campaign.lockedHint': 'Win the previous arena to open it.',
      'campaign.play': 'Enter',
      'campaign.replay': 'Play again',
      'campaign.cleared': 'Cleared',
      'campaign.progress': '{done} of {total} arenas',
      'campaign.unlocked': 'New arena unlocked: {name}',
      'campaign.allClear': 'Whole campaign cleared. The board is yours.',
      'campaign.phase': 'Arena {n}',
      'campaign.stars': 'Stars',

      'arena.classic': 'Classic Arena',
      'arena.classic.desc': 'Nine by nine, nothing hidden. The online standard.',
      'arena.limiar': 'The Threshold',
      'arena.limiar.desc': 'Open field. Learn to paint before you learn to kill.',
      'arena.fenda': 'The Rift',
      'arena.fenda.desc': 'Chasms cut the centre. Routes become scarce goods.',
      'arena.pilares': 'The Pillars',
      'arena.pilares.desc': 'Eleven by eleven with stone columns. Siege becomes art.',
      'arena.portais': 'The Portals',
      'arena.portais.desc': 'Two twin rifts link opposite edges of the world.',
      'arena.coroa': 'The Crown',
      'arena.coroa.desc': 'Thirteen by thirteen, cut corners, full army.',
      'arena.eclipse': 'The Eclipse',
      'arena.eclipse.desc': 'A dead ring at the centre and four portals. The final test.',

      'piece.core': 'Core',
      'piece.core.desc': 'Steps 1 square in any direction. Cannot be jumped: only a Siege takes it. Lose the Core, lose the match.',
      'piece.sentinel': 'Sentinel',
      'piece.sentinel.desc': 'Steps 1 square in any direction and jumps in all 8. Your fighting piece.',
      'piece.blade': 'Blade',
      'piece.blade.desc': 'Slides up to 2 squares in a straight line, painting everything it crosses. Jumps orthogonally only.',
      'piece.prism': 'Prism',
      'piece.prism.desc': 'Slides up to 2 squares diagonally and, on landing, lights the 4 diagonal neighbours. Jumps diagonally.',
      'piece.warden': 'Warden',
      'piece.warden.desc': 'Steps 1 square orthogonally and lights the 4 neighbours on landing. Immune to jumps, like the Core.',

      'codex.title': 'Piece codex',
      'codex.subtitle': 'Five pieces, five ways to take the board.',
      'codex.moves': 'Movement',
      'codex.jump': 'Jump',
      'codex.special': 'Special',
      'codex.none': 'None',

      'audio.title': 'Sound',
      'audio.music': 'Music',
      'audio.sfx': 'Effects',
      'audio.on': 'Sound on',
      'audio.off': 'Sound off',

      'tutorial.title': 'How to play',
      'tutorial.skip': 'Skip',
      'tutorial.next': 'Continue',
      'tutorial.retry': 'Almost. Try again.',
      'tutorial.done': 'Done. The board is yours.',
      'tutorial.goal': 'Goal',
      'tutorial.chapter': '{n} of {total}',

      'tut.move.title': 'Move',
      'tut.move.text': 'Tap the Sentinel, then tap the lit square.',
      'tut.aura.title': 'Aura',
      'tut.aura.text': 'Everything you cross turns your colour. Territory is victory.',
      'tut.blade.title': 'Blade',
      'tut.blade.text': 'Slide 2 squares in a straight line and paint the whole trail.',
      'tut.prism.title': 'Prism',
      'tut.prism.text': 'Move diagonally. On landing it lights the 4 diagonal neighbours.',
      'tut.warden.title': 'Warden',
      'tut.warden.text': 'Walks little, paints a lot: it lights the 4 orthogonal squares on landing.',
      'tut.portal.title': 'Portal',
      'tut.portal.text': 'A piece standing on a portal crosses to its twin square.',
      'tut.jump.title': 'Jump',
      'tut.jump.text': 'Leap over the enemy piece to capture it.',
      'tut.chain.title': 'Chain jump',
      'tut.chain.text': 'If another jump is available, you must keep going.',
      'tut.siege.title': 'Siege',
      'tut.siege.text': 'Take the last breath of the enemy group and it falls whole.',
      'tut.immune.title': 'Immune Core',
      'tut.immune.text': 'The Core cannot be jumped. Smother it with Aura.',

      'error.NETWORK': 'No connection to the server.',
      'error.TIMEOUT': 'The server took too long.',
      'error.BAD_CREDENTIALS': 'Wrong name or password.',
      'error.USERNAME_TAKEN': 'That name is taken.',
      'error.USERNAME_SHORT': 'Use at least 3 characters.',
      'error.USERNAME_INVALID': 'Use letters, numbers, dot, hyphen or _.',
      'error.PASSWORD_SHORT': 'Password needs 4 characters.',
      'error.NOT_YOUR_TURN': 'Not your turn.',
      'error.ILLEGAL_MOVE': 'Move not allowed.',
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
      'common.bot': 'AI',
      'common.locked': 'Locked'
    },

    /* ====================== Español ====================== */
    es: {
      'app.tagline': 'Domina el tablero. Domina la luz.',
      'app.loading': 'Encendiendo el aura',

      'auth.welcome': 'Entra para jugar',
      'auth.username': 'Nombre de jugador',
      'auth.password': 'Contraseña',
      'auth.login': 'Entrar',
      'auth.register': 'Crear cuenta',
      'auth.switchToRegister': '¿No tienes cuenta? Crea una',
      'auth.switchToLogin': 'Ya tengo cuenta',
      'auth.offline': 'Jugar sin cuenta',
      'auth.offlineHint': 'Campaña y partidas contra la IA, sin ranking.',

      'home.greeting': 'Hola, {name}',
      'home.record': '{wins}V · {losses}D',
      'home.playOnline': 'Partida en línea',
      'home.playBot': 'Partida rápida',
      'home.campaign': 'Campaña',
      'home.ranking': 'Ranking',
      'home.tutorial': 'Cómo se juega',
      'home.codex': 'Códice de piezas',
      'home.logout': 'Salir',
      'home.difficulty': 'Dificultad de la IA',
      'home.audio': 'Sonido',

      'level.novice': 'Principiante',
      'level.adept': 'Adepto',
      'level.master': 'Maestro',

      'queue.searching': 'Buscando oponente',
      'queue.elapsed': '{time} en la cola',
      'queue.inQueue': '{count} en la cola',
      'queue.botIn': 'La IA entra en {seconds}s',
      'queue.startingBot': 'No hay nadie cerca. Llamando a la IA.',
      'queue.cancel': 'Cancelar búsqueda',
      'queue.matched': 'Oponente encontrado',

      'game.yourTurn': 'Tu turno',
      'game.opponentTurn': 'Turno de {name}',
      'game.thinking': '{name} está pensando',
      'game.territory': 'Territorio',
      'game.pieces': '{count} piezas',
      'game.ply': 'Jugada {n}',
      'game.resign': 'Rendirse',
      'game.resignConfirm': '¿Rendirse en esta partida?',
      'game.yes': 'Rendirse',
      'game.no': 'Seguir jugando',
      'game.reconnecting': 'Reconectando',
      'game.captured': '{count} capturada(s)',
      'game.siege': 'Cerco cerrado',
      'game.coreWarning': 'Tu Núcleo se queda sin aire',
      'game.portalUsed': 'Portal atravesado',

      'result.victory': 'Victoria',
      'result.defeat': 'Derrota',
      'result.draw': 'Empate',
      'result.rematch': 'Jugar otra vez',
      'result.home': 'Volver al inicio',
      'result.next': 'Siguiente arena',
      'result.elo': '{elo} Elo',
      'result.stars': '{n} de 3',

      'reason.core': 'Núcleo capturado',
      'reason.territory': 'Territorio dominado',
      'reason.stalemate': 'Sin movimientos posibles',
      'reason.resign': 'Rendición',
      'reason.timeout': 'Tiempo agotado',
      'reason.double_core': 'Cayeron los dos Núcleos',
      'reason.adjudication': 'Decidido por territorio',

      'rank.title': 'Ranking',
      'rank.empty': 'Nadie ha puntuado aún. Sé el primero.',
      'rank.elo': 'Elo',
      'rank.player': 'Jugador',

      'division.iron': 'Hierro',
      'division.bronze': 'Bronce',
      'division.silver': 'Plata',
      'division.gold': 'Oro',
      'division.grandmaster': 'Gran Maestro',

      'campaign.title': 'Campaña',
      'campaign.subtitle': 'Seis arenas. Cada una cambia el juego.',
      'campaign.locked': 'Bloqueada',
      'campaign.lockedHint': 'Gana la arena anterior para abrirla.',
      'campaign.play': 'Entrar',
      'campaign.replay': 'Jugar otra vez',
      'campaign.cleared': 'Completada',
      'campaign.progress': '{done} de {total} arenas',
      'campaign.unlocked': 'Nueva arena desbloqueada: {name}',
      'campaign.allClear': 'Campaña completa. El tablero es tuyo.',
      'campaign.phase': 'Arena {n}',
      'campaign.stars': 'Estrellas',

      'arena.classic': 'Arena Clásica',
      'arena.classic.desc': 'Nueve por nueve, nada oculto. El estándar en línea.',
      'arena.limiar': 'El Umbral',
      'arena.limiar.desc': 'Campo abierto. Aprende a pintar antes de aprender a matar.',
      'arena.fenda': 'La Grieta',
      'arena.fenda.desc': 'Abismos parten el centro. Las rutas se vuelven escasas.',
      'arena.pilares': 'Los Pilares',
      'arena.pilares.desc': 'Once por once con columnas de piedra. El cerco se vuelve arte.',
      'arena.portais': 'Los Portales',
      'arena.portais.desc': 'Dos grietas gemelas unen bordes opuestos del mundo.',
      'arena.coroa': 'La Corona',
      'arena.coroa.desc': 'Trece por trece, esquinas cortadas, ejército completo.',
      'arena.eclipse': 'El Eclipse',
      'arena.eclipse.desc': 'Un anillo muerto en el centro y cuatro portales. La prueba final.',

      'piece.core': 'Núcleo',
      'piece.core.desc': 'Avanza 1 casilla en cualquier dirección. No puede ser saltado: solo cae por Cerco. Si lo pierdes, pierdes la partida.',
      'piece.sentinel': 'Centinela',
      'piece.sentinel.desc': 'Avanza 1 casilla en cualquier dirección y salta en las 8. Tu pieza de combate.',
      'piece.blade': 'Hoja',
      'piece.blade.desc': 'Se desliza hasta 2 casillas en línea recta y pinta todo lo que cruza. Salta solo en ortogonal.',
      'piece.prism': 'Prisma',
      'piece.prism.desc': 'Se desliza hasta 2 casillas en diagonal y, al parar, enciende las 4 diagonales vecinas. Salta en diagonal.',
      'piece.warden': 'Guardián',
      'piece.warden.desc': 'Avanza 1 casilla en ortogonal y enciende las 4 vecinas al parar. Inmune al salto, como el Núcleo.',

      'codex.title': 'Códice de piezas',
      'codex.subtitle': 'Cinco piezas, cinco formas de tomar el tablero.',
      'codex.moves': 'Movimiento',
      'codex.jump': 'Salto',
      'codex.special': 'Especial',
      'codex.none': 'Ninguno',

      'audio.title': 'Sonido',
      'audio.music': 'Música',
      'audio.sfx': 'Efectos',
      'audio.on': 'Sonido activado',
      'audio.off': 'Sonido desactivado',

      'tutorial.title': 'Cómo se juega',
      'tutorial.skip': 'Saltar',
      'tutorial.next': 'Continuar',
      'tutorial.retry': 'Casi. Inténtalo otra vez.',
      'tutorial.done': 'Listo. El tablero es tuyo.',
      'tutorial.goal': 'Objetivo',
      'tutorial.chapter': '{n} de {total}',

      'tut.move.title': 'Mover',
      'tut.move.text': 'Toca el Centinela y luego la casilla encendida.',
      'tut.aura.title': 'Aura',
      'tut.aura.text': 'Todo lo que cruzas toma tu color. El territorio es la victoria.',
      'tut.blade.title': 'Hoja',
      'tut.blade.text': 'Deslízate 2 casillas en línea recta y pinta todo el rastro.',
      'tut.prism.title': 'Prisma',
      'tut.prism.text': 'Muévete en diagonal. Al parar enciende las 4 diagonales vecinas.',
      'tut.warden.title': 'Guardián',
      'tut.warden.text': 'Camina poco y pinta mucho: enciende las 4 casillas ortogonales al parar.',
      'tut.portal.title': 'Portal',
      'tut.portal.text': 'Quien está sobre un portal cruza a su casilla gemela.',
      'tut.jump.title': 'Salto',
      'tut.jump.text': 'Salta por encima de la pieza enemiga para capturarla.',
      'tut.chain.title': 'Salto encadenado',
      'tut.chain.text': 'Si aún puedes saltar, estás obligado a seguir.',
      'tut.siege.title': 'Cerco',
      'tut.siege.text': 'Quita el último respiro del grupo enemigo y cae entero.',
      'tut.immune.title': 'Núcleo inmune',
      'tut.immune.text': 'El Núcleo no puede ser saltado. Asfíxialo con Aura.',

      'error.NETWORK': 'Sin conexión con el servidor.',
      'error.TIMEOUT': 'El servidor tardó demasiado.',
      'error.BAD_CREDENTIALS': 'Nombre o contraseña incorrectos.',
      'error.USERNAME_TAKEN': 'Ese nombre ya existe.',
      'error.USERNAME_SHORT': 'Usa al menos 3 caracteres.',
      'error.USERNAME_INVALID': 'Usa letras, números, punto, guion o _.',
      'error.PASSWORD_SHORT': 'La contraseña necesita 4 caracteres.',
      'error.NOT_YOUR_TURN': 'No es tu turno.',
      'error.ILLEGAL_MOVE': 'Jugada no permitida.',
      'error.STALE_STATE': 'Sincronizando el tablero.',
      'error.MATCH_NOT_FOUND': 'Partida no encontrada.',
      'error.EXPIRED_TOKEN': 'Sesión expirada. Entra de nuevo.',
      'error.BAD_TOKEN': 'Sesión inválida. Entra de nuevo.',
      'error.SERVER_BUSY': 'Servidor ocupado. Reintentando.',
      'error.UNKNOWN': 'Algo salió mal.',

      'common.back': 'Volver',
      'common.close': 'Cerrar',
      'common.language': 'Idioma',
      'common.you': 'Tú',
      'common.bot': 'IA',
      'common.locked': 'Bloqueado'
    }
  };

  const SUPPORTED = ['pt', 'en', 'es'];
  const FALLBACK = 'pt';

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
          const parts = pair.split(':').map(s => s && s.trim());
          if (parts[0] && parts[1]) node.setAttribute(parts[0], this.t(parts[1]));
        });
      });
    }

    get supported() { return SUPPORTED.slice(); }
  }

  root.AuraI18n = new I18n();
  root.AuraI18n.DICTIONARIES = DICTIONARIES;
})(typeof self !== 'undefined' ? self : this);
