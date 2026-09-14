const {
  RANKS,
  SUITS,
  createDeck,
  shuffleDeck,
  sortHand,
  canBeat,
  getTableRanks,
  countDefendedPairs,
  refillAllHands,
  checkGameOver,
  initGameState
} = require('../server.js');

function createBotRoom(playerCount = 2) {
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: `BOT_${i}`,
      isBot: true,
      name: `Bot ${i + 1}`
    });
  }
  return {
    id: 'SIM_' + Math.random().toString(36).substring(7),
    maxPlayers: playerCount,
    players,
    state: null,
    rematchVotes: new Set(),
    rematchTimer: null,
    botTimer: null,
    botLoopTimeout: null
  };
}

function hasCards(state, pId) {
  return (state.hands[pId] || []).length > 0;
}

function executeBotTurnChainPure(room) {
  const state = room.state;
  if (!state || state.isGameOver) return;
  
  const defP = state.playersInfo[state.defenderIdx];
  const uncoveredIdx = state.table.findIndex(p => p.defense === null);
  const playerCount = state.playersInfo.length;
  
  // 1. Defender's turn - must beat or take
  if (uncoveredIdx !== -1) {
    if (!defP.isBot) return;
    const attCard = state.table[uncoveredIdx].attack;
    const botHand = state.hands[defP.id] || [];
    let bestIdx = -1; let minVal = 999;
    for (let i = 0; i < botHand.length; i++) {
      const c = botHand[i];
      if (canBeat(attCard, c, state.trumpSuit)) {
        const isTr = (c.suit === state.trumpSuit ? 1 : 0);
        const score = isTr ? 100 + c.value : c.value;
        if (score < minVal) { minVal = score; bestIdx = i; }
      }
    }
    if (bestIdx !== -1) {
      // Play defense card
      const card = botHand.splice(bestIdx, 1)[0];
      state.table[uncoveredIdx].defense = card;
      checkGameOver(room);
      return;
    } else {
      // Take all cards
      for (const p of state.table) {
        state.hands[defP.id].push(p.attack);
        if (p.defense) state.hands[defP.id].push(p.defense);
      }
      state.table = [];
      sortHand(state.hands[defP.id], state.trumpSuit);
      refillAllHands(state);
      if (checkGameOver(room)) return;
      // After take: next player AFTER the taker becomes new attacker
      // Taker was at defenderIdx
      state.attackerIdx = (state.defenderIdx + 1) % playerCount;
      state.defenderIdx = (state.attackerIdx + 1) % playerCount;
      state.currentThrowerIdx = state.attackerIdx;
      return;
    }
  }
  
  // 2. Empty table - attacker's turn
  if (state.table.length === 0) {
    let checkedCount = 0;
    while (checkedCount < playerCount) {
      const attP = state.playersInfo[state.attackerIdx];
      if (hasCards(state, attP.id)) break;
      state.attackerIdx = (state.attackerIdx + 1) % playerCount;
      state.defenderIdx = (state.defenderIdx + 1) % playerCount;
      state.currentThrowerIdx = state.attackerIdx;
      checkedCount++;
    }
    if (checkGameOver(room)) return;
    const attP = state.playersInfo[state.attackerIdx];
    if (!attP.isBot) return;
    if (!hasCards(state, attP.id)) return;
    const botHand = state.hands[attP.id] || [];
    const nonTrumps = botHand.map((c, idx) => ({c, idx})).filter(o => o.c.suit !== state.trumpSuit);
    let targetIdx = 0;
    if (nonTrumps.length > 0) {
      nonTrumps.sort((a,b) => a.c.value - b.c.value);
      targetIdx = nonTrumps[0].idx;
    }
    // Play attack card
    const card = botHand.splice(targetIdx, 1)[0];
    state.table.push({ attack: card, defense: null, attackerId: attP.id });
    state.currentThrowerIdx = state.attackerIdx;
    checkGameOver(room);
    return;
  }
  
  // 3. Table has cards, all defended - attackers can add more
  if (state.table.length > 0 && uncoveredIdx === -1) {
    const curThrower = state.playersInfo[state.currentThrowerIdx];
    if (curThrower.id === defP.id || !hasCards(state, curThrower.id)) {
      state.currentThrowerIdx = (state.currentThrowerIdx + 1) % playerCount;
      return;
    }
    if (!curThrower.isBot) return;
    const hand = state.hands[curThrower.id] || [];
    const tRanks = getTableRanks(state.table);
    const defLen = (state.hands[defP.id] || []).length;
    const canAdd = state.table.length < Math.min(6, defLen + countDefendedPairs(state.table));
    const hasValid = hand.some(c => tRanks.has(c.rank));
    if (hasValid && canAdd) {
      const matchObj = hand.map((c, idx) => ({c, idx})).filter(o => tRanks.has(o.c.rank));
      if (matchObj.length > 0) {
        matchObj.sort((a,b) => {
          const aTr = a.c.suit === state.trumpSuit ? 1 : 0;
          const bTr = b.c.suit === state.trumpSuit ? 1 : 0;
          if (aTr !== bTr) return aTr - bTr;
          return a.c.value - b.c.value;
        });
        const card = hand.splice(matchObj[0].idx, 1)[0];
        state.table.push({ attack: card, defense: null, attackerId: curThrower.id });
        state.currentThrowerIdx = state.playersInfo.findIndex(p => p.id === curThrower.id);
        checkGameOver(room);
        return;
      }
    }
    // Pass - next thrower
    let nextIdx = (state.currentThrowerIdx + 1) % playerCount;
    if (nextIdx === state.defenderIdx) nextIdx = (nextIdx + 1) % playerCount;
    state.currentThrowerIdx = nextIdx;
    // Check if anyone can throw
    let anyCanThrow = false;
    for (const pInfo of state.playersInfo) {
      if (pInfo.id === defP.id || !hasCards(state, pInfo.id)) continue;
      const pHand = state.hands[pInfo.id] || [];
      if (pHand.some(c => tRanks.has(c.rank))) {
        anyCanThrow = true;
        break;
      }
    }
    if (!anyCanThrow) {
      // All pass - done
      state.table = [];
      refillAllHands(state);
      if (checkGameOver(room)) return;
      state.attackerIdx = state.defenderIdx;
      state.defenderIdx = (state.attackerIdx + 1) % playerCount;
      state.currentThrowerIdx = state.attackerIdx;
    }
    return;
  }
}

