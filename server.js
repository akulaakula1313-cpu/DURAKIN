const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

const rooms = {};
const RANKS = [
  { rank: 6, value: 6 }, { rank: 7, value: 7 }, { rank: 8, value: 8 },
  { rank: 9, value: 9 }, { rank: 10, value: 10 }, { rank: 'J', value: 11 },
  { rank: 'Q', value: 12 }, { rank: 'K', value: 13 }, { rank: 'A', value: 14 }
];
const SUITS = ['♠', '♥', '♦', '♣'];

io.on('connection', (socket) => {
  socket.on('create_room', (data) => {
    let maxPlayers = 2;
    let playerName = 'Игрок 1';

    if (typeof data === 'object' && data !== null) {
      maxPlayers = parseInt(data.maxPlayers) || 2;
      if (data.playerName) playerName = data.playerName.trim().substring(0, 12);
    } else {
      maxPlayers = parseInt(data) || 2;
    }

    maxPlayers = Math.max(2, Math.min(4, maxPlayers));
    let code;
    do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); } while (rooms[code]);

    const room = {
      id: code,
      maxPlayers,
      players: [{ id: socket.id, isBot: false, name: playerName || 'Игрок 1' }],
      state: null,
      rematchVotes: new Set(),
      rematchTimer: null,
      botLoopTimeout: null
    };
    rooms[code] = room;
    socket.join(code);
    socket.emit('room_created', { code, maxPlayers });
    updateLobby(room);
  });

  socket.on('play_with_bots', (data) => {
    let playerName = 'Вы';
    let botDifficulty = 'normal';
    if (typeof data === 'object' && data !== null) {
      if (data.playerName) playerName = data.playerName.trim().substring(0, 12);
      if (data.botDifficulty && ['easy', 'normal', 'hard'].includes(data.botDifficulty)) {
        botDifficulty = data.botDifficulty;
      }
    }

    const code = 'BOTS_' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      id: code,
      maxPlayers: 2,
      players: [{ id: socket.id, isBot: false, name: playerName || 'Вы' }],
      state: null,
      rematchVotes: new Set(),
      rematchTimer: null,
      botLoopTimeout: null,
      botDifficulty
    };
    rooms[code] = room;
    socket.join(code);
    fillRoomWithBots(room, botDifficulty);
    initGameState(room);
    broadcastState(room);
    scheduleBotTurn(room);
  });

  socket.on('join_room', (data) => {
    let code = '';
    let playerName = '';

    if (typeof data === 'object' && data !== null) {
      code = data.roomCode;
      playerName = data.playerName;
    } else {
      code = data;
    }

    if (!code || typeof code !== 'string') return;
    code = code.trim().toUpperCase();
    const room = rooms[code];
    if (!room) { socket.emit('error_msg', 'Комната не найдена'); return; }
    if (room.state) { socket.emit('error_msg', 'Игра уже началась'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error_msg', 'Комната заполнена'); return; }

    const pName = playerName ? playerName.trim().substring(0, 12) : `Игрок ${room.players.length + 1}`;
    room.players.push({ id: socket.id, isBot: false, name: pName });
    socket.join(code);
    updateLobby(room);

    if (room.players.length === room.maxPlayers) {
      initGameState(room);
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('send_message', ({ roomCode, message }) => {
    if (!roomCode || !message) return;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const cleanMsg = message.trim().substring(0, 150);
    if (!cleanMsg) return;
    io.to(room.id).emit('chat_message', { senderId: socket.id, senderName: player.name, message: cleanMsg });
  });

  socket.on('vote_rematch', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.state || !room.state.isGameOver) return;
    room.rematchVotes.add(socket.id);
    const humanPlayers = room.players.filter(p => !p.isBot);
    io.to(room.id).emit('rematch_voted', { votesCount: room.rematchVotes.size, totalNeeded: humanPlayers.length });
    if (room.rematchVotes.size >= humanPlayers.length) {
      if (room.rematchTimer) clearInterval(room.rematchTimer);
      startRematch(room);
    }
  });

  socket.on('player_action', ({ roomCode, action, cardId }) => {
    const room = rooms[roomCode];
    if (!room) { socket.emit('error_msg', 'Комната не найдена'); return; }
    if (!room.state || room.state.isGameOver) return;
    const humanP = room.players.find(p => p.id === socket.id);
    if (!humanP) return;

    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);

    let success = false;
    if (action === 'play_card') success = handlePlayCard(room, socket.id, cardId);
    else if (action === 'take') success = handleTake(room, socket.id);
    else if (action === 'done') success = handleDone(room, socket.id);
    else if (action === 'pass') success = handlePass(room, socket.id);

    if (success) {
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('leave_room', (roomCode) => {
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    if (room.rematchTimer) clearInterval(room.rematchTimer);
    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
    socket.leave(roomCode);
    room.players.splice(idx, 1);
    const humansLeft = room.players.filter(p => !p.isBot).length;
    if (humansLeft === 0) {
      delete rooms[roomCode];
    } else if (room.state && !room.state.isGameOver) {
      io.to(roomCode).emit('opponent_disconnected');
      delete rooms[roomCode];
    } else {
      updateLobby(room);
    }
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;
      if (room.rematchTimer) clearInterval(room.rematchTimer);
      if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
      room.players.splice(idx, 1);
      const humansLeft = room.players.filter(p => !p.isBot).length;
      if (humansLeft === 0) {
        delete rooms[code];
      } else if (room.state && !room.state.isGameOver) {
        io.to(code).emit('opponent_disconnected');
        delete rooms[code];
      } else {
        updateLobby(room);
      }
      break;
    }
  });
});

function fillRoomWithBots(room, difficulty = 'normal') {
  const botNames = ['Бот Валера', 'Бот Степан', 'Бот Гриша'];
  let nameIdx = 0;
  while (room.players.length < room.maxPlayers) {
    room.players.push({
      id: 'BOT_' + Math.random().toString(36).substring(2, 8),
      isBot: true,
      name: botNames[nameIdx++ % botNames.length],
      botDifficulty: difficulty
    });
  }
}

function updateLobby(room) {
  const humanCount = room.players.filter(p => !p.isBot).length;
  io.to(room.id).emit('lobby_update', { code: room.id, current: room.players.length, max: room.maxPlayers, humanCount });
}

function initGameState(room) {
  const deck = [];
  let id = 0;
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: id++, suit: s, rank: r.rank, value: r.value });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const trumpCard = deck[deck.length - 1];
  const hands = {};
  room.players.forEach(p => {
    hands[p.id] = deck.splice(0, 6);
    sortHand(hands[p.id], trumpCard.suit);
  });

  let firstAttackerIdx = 0;
  let minTrumpValue = 999;
  room.players.forEach((p, idx) => {
    const trCards = hands[p.id].filter(c => c.suit === trumpCard.suit);
    trCards.forEach(c => {
      if (c.value < minTrumpValue) {
        minTrumpValue = c.value;
        firstAttackerIdx = idx;
      }
    });
  });

  const defenderIdx = (firstAttackerIdx + 1) % room.players.length;
  room.state = {
    roomCode: room.id,
    deck,
    trumpCard,
    trumpSuit: trumpCard.suit,
    hands,
    table: [],
    attackerIdx: firstAttackerIdx,
    defenderIdx,
    currentThrowerIdx: firstAttackerIdx,
    playersInfo: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, botDifficulty: p.botDifficulty || 'normal' })),
    isGameOver: false,
    winner: null
  };
  room.rematchVotes.clear();
}

