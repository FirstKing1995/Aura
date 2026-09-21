/**
 * AURA — Bootstrap.
 * Monta o grafo de dependências na ordem correta e entrega o controle ao
 * GameController. Erros de inicialização são visíveis, nunca silenciosos.
 */
(function (root) {
  'use strict';

  function fail(message) {
    document.body.innerHTML =
      '<div class="fatal"><h1>Aura</h1><p>' + message + '</p></div>';
  }

  function start() {
    const required = ['AURA_CONFIG', 'AuraUtils', 'AuraArenas', 'AuraRules', 'AuraI18n',
                      'AuraAudio', 'AuraApi', 'AuraNet', 'AuraAI', 'AuraBot', 'AuraUI',
                      'AuraTutorial', 'AuraGame'];
    const missing = required.filter(k => !root[k]);
    if (missing.length) return fail('Módulos ausentes: ' + missing.join(', '));

    // Falha alto se alguma arena estiver mal descrita: melhor uma tela de erro
    // clara agora do que um tabuleiro sutilmente injusto depois.
    try {
      root.AuraArenas.ALL.forEach(def => root.AuraRules.buildArena(def));
    } catch (err) {
      return fail('Arena inválida: ' + err.message);
    }

    const bus = new root.AuraUtils.EventBus();
    root.AuraI18n.init();

    const ui = new root.AuraUI.UIManager(bus).mount();
    new root.AuraNet.ConnectionMonitor(bus);

    const game = new root.AuraGame.GameController(ui, bus);
    root.__aura = { bus, ui, game, audio: root.AuraAudio };   // superfície de depuração

    // Altura real da viewport no mobile (barra de endereço dinâmica).
    const setVh = () => {
      document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
    };
    setVh();
    window.addEventListener('resize', setVh);
    window.addEventListener('orientationchange', () => setTimeout(setVh, 120));

    // Evita o zoom por duplo toque sobre o tabuleiro.
    document.addEventListener('dblclick', e => {
      if (e.target.closest('.board')) e.preventDefault();
    }, { passive: false });

    game.boot().catch(err => {
      console.error('[boot]', err);
      ui.toast(root.AuraI18n.error(err && err.code), 'bad');
      ui.showScreen('auth');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
