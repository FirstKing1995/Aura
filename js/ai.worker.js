/**
 * AURA — Web Worker da IA.
 * Mantém a busca Negamax fora da thread principal para que o tabuleiro,
 * as animações CSS, o áudio e o polling continuem fluidos durante o
 * "pensamento" da máquina.
 *
 * Protocolo:
 *   main -> worker : { type:'think', id, state, player, options }
 *   worker -> main : { type:'ready' | 'result' | 'error', id, ... }
 *
 * O estado cruza a fronteira SERIALIZADO (string compacta), nunca como
 * objeto vivo: Int8Array e a arena compilada não sobrevivem ao structured
 * clone de forma confiável entre navegadores antigos.
 */
/* eslint-env worker */
'use strict';

importScripts('config.js', 'arenas.js', 'rules.js', 'ai.js');

self.onmessage = function (e) {
  const msg = e.data || {};

  if (msg.type === 'ping') {
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type !== 'think') return;

  try {
    const state = self.AuraRules.deserialize(msg.state);
    const result = self.AuraAI.think(state, msg.player, msg.options || {});
    self.postMessage({
      type: 'result',
      id: msg.id,
      move: result.move,
      stats: { score: result.score, depth: result.depth, nodes: result.nodes, ms: result.ms }
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: (err && err.message) || String(err)
    });
  }
};

self.postMessage({ type: 'ready' });