function sortHand(hand, trumpSuit) {
  hand.sort((a, b) => {
    const aTr = a.suit === trumpSuit ? 1 : 0;
    const bTr = b.suit === trumpSuit ? 1 : 0;
    if (aTr !== bTr) return aTr - bTr;
    return a.value - b.value;
  });
}

function canBeat(att, def, trumpSuit) {
  const aTr = att.suit === trumpSuit;
  const dTr = def.suit === trumpSuit;
  if (aTr && !dTr) return false;
  if (aTr && dTr) return def.value > att.value;
  if (!dTr) return att.suit === def.suit && def.value > att.value;
  return true;
}

function getTableRanks(table) {
  const ranks = new Set();
  for (const p of table) {
    ranks.add(p.attack.rank);
    if (p.defense) ranks.add(p.defense.rank);
  }
  return ranks;
}

function countDefendedPairs(table) {
  return table.filter(p => p.defense !== null).length;
}

function handlePlayCard(room, pId, cardId) {
  const state = room.state;
  const hand = state.hands[pId];
  if (!hand) {
    io.to(pId).emit('error_msg', 'Нет карт на руке');
    return false;
  }
  const cardIdx = hand.findIndex(c => c.id === cardId);
  if (cardIdx === -1) {
    io.to(pId).emit('error_msg', 'Карта не найдена');
    return false;
  }
  const card = hand[cardIdx];
  const attackerId = state.playersInfo[state.attackerIdx].id;
  const defenderId = state.playersInfo[state.defenderIdx].id;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);

  if (pId !== defenderId) {
    if (state.table.length === 0) {
      if (pId !== attackerId) {
        io.to(pId).emit('error_msg', 'Сейчас ход первого атакующего!');
        return false;
      }
    } else {
      const tRanks = getTableRanks(state.table);
      if (!tRanks.has(card.rank)) {
        io.to(pId).emit('error_msg', 'Такой карты нет на столе');
        return false;
      }
      const defHandLen = state.hands[defenderId].length;
      if (state.table.length >= Math.min(6, defHandLen + countDefendedPairs(state.table))) {
        io.to(pId).emit('error_msg', 'У защищающегося нет столько карт');
        return false;
      }
    }
    hand.splice(cardIdx, 1);
    state.table.push({ attack: card, defense: null, attackerId: pId });
    state.currentThrowerIdx = pIdx;
    checkGameOver(room);
    return true;
  } else {
    if (state.table.length === 0) {
      io.to(pId).emit('error_msg', 'Стол пуст');
      return false;
    }
    const uncoveredIdx = state.table.findIndex(p => p.defense === null);
    if (uncoveredIdx === -1) {
      io.to(pId).emit('error_msg', 'Все отбито');
      return false;
    }
    const attCard = state.table[uncoveredIdx].attack;
    if (!canBeat(attCard, card, state.trumpSuit)) {
      io.to(pId).emit('error_msg', 'Не бьет карту');
      return false;
    }
    hand.splice(cardIdx, 1);
    state.table[uncoveredIdx].defense = card;
    checkGameOver(room);
    return true;
  }
}

