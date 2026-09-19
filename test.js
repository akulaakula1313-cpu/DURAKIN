const assert = require('node:assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'express') {
    const express = () => ({ use(){}, get(){} });
    express.static = () => () => {};
    return express;
  }
  if (request === 'socket.io') return { Server: class {} };
  return originalLoad(request, parent, isMain);
};

const game = require('./server.js');
const emitted = [];
game.setIO({ to(id) { return { emit(event, data) { emitted.push({ id, event, data }); } }; } });

function makeRoom(count, bots = false) {
  return {
    id: 'TEST_' + count,
    maxPlayers: count,
    players: Array.from({length: count}, (_, i) => ({
      id: 'P' + i,
      isBot: bots,
      name: bots ? 'Bot ' + i : 'Player ' + i,
      botDifficulty: 'normal'
    })),
    state: null,
    rematchVotes: new Set(),
    rematchTimer: null,
    botLoopTimeout: null
  };
}

function allCards(room) {
  const s = room.state;
  return [
    ...Object.values(s.hands).flat(),
    ...s.deck,
    ...s.table.flatMap(p => [p.attack, p.defense].filter(Boolean))
  ];
}

function assertIntegrity(room) {
  const cards = allCards(room);
  assert.ok(cards.length <= 36 && cards.length >= 0, 'active card count must stay within 0..36');
  assert.equal(new Set(cards.map(c => c.id)).size, cards.length, 'active card ids must stay unique');
  for (const c of cards) {
    assert.ok(game.SUITS.includes(c.suit), 'invalid suit');
    assert.ok(game.RANKS.some(r => r.rank === c.rank && r.value === c.value), 'invalid rank');
  }
}

function testInitialization() {
  for (const count of [2, 3, 4]) {
    for (let i = 0; i < 100; i++) {
      const room = makeRoom(count);
      game.initGameState(room);
      const s = room.state;
      assert.equal(s.deck.length, 36 - count * 6);
      assert.ok(s.trumpCard);
      assert.equal(new Set(Object.values(s.hands).flat().map(c => c.id)).size, count * 6);
      for (const h of Object.values(s.hands)) assert.equal(h.length, 6);
      assertIntegrity(room);
    }
  }
}

function testTakeRotation() {
  const room = makeRoom(2);
  game.initGameState(room);
  const s = room.state;
  const oldAttacker = s.attackerIdx;
  const oldDefender = s.defenderIdx;
  const attackerId = s.playersInfo[oldAttacker].id;
  const defenderId = s.playersInfo[oldDefender].id;
  const attack = s.hands[attackerId][0];
  assert.equal(game.handlePlayCard(room, attackerId, attack.id), true);
  assert.equal(game.handleTake(room, defenderId), true);
  // If nobody can throw after TAKE, handleTake finalizes immediately.
  // Otherwise finish the pending TAKE explicitly for this unit test.
  if (s.pendingTake) {
    s.currentThrowerIdx = s.playersInfo.findIndex(p => p.id !== defenderId);
    game.handlePass(room, s.playersInfo[s.currentThrowerIdx].id);
  }
  assert.equal(s.attackerIdx, oldDefender, 'player who took must attack next');
  assert.equal(s.defenderIdx, oldAttacker, 'previous attacker must defend next');
  assert.equal(s.currentThrowerIdx, oldDefender);
  assertIntegrity(room);
}

function testPassCannotLoop() {
  const room = makeRoom(3);
  game.initGameState(room);
  const s = room.state;
  const a = s.playersInfo[s.attackerIdx].id;
  const d = s.playersInfo[s.defenderIdx].id;
  assert.equal(game.handlePlayCard(room, a, s.hands[a][0].id), true);
  const defenderCard = s.hands[d].find(c => game.canBeat(s.table[0].attack, c, s.trumpSuit));
  if (!defenderCard) return; // rare but valid; other tests cover take.
  assert.equal(game.handlePlayCard(room, d, defenderCard.id), true);
  // The current thrower ends the attack when nobody else has a matching rank.
  // Find a player with no matching rank and pass; if none exists, the server's
  // normal DONE path remains the valid route.
  const ranks = game.getTableRanks(s.table);
  const throwerIdx = s.currentThrowerIdx;
  const candidate = s.playersInfo.findIndex((p, idx) =>
    idx !== s.defenderIdx && idx !== throwerIdx &&
    !(s.hands[p.id] || []).some(c => ranks.has(c.rank))
  );
  if (candidate >= 0) {
    s.currentThrowerIdx = candidate;
    const before = s.currentThrowerIdx;
    game.handlePass(room, s.playersInfo[candidate].id);
    assert.notEqual(s.currentThrowerIdx, before, 'PASS must not leave the same player in an endless loop');
  }
  assertIntegrity(room);
}

function testBotSimulation() {
  for (const count of [2, 3, 4]) {
    for (const difficulty of ['easy', 'normal', 'hard']) {
      const room = makeRoom(count, true);
      room.players.forEach(p => p.botDifficulty = difficulty);
      game.initGameState(room);
      let steps = 0;
      while (!room.state.isGameOver && steps < 5000) {
        const acted = game.executeBotTurnChain(room);
        assert.ok(acted || room.state.isGameOver, `bot loop stalled: ${count} players / ${difficulty}`);
        assertIntegrity(room);
        steps++;
      }
      if (room.rematchTimer) clearInterval(room.rematchTimer);
      assert.ok(room.state.isGameOver, `bot game did not finish: ${count} / ${difficulty}`);
      assert.ok(steps < 5000, `bot game exceeded safety limit: ${count} / ${difficulty}`);
    }
  }
}

function main() {
  testInitialization();
  testTakeRotation();
  testPassCannotLoop();
  testBotSimulation();
  console.log('SANI GROUP Durak: all logic tests passed.');
}

main();
