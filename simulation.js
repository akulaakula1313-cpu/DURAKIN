/**
 * Симуляция для баланса ботов: кто чаще остаётся дураком.
 * Запуск: npm run simulate [количество партий]
 */
const S = require('../server.js');
S.setIO({ to: () => ({ emit: () => {} }) });

const GAMES = parseInt(process.argv[2]) || 500;

function makeRoom(difficulties) {
  const room = {
    id: 'S' + Math.random().toString(36).slice(2, 8),
    maxPlayers: difficulties.length,
    players: difficulties.map((d, i) => ({
      pid: 'P' + i, sid: null, isBot: true,
      name: `${d}#${i}`, botDifficulty: d
    })),
    state: null, rematchVotes: new Set(),
    rematchTimer: null, botLoopTimeout: null, graceTimer: null
  };
  S.initGameState(room);
  return room;
}

function run(difficulties, games) {
  const losses = {}, stats = { draws: 0, steps: 0 };
  difficulties.forEach((d, i) => { losses['P' + i] = 0; });
  for (let g = 0; g < games; g++) {
    const room = makeRoom(difficulties);
    let steps = 0;
    while (!room.state.isGameOver && steps < 20000) { S.executeBotTurnChain(room); steps++; }
    stats.steps += steps;
    if (room.state.loser === null) stats.draws++;
    else losses[room.state.loser]++;
  }
  const line = difficulties.map((d, i) =>
    `${d}: ${(losses['P' + i] / games * 100).toFixed(1)}% поражений`).join('  |  ');
  console.log(`  ${difficulties.length} игрока → ${line}`);
  console.log(`     ничьих ${(stats.draws / games * 100).toFixed(1)}%, ` +
    `в среднем ${(stats.steps / games).toFixed(0)} ходов на партию`);
}

console.log(`\nСимуляция: ${GAMES} партий на конфигурацию\n`);
run(['easy', 'hard'], GAMES);
run(['normal', 'hard'], GAMES);
run(['easy', 'normal'], GAMES);
run(['easy', 'normal', 'hard'], GAMES);
run(['easy', 'easy', 'hard', 'hard'], GAMES);
console.log('');