function handlePass(room, pId) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);
  if (pIdx === -1 || state.currentThrowerIdx !== pIdx) return false;
  if (state.table.length === 0) {
    io.to(pId).emit('error_msg', 'На столе нет карт');
    return false;
  }
  if (!state.table.every(p => p.defense !== null)) {
    io.to(pId).emit('error_msg', 'Сначала нужно отбить все карты');
    return false;
  }
  const playerCount = state.playersInfo.length;
  let nextIdx = (state.currentThrowerIdx + 1) % playerCount;
  if (nextIdx === state.defenderIdx) nextIdx = (nextIdx + 1) % playerCount;
  state.currentThrowerIdx = nextIdx;
  return true;
}

function handleTake(room, pId) {
  const state = room.state;
  const defenderIdx = state.defenderIdx;
  const defenderId = state.playersInfo[defenderIdx].id;
  if (pId !== defenderId) {
    io.to(pId).emit('error_msg', 'Брать может только защищающийся');
    return false;
  }
  if (state.table.length === 0) {
    io.to(pId).emit('error_msg', 'На столе нет карт');
    return false;
  }
  for (const p of state.table) {
    state.hands[pId].push(p.attack);
    if (p.defense) state.hands[pId].push(p.defense);
  }
  state.table = [];
  sortHand(state.hands[pId], state.trumpSuit);
  refillAllHands(state);
  if (checkGameOver(room)) {
    return true;
  }
  // After take: next player AFTER the taker becomes new attacker
  // Taker was defender, so new attacker = (defenderIdx + 1) % n
  state.attackerIdx = (defenderIdx + 1) % state.playersInfo.length;
  state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
  state.currentThrowerIdx = state.attackerIdx;
  return true;
}