function simulateGame(gameNum, playerCount = 2) {
  const room = createBotRoom(playerCount);
  initGameState(room);
  
  let turns = 0;
  const maxTurns = 1000;
  let lastStateHash = '';
  let stuckCounter = 0;
  
  while (!room.state.isGameOver && turns < maxTurns) {
    turns++;
    
    // Check for infinite loop
    const stateHash = JSON.stringify({
      deckLen: room.state.deck.length,
      hands: Object.fromEntries(Object.entries(room.state.hands).map(([k,v]) => [k, v.length])),
      tableLen: room.state.table.length,
      attackerIdx: room.state.attackerIdx,
      defenderIdx: room.state.defenderIdx,
      currentThrowerIdx: room.state.currentThrowerIdx
    });
    
    if (stateHash === lastStateHash) {
      stuckCounter++;
      if (stuckCounter > 10) {
        throw new Error(`Game ${gameNum}: Infinite loop detected after ${turns} turns`);
      }
    } else {
      stuckCounter = 0;
      lastStateHash = stateHash;
    }
    
    executeBotTurnChainPure(room);
  }
  
  if (turns >= maxTurns) {
    throw new Error(`Game ${gameNum}: Max turns (${maxTurns}) exceeded`);
  }
  
  if (!room.state.winner) {
    throw new Error(`Game ${gameNum}: No winner determined`);
  }
  
  return { turns, winner: room.state.winner };
}

function runSimulation() {
  console.log('Running AI vs AI simulation (10 games)...\n');
  
  const results = [];
  for (let i = 1; i <= 10; i++) {
    try {
      const result = simulateGame(i, 2);
      results.push(result);
      console.log(`Game ${i}: ✅ Completed in ${result.turns} turns, winner: ${result.winner}`);
    } catch (error) {
      console.log(`Game ${i}: ❌ FAILED - ${error.message}`);
      results.push({ error: error.message });
    }
  }
  
  console.log('\n=== SIMULATION SUMMARY ===');
  const successful = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);
  
  console.log(`Successful: ${successful.length}/10`);
  console.log(`Failed: ${failed.length}/10`);
  
  if (successful.length > 0) {
    const avgTurns = successful.reduce((sum, r) => sum + r.turns, 0) / successful.length;
    console.log(`Average turns: ${avgTurns.toFixed(1)}`);
    console.log(`Min turns: ${Math.min(...successful.map(r => r.turns))}`);
    console.log(`Max turns: ${Math.max(...successful.map(r => r.turns))}`);
  }
  
  if (failed.length > 0) {
    console.log('\nFailures:');
    failed.forEach((r, i) => console.log(`  ${i + 1}. ${r.error}`));
    process.exit(1);
  } else {
    console.log('\n✅ All 10 simulation games completed successfully!');
  }
}

runSimulation();