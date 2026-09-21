/**
 * ============================================================================
 *  AURA — Arenas (dados declarativos)
 * ============================================================================
 *  Cada arena é descrita por uma GRADE de texto, uma linha por fileira. Isso
 *  mantém o layout legível: dá para "ver" o tabuleiro lendo o código.
 *
 *  Alfabeto da grade
 *  -----------------
 *    .            casa livre
 *    #            casa BLOQUEADA (abismo: ninguém pisa, ninguém pinta,
 *                 não conta no território)
 *    1 2 3 4      PORTAL — cada dígito precisa aparecer exatamente 2x; as duas
 *                 casas ficam ligadas (passo e cerco atravessam)
 *    K S L P G    peça do jogador A — Núcleo, Sentinela, Lâmina, Prisma, Guardião
 *
 *  O exército de B NÃO é escrito: ele é gerado por rotação de 180° do exército
 *  de A. Por isso bloqueios e portais precisam ser simétricos em relação ao
 *  centro — `AuraRules.buildArena()` valida isso e falha alto se não for.
 *
 *  Este arquivo é puro dado: nenhuma dependência, nenhuma regra. É carregado
 *  antes de rules.js (e dentro do Web Worker e do Apps Script).
 * ============================================================================
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Arena canônica — usada em TODA partida online e no jogo rápido.     */
  /* O backend valida contra ela; não mude sem mudar o servidor junto.   */
  /* ------------------------------------------------------------------ */
  const CLASSIC = {
    id: 'classic',
    N: 9,
    maxPlies: 300,
    territoryRatio: 0.70,
    grid: [
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.PSS.SSP.',
      'GSSLKLSSG'
    ]
  };

  /* ------------------------------------------------------------------ */
  /* Campanha — 6 fases, dificuldade e geometria crescentes.             */
  /* ------------------------------------------------------------------ */
  const PHASES = [
    {
      id: 'limiar',
      order: 1,
      N: 9,
      level: 'novice',
      maxPlies: 300,
      territoryRatio: 0.70,
      teaches: ['sentinel', 'blade'],
      grid: [
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '..SS.SS..',
        '.SSLKLSS.'
      ]
    },

    {
      id: 'fenda',
      order: 2,
      N: 9,
      level: 'novice',
      maxPlies: 320,
      territoryRatio: 0.68,
      teaches: ['prism', 'blocked'],
      grid: [
        '.........',
        '.........',
        '....#....',
        '.#.....#.',
        '....#....',
        '.#.....#.',
        '....#....',
        '.PSS.SSP.',
        '.SSLKLSS.'
      ]
    },

    {
      id: 'pilares',
      order: 3,
      N: 11,
      level: 'adept',
      maxPlies: 400,
      territoryRatio: 0.68,
      teaches: ['warden', 'siege'],
      grid: [
        '...........',
        '...........',
        '..#.....#..',
        '...........',
        '.....#.....',
        '....#.#....',
        '.....#.....',
        '...........',
        '..#.....#..',
        '..PSS.SSP..',
        'GSSLSKSLSSG'
      ]
    },

    {
      id: 'portais',
      order: 4,
      N: 11,
      level: 'adept',
      maxPlies: 420,
      territoryRatio: 0.66,
      teaches: ['portal'],
      grid: [
        '...........',
        '...........',
        '...........',
        '1.........2',
        '....###....',
        '...........',
        '....###....',
        '2.........1',
        '...........',
        '..PSS.SSP..',
        'GSSLSKSLSSG'
      ]
    },

    {
      id: 'coroa',
      order: 5,
      N: 13,
      level: 'master',
      maxPlies: 500,
      territoryRatio: 0.64,
      teaches: ['fullArmy'],
      grid: [
        '##.........##',
        '#...........#',
        '.............',
        '.............',
        '.............',
        '.............',
        '......#......',
        '.............',
        '.............',
        '.............',
        '....S...S....',
        '#.GPSS.SSPG.#',
        '##SLSSKSSLS##'
      ]
    },

    {
      id: 'eclipse',
      order: 6,
      N: 13,
      level: 'master',
      maxPlies: 520,
      territoryRatio: 0.62,
      teaches: ['everything'],
      grid: [
        '.............',
        '.............',
        '.............',
        '1...........2',
        '....#####....',
        '....#...#....',
        '....#...#....',
        '....#...#....',
        '....#####....',
        '2...........1',
        '....S...S....',
        '..GPSS.SSPG..',
        '..SLSSKSSLS..'
      ]
    }
  ];

  const ALL = [CLASSIC].concat(PHASES);

  root.AuraArenas = {
    CLASSIC_ID: 'classic',
    CLASSIC,
    PHASES,
    ALL,
    byId(id) {
      for (let i = 0; i < ALL.length; i++) if (ALL[i].id === id) return ALL[i];
      return CLASSIC;
    },
    phaseAt(order) {
      for (let i = 0; i < PHASES.length; i++) if (PHASES[i].order === order) return PHASES[i];
      return null;
    }
  };
})(typeof self !== 'undefined' ? self : this);