function handleDone(room, pId) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);
  const isAttackerParty = pId !== state.playersInfo[state.defenderIdx].id;
  if (pIdx === -1 || pIdx !== state.currentThrowerIdx) {
    io.to(pId).emit('error_msg', 'Сейчас завершить атаку может другой игрок');
    return false;
  }
  if (!isAttackerParty) {
    io.to(pId).emit('error_msg', 'Защищающийся не может сказать Бито');
    return false;
  }
  if (state.table.length === 0 || !state.table.every(p => p.defense !== null)) {
    io.to(pId).emit('error_msg', 'Не все карты отбиты');
    return false;
  }
  state.table = [];
  refillAllHands(state);
  if (checkGameOver(room)) {
    return true;
  }
  state.attackerIdx = state.defenderIdx;
  state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
  state.currentThrowerIdx = state.attackerIdx;
  return true;
}

function refillAllHands(state) {
  const count = state.playersInfo.length;
  for (let i = 0; i < count; i++) {
    const idx = (state.attackerIdx + i) % count;
    const pId = state.playersInfo[idx].id;
    if (!state.hands[pId]) state.hands[pId] = [];
    while (state.hands[pId].length < 6 && state.deck.length > 0) {
      state.hands[pId].push(state.deck.pop());
    }
    sortHand(state.hands[pId], state.trumpSuit);
  }
  if (state.deck.length === 0) state.trumpCard = null;
}

function checkGameOver(room) {
  const state = room.state;
  if (state.deck.length > 0) return false;
  const playersWithCards = state.playersInfo.filter(p => state.hands[p.id]?.length > 0);
  if (playersWithCards.length <= 1) {
    state.isGameOver = true;
    state.winner = playersWithCards.length === 1 ? playersWithCards[0].id : null;
    io.to(room.id).emit('game_over', { state, winner: state.winner });
    startRematchCountdown(room);
    return true;
  }
  return false;
}

function scheduleBotTurn(room) {
  if (!room || !room.state || room.state.isGameOver) return;
  if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
  room.botLoopTimeout = setTimeout(() => executeBotTurnChain(room), 800);
}

