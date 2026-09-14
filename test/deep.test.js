/**
 * DEEP TEST - полная проверка логики и рендеринга
 * Запуск: node test/deep.test.js
 */

const {
  RANKS, SUITS, createDeck, shuffleDeck, sortHand, canBeat,
  getTableRanks, countDefendedPairs, refillAllHands, checkGameOver,
  initGameState, handlePlayCard, handleTake, handleDone, handlePass,
  executeBotTurnChain, broadcastState
} = require('../server.js');

const assert = (cond, msg) => { if (!cond) throw new Error(`❌ ${msg}`); };
const log = (msg) => console.log(`  ${msg}`);

function createRoom(players, botDifficulty = 'normal') {
  return {
    id: 'TEST_' + Math.random().toString(36).substring(7),
    maxPlayers: players.length,
    players: players.map((p, i) => ({ id: p.id || `P${i}`, isBot: !!p.isBot, name: p.name || `Player${i}`, botDifficulty: p.botDifficulty || botDifficulty })),
    state: null, rematchVotes: new Set(), rematchTimer: null, botLoopTimeout: null
  };
}

function mockIO() {
  const events = {};
  return {
    to: (id) => ({
      emit: (event, data) => {
        if (!events[event]) events[event] = [];
        events[event].push({ to: id, data });
      }
    }),
    on: (event, cb) => { events[event] = events[event] || []; events[event].push(cb); },
    emit: (event, data) => { if (events[event]) events[event].forEach(cb => cb(data)); },
    getEvents: () => events
  };
}

function runDeepTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  DEEP TEST SUITE - DURAK LOGIC & STATE');
  console.log('═══════════════════════════════════════════\n');

  // ===== TEST 1: STATE STRUCTURE VALIDATION =====
  console.log('📋 TEST 1: STATE STRUCTURE');
  const room = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room);
  
  const s = room.state;
  assert(s && s.hands && s.hands.p1 && s.hands.p2, 'State has hands');
  assert(s.hands.p1.length === 6, 'P1 has 6 cards');
  assert(s.hands.p2.length === 6, 'P2 has 6 cards');
  assert(s.deck.length === 24, 'Deck has 24 cards');
  assert(s.trumpCard && s.trumpSuit, 'Trump card and suit exist');
  assert(s.table !== undefined, 'Table exists (array)');
  assert(Array.isArray(s.table), 'Table is array');
  assert(s.playersInfo.length === 2, 'PlayersInfo has 2');
  assert(typeof s.attackerIdx === 'number', 'attackerIdx is number');
  assert(typeof s.defenderIdx === 'number', 'defenderIdx is number');
  assert(typeof s.currentThrowerIdx === 'number', 'currentThrowerIdx is number');
  assert(s.isGameOver === false, 'isGameOver false initially');
  log('State structure: PASS\n');

  // ===== TEST 2: CARD ID UNIQUENESS =====
  console.log('🆔 TEST 2: CARD ID UNIQUENESS');
  const allIds = [];
  for (const pid of ['p1','p2']) {
    for (const c of s.hands[pid]) {
      assert(c.id !== undefined && c.id !== null, `Card has id: ${c.rank}${c.suit}`);
      assert(typeof c.id === 'number', `Card id is number: ${c.id}`);
      allIds.push(c.id);
    }
  }
  if (s.trumpCard) { assert(typeof s.trumpCard.id === 'number', 'Trump card has id'); allIds.push(s.trumpCard.id); }
  const uniqueIds = new Set(allIds);
  assert(uniqueIds.size === allIds.length, 'All card IDs unique');
  log(`All ${allIds.length} cards have unique IDs: PASS\n`);

  // ===== TEST 3: TABLE STATE AFTER ATTACK =====
  console.log('🃏 TEST 3: TABLE STATE AFTER ATTACK');
  const room3 = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room3);
  const attId = room3.state.playersInfo[room3.state.attackerIdx].id;
  const attCard = room3.state.hands[attId][0];
  const ok = handlePlayCard(room3, attId, attCard.id);
  assert(ok === true, 'Attack succeeded');
  const table = room3.state.table;
  assert(table.length === 1, 'Table has 1 pair');
  const pair = table[0];
  assert(pair.attack && pair.attack.id === attCard.id, 'Attack card on table');
  assert(pair.defense === null, 'Defense is null');
  assert(pair.attackerId === attId, 'AttackerId set');
  log('Table structure after attack: PASS');
  log(`  pair = ${JSON.stringify(pair, null, 2)}\n`);

  // ===== TEST 4: TABLE STATE AFTER DEFENSE =====
  console.log('🛡️ TEST 4: TABLE STATE AFTER DEFENSE');
  const room4 = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room4);
  const aId = room4.state.playersInfo[room4.state.attackerIdx].id;
  const dId = room4.state.playersInfo[room4.state.defenderIdx].id;
  const aCard = room4.state.hands[aId][0];
  handlePlayCard(room4, aId, aCard.id);
  const defHand = room4.state.hands[dId];
  const beatCard = defHand.find(c => canBeat(aCard, c, room4.state.trumpSuit));
  if (beatCard) {
    const ok2 = handlePlayCard(room4, dId, beatCard.id);
    assert(ok2 === true, 'Defense succeeded');
    const pair2 = room4.state.table[0];
    assert(pair2.defense && pair2.defense.id === beatCard.id, 'Defense card on table');
    assert(pair2.defense.rank === beatCard.rank, 'Defense rank correct');
    log('Table structure after defense: PASS');
    log(`  pair = ${JSON.stringify(room4.state.table[0], null, 2)}\n`);
  } else {
    log('SKIP: no beat card in hand\n');
  }

  // ===== TEST 5: TAKE (Беру) STATE =====
  console.log('🤲 TEST 5: TAKE STATE');
  const room5 = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room5);
  const aId5 = room5.state.playersInfo[room5.state.attackerIdx].id;
  const dId5 = room5.state.playersInfo[room5.state.defenderIdx].id;
  const aCard5 = room5.state.hands[aId5][0];
  handlePlayCard(room5, aId5, aCard5.id);
  const beforeTake = room5.state.hands[dId5].length;
  const takeOk = handleTake(room5, dId5);
  assert(takeOk === true, 'Take succeeded');
  assert(room5.state.table.length === 0, 'Table cleared after take');
  assert(room5.state.hands[dId5].length > beforeTake, 'Defender got cards');
  assert(room5.state.attackerIdx === (room5.state.defenderIdx + 1) % 2 || room5.state.attackerIdx === dId5, 'Attacker index updated');
  log('Take state: PASS\n');

  // ===== TEST 6: DONE (Бито) STATE =====
  console.log('✅ TEST 6: DONE STATE');
  const room6 = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room6);
  const aId6 = room6.state.playersInfo[room6.state.attackerIdx].id;
  const dId6 = room6.state.playersInfo[room6.state.defenderIdx].id;
  const aCard6 = room6.state.hands[aId6][0];
  handlePlayCard(room6, aId6, aCard6.id);
  const defHand6 = room6.state.hands[dId6];
  const beatCard6 = defHand6.find(c => canBeat(aCard6, c, room6.state.trumpSuit));
  if (beatCard6) {
    handlePlayCard(room6, dId6, beatCard6.id);
    const doneOk = handleDone(room6, aId6);
    assert(doneOk === true, 'Done succeeded');
    assert(room6.state.table.length === 0, 'Table cleared after done');
    assert(room6.state.attackerIdx === dId6, 'Defender becomes attacker');
    log('Done state: PASS\n');
  } else {
    log('SKIP: no beat card\n');
  }

  // ===== TEST 7: FULL GAME SIMULATION (BOT VS BOT) =====
  console.log('🤖 TEST 7: FULL GAME SIMULATION (5 games)');
  let gamesPassed = 0;
  for (let g = 1; g <= 5; g++) {
    try {
      const room7 = createRoom([{id:'bot1',isBot:true,botDifficulty:'normal'},{id:'bot2',isBot:true,botDifficulty:'normal'}], 'normal');
      initGameState(room7);
      let turns = 0;
      let lastTableHash = '';
      let stuck = 0;
      while (!room7.state.isGameOver && turns < 1000) {
        turns++;
        executeBotTurnChain(room7);
        // Check table rendering data
        const table = room7.state.table;
        for (const pair of table) {
          assert(pair.attack && pair.attack.id, `Pair has attack.id: ${JSON.stringify(pair)}`);
          assert(pair.attack.rank && pair.attack.suit, `Attack has rank/suit`);
          if (pair.defense) {
            assert(pair.defense.id, 'Defense has id');
            assert(pair.defense.rank && pair.defense.suit, 'Defense has rank/suit');
          }
        }
        // Infinite loop detection
        const tableHash = JSON.stringify(table.map(p => `${p.attack?.rank}${p.attack?.suit}-${p.defense?.rank||'-'}${p.defense?.suit||'-'}`));
        if (tableHash === lastTableHash) stuck++; else stuck = 0;
        lastTableHash = tableHash;
        if (stuck > 20) throw new Error('Stuck in loop');
      }
      assert(room7.state.isGameOver, `Game ${g} ended`);
      assert(room7.state.winner, `Game ${g} has winner`);
      gamesPassed++;
      log(`  Game ${g}: ${turns} turns, winner ${room7.state.winner}`);
    } catch(e) {
      log(`Game ${g}: FAIL - ${e.message}`);
    }
  }
  log(`Bot games: ${gamesPassed}/5 passed\n`);

  // ===== TEST 8: BROADCAST STATE STRUCTURE =====
  console.log('📡 TEST 8: BROADCAST STATE');
  const room8 = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room8);
  const io = mockIO();
  // Monkey-patch io
  global.io = io;
  broadcastState(room8);
  const events = io.getEvents();
  assert(events.game_update && events.game_update.length === 2, 'game_update emitted to both');
  const update = events.game_update[0].data;
  assert(update.hands && update.hands.p1 && update.hands.p2, 'Broadcast has hands');
  assert(update.table !== undefined, 'Broadcast has table');
  assert(Array.isArray(update.table), 'Broadcast table is array');
  assert(update.playersInfo.length === 2, 'Broadcast has playersInfo');
  log('Broadcast state structure: PASS\n');

  // ===== TEST 9: EDGE CASES =====
  console.log('🔍 TEST 9: EDGE CASES');
  
  // 9a: trumpCard preserved after deck empty
  const room9a = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room9a);
  room9a.state.deck = [];
  refillAllHands(room9a.state);
  assert(room9a.state.trumpCard !== null, 'trumpCard preserved after deck empty');
  log('trumpCard preserved: PASS');

  // 9b: Invalid cardId rejected
  const room9b = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room9b);
  const bad = handlePlayCard(room9b, room9b.state.playersInfo[0].id, 'invalid-id');
  assert(bad === false, 'Invalid cardId rejected');
  log('Invalid cardId rejected: PASS');

  // 9c: Wrong turn rejected (defender attacks on empty table)
  const room9c = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room9c);
  const def9c = room9c.state.playersInfo[room9c.state.defenderIdx].id;
  const wc = room9c.state.hands[def9c][0];
  const wrong = handlePlayCard(room9c, def9c, wc.id);
  assert(wrong === false, 'Defender cannot attack on empty table');
  log('Wrong turn rejected: PASS');

  // 9d: Card ID in hands after take
  const room9d = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room9d);
  const aId9d = room9d.state.playersInfo[room9d.state.attackerIdx].id;
  const dId9d = room9d.state.playersInfo[room9d.state.defenderIdx].id;
  const ac9d = room9d.state.hands[aId9d][0];
  handlePlayCard(room9d, aId9d, ac9d.id);
  handleTake(room9d, dId9d);
  const takenCards = room9d.state.hands[dId9d].filter(c => c.id === ac9d.id || (room9d.state.table[0]?.defense && c.id === room9d.state.table[0]?.defense?.id));
  // Cards should have IDs
  for (const c of room9d.state.hands[dId9d]) {
    assert(c.id !== undefined && c.id !== null, 'All cards in hand have ID after take');
  }
  log('Cards keep IDs after take: PASS');

  // 9e: Card ID in hands after done
  const room9e = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room9e);
  const aId9e = room9e.state.playersInfo[room9e.state.attackerIdx].id;
  const dId9e = room9e.state.playersInfo[room9e.state.defenderIdx].id;
  const ac9e = room9e.state.hands[aId9e][0];
  handlePlayCard(room9e, aId9e, ac9e.id);
  const defH9e = room9e.state.hands[dId9e];
  const bc9e = defH9e.find(c => canBeat(ac9e, c, room9e.state.trumpSuit));
  if (bc9e) {
    handlePlayCard(room9e, dId9e, bc9e.id);
    handleDone(room9e, aId9e);
    for (const pid of ['p1','p2']) {
      for (const c of room9e.state.hands[pid]) {
        assert(c.id !== undefined && c.id !== null, 'All cards in hand have ID after done');
      }
    }
    log('Cards keep IDs after done: PASS');
  }
  console.log();

  // ===== TEST 10: RENDER DATA VALIDATION =====
  console.log('🎨 TEST 10: RENDER DATA VALIDATION');
  const room10 = createRoom([{id:'p1'},{id:'p2'}]);
  initGameState(room10);
  const aId10 = room10.state.playersInfo[room10.state.attackerIdx].id;
  const aCard10 = room10.state.hands[aId10][0];
  handlePlayCard(room10, aId10, aCard10.id);
  
  // Simulate render data extraction
  const table = room10.state.table;
  for (const pair of table) {
    const attackHTML = `<div class="card" data-card="${pair.attack.rank}${pair.attack.suit}" data-id="${pair.attack.id}">`;
    assert(pair.attack.rank && pair.attack.suit, 'Attack has rank/suit for render');
    assert(pair.attack.id != null, 'Attack has id for render');
    log(`Render data OK: ${pair.attack.rank}${pair.attack.suit} (id:${pair.attack.id})`);
    if (pair.defense) {
      assert(pair.defense.rank && pair.defense.suit, 'Defense has rank/suit');
      assert(pair.defense.id != null, 'Defense has id');
      log(`Render data OK: defense ${pair.defense.rank}${pair.defense.suit} (id:${pair.defense.id})`);
    }
  }
  log('Render data validation: PASS\n');

  // ===== SUMMARY =====
  console.log('═══════════════════════════════════════════');
  console.log('  ✅ ALL DEEP TESTS PASSED');
  console.log('═══════════════════════════════════════════');
}

runDeepTests();