function executeBotTurnChain(room) {
  if (!room || !room.state || room.state.isGameOver) return;
  const state = room.state;
  const defP = state.playersInfo[state.defenderIdx];
  const uncoveredIdx = state.table.findIndex(p => p.defense === null);
  const hasCards = pId => (state.hands[pId] || []).length > 0;
  const playerCount = state.playersInfo.length;

  // 1. Defender must beat or take
  if (uncoveredIdx !== -1) {
    if (defP && !defP.isBot) {
      return; // wait for human
    }
    if (defP && defP.isBot) {
      const attCard = state.table[uncoveredIdx].attack;
      const botHand = state.hands[defP.id] || [];
      const difficulty = defP.botDifficulty || 'normal';
      let bestCard = null;

      if (difficulty === 'easy') {
        // Easy: pick first valid card (random-ish)
        for (const c of botHand) {
          if (canBeat(attCard, c, state.trumpSuit)) {
            bestCard = c;
            break;
          }
        }
      } else if (difficulty === 'hard') {
        // Hard: save trumps, beat with minimal card, consider future
        let bestScore = Infinity;
        for (const c of botHand) {
          if (canBeat(attCard, c, state.trumpSuit)) {
            const isTrump = c.suit === state.trumpSuit;
            const isAttackerTrump = attCard.suit === state.trumpSuit;
            // Prefer non-trump beats, then low trumps
            // If attacker plays trump, we must beat with higher trump
            // If we have only trumps left, save high ones
            let score = isTrump ? 100 + c.value : c.value;
            // Penalize using high trumps on non-trump attacks
            if (isTrump && !isAttackerTrump && c.value > 10) score += 50;
            if (score < bestScore) {
              bestScore = score;
              bestCard = c;
            }
          }
        }
      } else {
        // Normal: current logic - minimal card that beats
        let minScore = Infinity;
        for (const c of botHand) {
          if (canBeat(attCard, c, state.trumpSuit)) {
            const isTrump = c.suit === state.trumpSuit;
            const score = isTrump ? 100 + c.value : c.value;
            if (score < minScore) {
              minScore = score;
              bestCard = c;
            }
          }
        }
      }

      if (bestCard) {
        handlePlayCard(room, defP.id, bestCard.id);
      } else {
        handleTake(room, defP.id);
      }
    }
    return;
  }

  // 2. Empty table - attacker's turn
  if (state.table.length === 0) {
    let checkedCount = 0;
    while (checkedCount < playerCount) {
      const attP = state.playersInfo[state.attackerIdx];
      if (hasCards(attP.id)) break;
      state.attackerIdx = (state.attackerIdx + 1) % playerCount;
      state.defenderIdx = (state.defenderIdx + 1) % playerCount;
      state.currentThrowerIdx = state.attackerIdx;
      checkedCount++;
    }
    if (checkGameOver(room)) return;
    const attP = state.playersInfo[state.attackerIdx];
    if (attP && !attP.isBot) {
      return; // wait for human
    }
    if (attP && attP.isBot && hasCards(attP.id)) {
      const botHand = state.hands[attP.id] || [];
      const difficulty = attP.botDifficulty || 'normal';
      let targetCard = null;

      const nonTrumps = botHand.filter(c => c.suit !== state.trumpSuit);
      const trumps = botHand.filter(c => c.suit === state.trumpSuit);

      if (difficulty === 'easy') {
        // Easy: play random non-trump, or lowest trump
        if (nonTrumps.length > 0) {
          targetCard = nonTrumps[Math.floor(Math.random() * nonTrumps.length)];
        } else if (trumps.length > 0) {
          trumps.sort((a, b) => a.value - b.value);
          targetCard = trumps[0];
        }
      } else if (difficulty === 'hard') {
        // Hard: strategic attack
        // Count remaining cards in deck to gauge game phase
        const deckSize = state.deck.length;
        const isLateGame = deckSize < 10;
        
        if (nonTrumps.length > 0) {
          // Prefer attacking with ranks opponent likely doesn't have
          // Sort by value, but prefer mid-range cards (not too low, not too high)
          nonTrumps.sort((a, b) => {
            // In late game, play higher cards to force trumps
            if (isLateGame) return b.value - a.value;
            return a.value - b.value;
          });
          targetCard = nonTrumps[0];
        } else if (trumps.length > 0) {
          // Only trumps left - play lowest unless late game
          trumps.sort((a, b) => a.value - b.value);
          targetCard = trumps[0];
        }
      } else {
        // Normal: lowest non-trump, then lowest trump
        if (nonTrumps.length > 0) {
          nonTrumps.sort((a, b) => a.value - b.value);
          targetCard = nonTrumps[0];
        } else if (trumps.length > 0) {
          trumps.sort((a, b) => a.value - b.value);
          targetCard = trumps[0];
        }
      }

      if (targetCard) handlePlayCard(room, attP.id, targetCard.id);
    }
    return;
  }

  // 3. Table has cards, all defended - attackers can add more
  if (state.table.length > 0 && uncoveredIdx === -1) {
    const curThrower = state.playersInfo[state.currentThrowerIdx];
    if (curThrower.id === defP.id || !hasCards(curThrower.id)) {
      state.currentThrowerIdx = (state.currentThrowerIdx + 1) % playerCount;
      return; // will be rescheduled by player_action
    }
    if (!curThrower.isBot) {
      return; // wait for human
    }
    const hand = state.hands[curThrower.id] || [];
    const difficulty = curThrower.botDifficulty || 'normal';
    const tRanks = getTableRanks(state.table);
    const defLen = (state.hands[defP.id] || []).length;
    const canAdd = state.table.length < Math.min(6, defLen + countDefendedPairs(state.table));
    const hasValid = hand.some(c => tRanks.has(c.rank));
    
    if (hasValid && canAdd) {
      const matchObj = hand.filter(c => tRanks.has(c.rank));
      if (matchObj.length > 0) {
        if (difficulty === 'easy') {
          // Easy: play first matching card
          handlePlayCard(room, curThrower.id, matchObj[0].id);
        } else if (difficulty === 'hard') {
          // Hard: prefer non-trumps, then low trumps, consider defender's likely cards
          matchObj.sort((a, b) => {
            const aTr = a.suit === state.trumpSuit ? 1 : 0;
            const bTr = b.suit === state.trumpSuit ? 1 : 0;
            if (aTr !== bTr) return aTr - bTr;
            return a.value - b.value;
          });
          // In late game, sometimes play higher to pressure
          const deckSize = state.deck.length;
          if (deckSize < 6 && matchObj.length > 1 && Math.random() < 0.3) {
            // 30% chance to play a higher card in late game
            handlePlayCard(room, curThrower.id, matchObj[matchObj.length - 1].id);
          } else {
            handlePlayCard(room, curThrower.id, matchObj[0].id);
          }
        } else {
          // Normal
          matchObj.sort((a, b) => {
            const aTr = a.suit === state.trumpSuit ? 1 : 0;
            const bTr = b.suit === state.trumpSuit ? 1 : 0;
            if (aTr !== bTr) return aTr - bTr;
            return a.value - b.value;
          });
          handlePlayCard(room, curThrower.id, matchObj[0].id);
        }
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
      if (pInfo.id === defP.id || !hasCards(pInfo.id)) continue;
      const pHand = state.hands[pInfo.id] || [];
      if (pHand.some(c => tRanks.has(c.rank))) {
        anyCanThrow = true;
        break;
      }
    }
    if (!anyCanThrow) {
      const activeAttacker = state.playersInfo.find(p => p.id !== defP.id && hasCards(p.id)) || state.playersInfo[state.attackerIdx];
      if (activeAttacker && !activeAttacker.isBot) {
        return; // wait for human
      } else if (activeAttacker) {
        handleDone(room, activeAttacker.id);
      }
    }
    return;
  }
}

function startRematchCountdown(room) {
  let timeLeft = 15;
  room.rematchVotes.clear();
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  io.to(room.id).emit('rematch_timer', timeLeft);
  room.rematchTimer = setInterval(() => {
    timeLeft--;
    io.to(room.id).emit('rematch_timer', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(room.rematchTimer);
      const humanPlayers = room.players.filter(p => !p.isBot);
      if (room.rematchVotes.size >= humanPlayers.length && humanPlayers.length > 0) {
        startRematch(room);
      } else {
        io.to(room.id).emit('room_expired');
        delete rooms[room.id];
      }
    }
  }, 1000);
}

function startRematch(room) {
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  initGameState(room);
  io.to(room.id).emit('game_restarted');
  broadcastState(room);
  scheduleBotTurn(room);
}

function broadcastState(room) {
  room.players.forEach(p => {
    if (!p.isBot) {
      const adaptedState = JSON.parse(JSON.stringify(room.state));
      const realHands = {};
      room.players.forEach(targetP => {
        if (targetP.id === p.id) {
          realHands[p.id] = room.state.hands[p.id] || [];
        } else {
          realHands[targetP.id] = new Array((room.state.hands[targetP.id] || []).length).fill({});
        }
      });
      adaptedState.hands = realHands;
      adaptedState.playersInfo.forEach(info => {
        if (info.id === p.id) info.name = 'Вы';
      });
      io.to(p.id).emit('game_update', adaptedState);
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Сервер] Запущен на порту ${PORT}`));

module.exports = {
  RANKS,
  SUITS,
  createDeck: () => {
    const deck = [];
    let id = 0;
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ id: id++, suit: s, rank: r.rank, value: r.value });
      }
    }
    return deck;
  },
  shuffleDeck: deck => {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  },
  sortHand,
  canBeat,
  getTableRanks,
  countDefendedPairs,
  initGameState,
  refillAllHands,
  checkGameOver,
  handlePlayCard,
  handleTake,
  handleDone,
  handlePass,
  executeBotTurnChain
};
