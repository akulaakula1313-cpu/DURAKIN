/**
 * SANI GROUP — ДУРАК PREMIUM
 * v2.1 — все баги исправлены
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const RANKS = [
  { rank: 6, value: 6 }, { rank: 7, value: 7 }, { rank: 8, value: 8 },
  { rank: 9, value: 9 }, { rank: 10, value: 10 }, { rank: 'J', value: 11 },
  { rank: 'Q', value: 12 }, { rank: 'K', value: 13 }, { rank: 'A', value: 14 }
];
const SUITS = ['♠', '♥', '♦', '♣'];
const TURN_TIMEOUT_MS = 45000;

let io = null;
const rooms = {};

function setIO(i) { io = i; }
function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

function createDeck() {
  const deck = [];
  let id = 0;
  for (const s of SUITS) for (const r of RANKS)
    deck.push({ id: id++, suit: s, rank: r.rank, value: r.value });
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sortHand(hand, trumpSuit, mode = 'trump-right') {
  hand.sort((a, b) => {
    const aT = a.suit === trumpSuit ? 1 : 0;
    const bT = b.suit === trumpSuit ? 1 : 0;
    if (mode === 'trump-left') { if (aT !== bT) return bT - aT; }
    else                       { if (aT !== bT) return aT - bT; }
    if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    return a.value - b.value;
  });
}

function canBeat(att, def, trumpSuit) {
  const aT = att.suit === trumpSuit;
  const dT = def.suit === trumpSuit;
  if (aT && !dT) return false;
  if (aT && dT)  return def.value > att.value;
  if (!dT)       return att.suit === def.suit && def.value > att.value;
  return true;
}

function getTableRanks(table) {
  const r = new Set();
  for (const p of table) {
    r.add(p.attack.rank);
    if (p.defense) r.add(p.defense.rank);
  }
  return r;
}

function handLen(state, id) { return (state.hands[id] || []).length; }

function maxTablePairs(state) {
  const defId = state.playersInfo[state.defenderIdx].id;
  return Math.min(6, handLen(state, defId));
}

function advanceAttackerToNonEmpty(state) {
  const n = state.playersInfo.length;
  for (let i = 0; i < n; i++) {
    const attId = state.playersInfo[state.attackerIdx].id;
    if (state.attackerIdx !== state.defenderIdx && handLen(state, attId) > 0) return true;
    state.attackerIdx = (state.attackerIdx + 1) % n;
    state.defenderIdx = (state.attackerIdx + 1) % n;
    state.currentThrowerIdx = state.attackerIdx;
  }
  return false;
}

function findNextThrower(state, from) {
  const n = state.playersInfo.length;
  const defId = state.playersInfo[state.defenderIdx].id;
  if (state.table.length >= maxTablePairs(state)) return -1;
  const ranks = getTableRanks(state.table);
  for (let i = 1; i < n; i++) {
    const idx = (from + i) % n;
    const p = state.playersInfo[idx];
    if (p.id === defId) continue;
    const hand = state.hands[p.id] || [];
    if (hand.some(c => ranks.has(c.rank))) return idx;
  }
  return -1;
}

function initGameState(room) {
  const deck = shuffleDeck(createDeck());
  const trumpCard = deck[deck.length - 1];
  const trumpSuit = trumpCard.suit;
  const hands = {};

  for (const p of room.players) {
    hands[p.id] = deck.splice(0, 6);
    sortHand(hands[p.id], trumpSuit);
  }

  let minV = Infinity;
  let candidates = [];
  room.players.forEach((p, idx) => {
    const localMin = hands[p.id]
      .filter(c => c.suit === trumpSuit)
      .reduce((m, c) => Math.min(m, c.value), Infinity);
    if (localMin === Infinity) return;
    if (localMin < minV) { minV = localMin; candidates = [idx]; }
    else if (localMin === minV) candidates.push(idx);
  });
  const firstIdx = candidates.length
    ? candidates[Math.floor(Math.random() * candidates.length)]
    : Math.floor(Math.random() * room.players.length);

  const n = room.players.length;
  const defIdx = (firstIdx + 1) % n;

  room.state = {
    roomCode: room.id,
    deck, trumpCard, trumpSuit, hands,
    table: [],
    attackerIdx: firstIdx,
    defenderIdx: defIdx,
    currentThrowerIdx: firstIdx,
    playersInfo: room.players.map(p => ({
      id: p.id, name: p.name, isBot: !!p.isBot,
      botDifficulty: p.botDifficulty || 'normal'
    })),
    isGameOver: false,
    winners: [],
    loser: null,
    turnStartedAt: Date.now(),
    gameStartedAt: Date.now(),
    moveLog: []
  };
  if (room.rematchVotes) room.rematchVotes.clear();
}

function logMove(state, text) {
  state.moveLog.push({ t: Date.now(), text });
  if (state.moveLog.length > 60) state.moveLog.shift();
}

function handlePlayCard(room, pId, cardId) {
  const state = room.state;
  const hand = state.hands[pId];
  if (!hand) { getIO().to(pId).emit('error_msg', 'Нет карт на руке'); return false; }
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) { getIO().to(pId).emit('error_msg', 'Карта не найдена'); return false; }

  const card = hand[idx];
  const defId = state.playersInfo[state.defenderIdx].id;
  const attId = state.playersInfo[state.attackerIdx].id;
  const pIdx  = state.playersInfo.findIndex(p => p.id === pId);
  const pName = state.playersInfo[pIdx].name;

  if (pId === defId) {
    if (state.table.length === 0) {
      getIO().to(pId).emit('error_msg', 'Стол пуст'); return false;
    }
    const unIdx = state.table.findIndex(p => p.defense === null);
    if (unIdx === -1) {
      getIO().to(pId).emit('error_msg', 'Всё уже отбито'); return false;
    }
    const attCard = state.table[unIdx].attack;
    if (!canBeat(attCard, card, state.trumpSuit)) {
      getIO().to(pId).emit('error_msg', 'Карта не бьёт атаку'); return false;
    }
    hand.splice(idx, 1);
    state.table[unIdx].defense = card;
    logMove(state, `${pName}: отбил ${attCard.rank}${attCard.suit} → ${card.rank}${card.suit}`);
    state.turnStartedAt = Date.now();
    armTurnTimeout(room);
    checkGameOver(room);
    return true;
  }

  if (state.table.length === 0) {
    if (pId !== attId) {
      getIO().to(pId).emit('error_msg', 'Сейчас ход другого игрока'); return false;
    }
  } else {
    if (pIdx !== state.currentThrowerIdx) {
      getIO().to(pId).emit('error_msg', 'Сейчас не ваша очередь подкидывать'); return false;
    }
    if (!state.table.every(p => p.defense !== null)) {
      getIO().to(pId).emit('error_msg', 'Дождитесь, пока защищающийся отобьётся'); return false;
    }
    const ranks = getTableRanks(state.table);
    if (!ranks.has(card.rank)) {
      getIO().to(pId).emit('error_msg', 'Такого достоинства нет на столе'); return false;
    }
    if (state.table.length >= maxTablePairs(state)) {
      getIO().to(pId).emit('error_msg', 'Больше подкидывать нельзя'); return false;
    }
  }
  hand.splice(idx, 1);
  state.table.push({ attack: card, defense: null, attackerId: pId });
  state.currentThrowerIdx = pIdx;
  logMove(state, `${pName}: ${card.rank}${card.suit}`);
  state.turnStartedAt = Date.now();
  armTurnTimeout(room);
  checkGameOver(room);
  return true;
}

function handlePass(room, pId) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);
  if (pIdx === -1 || pIdx !== state.currentThrowerIdx) return false;
  if (state.table.length === 0) {
    getIO().to(pId).emit('error_msg', 'На столе пусто'); return false;
  }
  if (!state.table.every(p => p.defense !== null)) {
    getIO().to(pId).emit('error_msg', 'Сначала нужно отбить все карты'); return false;
  }
  const next = findNextThrower(state, state.currentThrowerIdx);
  if (next === -1) return handleDone(room, pId);
  state.currentThrowerIdx = next;
  state.turnStartedAt = Date.now();
  armTurnTimeout(room);
  return true;
}

function handleTake(room, pId) {
  const state = room.state;
  const defId = state.playersInfo[state.defenderIdx].id;
  if (pId !== defId) {
    getIO().to(pId).emit('error_msg', 'Брать может только защищающийся'); return false;
  }
  if (state.table.length === 0) {
    getIO().to(pId).emit('error_msg', 'На столе нет карт'); return false;
  }
  const takenCount = state.table.reduce((s, p) => s + (p.defense ? 2 : 1), 0);
  for (const p of state.table) {
    state.hands[pId].push(p.attack);
    if (p.defense) state.hands[pId].push(p.defense);
  }
  state.table = [];
  sortHand(state.hands[pId], state.trumpSuit);
  const pName = state.playersInfo[state.defenderIdx].name;
  logMove(state, `${pName}: БЕРУ (${takenCount} карт)`);

  const oldDef = state.defenderIdx;
  state.attackerIdx = (oldDef + 1) % state.playersInfo.length;
  state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
  state.currentThrowerIdx = state.attackerIdx;
  refillAllHands(state);
  if (checkGameOver(room)) return true;
  advanceAttackerToNonEmpty(state);
  state.turnStartedAt = Date.now();
  armTurnTimeout(room);
  return true;
}

function handleDone(room, pId) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);
  const defId = state.playersInfo[state.defenderIdx].id;
  if (pIdx === -1 || pIdx !== state.currentThrowerIdx) {
    getIO().to(pId).emit('error_msg', 'Сейчас не ваш ход'); return false;
  }
  if (pId === defId) {
    getIO().to(pId).emit('error_msg', 'Защищающийся не может сказать «Бито»'); return false;
  }
  if (state.table.length === 0 || !state.table.every(p => p.defense !== null)) {
    getIO().to(pId).emit('error_msg', 'Не все карты отбиты'); return false;
  }
  state.table = [];
  const pName = state.playersInfo[pIdx].name;
  logMove(state, `${pName}: БИТО`);

  const oldDef = state.defenderIdx;
  state.attackerIdx = oldDef;
  state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
  state.currentThrowerIdx = state.attackerIdx;
  refillAllHands(state);
  if (checkGameOver(room)) return true;
  advanceAttackerToNonEmpty(state);
  state.turnStartedAt = Date.now();
  armTurnTimeout(room);
  return true;
}

function refillAllHands(state) {
  const n = state.playersInfo.length;
  for (let i = 0; i < n; i++) {
    const idx = (state.attackerIdx + i) % n;
    const pId = state.playersInfo[idx].id;
    if (!state.hands[pId]) state.hands[pId] = [];
    while (state.hands[pId].length < 6 && state.deck.length > 0) {
      state.hands[pId].push(state.deck.shift());
    }
    sortHand(state.hands[pId], state.trumpSuit);
  }
}

function checkGameOver(room) {
  const state = room.state;
  if (state.isGameOver) return true;
  if (state.deck.length > 0) return false;
  const withCards = state.playersInfo.filter(p => handLen(state, p.id) > 0);
  if (withCards.length === 0) {
    state.isGameOver = true;
    state.loser = null;
    state.winners = state.playersInfo.map(p => p.id);
    getIO().to(room.id).emit('game_over', { state, winners: state.winners, loser: null });
    startRematchCountdown(room);
    return true;
  }
  if (withCards.length === 1) {
    state.isGameOver = true;
    state.loser = withCards[0].id;
    state.winners = state.playersInfo.filter(p => p.id !== state.loser).map(p => p.id);
    getIO().to(room.id).emit('game_over', { state, winners: state.winners, loser: state.loser });
    startRematchCountdown(room);
    return true;
  }
  return false;
}

function armTurnTimeout(room) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  room.turnTimeout = setTimeout(() => {
    if (!room.state || room.state.isGameOver) return;
    const st = room.state;
    const defId = st.playersInfo[st.defenderIdx].id;
    let changed = false;
    if (st.table.some(p => !p.defense)) {
      changed = handleTake(room, defId);
    } else if (st.table.length > 0) {
      const th = st.playersInfo[st.currentThrowerIdx].id;
      changed = handleDone(room, th);
    }
    if (changed) {
      broadcastState(room);
      scheduleBotTurn(room);
    } else {
      st.turnStartedAt = Date.now();
      armTurnTimeout(room);
    }
  }, TURN_TIMEOUT_MS);
}

function pickDefenseCard(hand, attCard, trumpSuit, difficulty) {
  const valid = hand.filter(c => canBeat(attCard, c, trumpSuit));
  if (!valid.length) return null;
  if (difficulty === 'easy') return valid[0];
  const attIsTrump = attCard.suit === trumpSuit;
  let best = null, bestScore = Infinity;
  for (const c of valid) {
    const isT = c.suit === trumpSuit;
    let score = isT ? 100 + c.value : c.value;
    if (difficulty === 'hard' && isT && !attIsTrump && c.value > 10) score += 50;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function pickAttackCard(hand, trumpSuit, deckSize, difficulty) {
  if (!hand.length) return null;
  const nonT = hand.filter(c => c.suit !== trumpSuit);
  const t = hand.filter(c => c.suit === trumpSuit);
  if (difficulty === 'easy') {
    const pool = nonT.length ? nonT : t;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (difficulty === 'hard') {
    const late = deckSize < 10;
    if (nonT.length) {
      nonT.sort((a, b) => late ? b.value - a.value : a.value - b.value);
      return nonT[0];
    }
    t.sort((a, b) => a.value - b.value);
    return t[0] || null;
  }
  if (nonT.length) { nonT.sort((a, b) => a.value - b.value); return nonT[0]; }
  t.sort((a, b) => a.value - b.value);
  return t[0] || null;
}

function pickThrowCard(matches, trumpSuit, difficulty) {
  if (!matches.length) return null;
  const sorted = [...matches].sort((a, b) => {
    const aT = a.suit === trumpSuit ? 1 : 0;
    const bT = b.suit === trumpSuit ? 1 : 0;
    if (aT !== bT) return aT - bT;
    return a.value - b.value;
  });
  if (difficulty === 'easy') return matches[0];
  if (difficulty === 'hard' && Math.random() < 0.2 && sorted.length > 1)
    return sorted[sorted.length - 1];
  return sorted[0];
}

function executeBotTurnChain(room) {
  if (!room || !room.state || room.state.isGameOver) return false;
  const state = room.state;
  const defP = state.playersInfo[state.defenderIdx];
  const n = state.playersInfo.length;
  const hasCards = id => handLen(state, id) > 0;
  const unIdx = state.table.findIndex(p => p.defense === null);

  if (unIdx !== -1) {
    if (!defP.isBot) return false;
    const attCard = state.table[unIdx].attack;
    const hand = state.hands[defP.id] || [];
    const card = pickDefenseCard(hand, attCard, state.trumpSuit, defP.botDifficulty);
    if (card) return handlePlayCard(room, defP.id, card.id);
    return handleTake(room, defP.id);
  }

  if (state.table.length === 0) {
    if (!advanceAttackerToNonEmpty(state)) { checkGameOver(room); return false; }
    if (checkGameOver(room)) return false;
    const att = state.playersInfo[state.attackerIdx];
    if (!att.isBot) return false;
    const card = pickAttackCard(state.hands[att.id], state.trumpSuit, state.deck.length, att.botDifficulty);
    if (!card) return false;
    return handlePlayCard(room, att.id, card.id);
  }

  const tRanks = getTableRanks(state.table);
  const canAdd = state.table.length < maxTablePairs(state);

  let cur = state.currentThrowerIdx;
  for (let i = 0; i < n; i++) {
    const p = state.playersInfo[cur];
    if (p.id !== defP.id && hasCards(p.id)) break;
    cur = (cur + 1) % n;
  }
  state.currentThrowerIdx = cur;
  const curP = state.playersInfo[cur];
  if (!curP.isBot) return false;

  const hand = state.hands[curP.id] || [];
  const matches = hand.filter(c => tRanks.has(c.rank));
  if (matches.length && canAdd) {
    const card = pickThrowCard(matches, state.trumpSuit, curP.botDifficulty);
    if (card && handlePlayCard(room, curP.id, card.id)) return true;
  }

  const others = state.playersInfo.some((p, i) =>
    i !== cur && p.id !== defP.id && hasCards(p.id) &&
    (state.hands[p.id] || []).some(c => tRanks.has(c.rank))
  );
  if (!others || !canAdd) return handleDone(room, curP.id);

  const next = (cur + 1) % n;
  state.currentThrowerIdx = next === state.defenderIdx ? (next + 1) % n : next;
  return true;
}

function scheduleBotTurn(room) {
  if (!room || !room.state || room.state.isGameOver) return;
  if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
  room.botLoopTimeout = setTimeout(() => {
    if (!room || !room.state || room.state.isGameOver) return;
    const acted = executeBotTurnChain(room);
    if (acted) {
      broadcastState(room);
      if (!room.state.isGameOver) scheduleBotTurn(room);
    }
  }, 700);
}

function broadcastState(room) {
  if (!room.state) return;
  for (const target of room.players) {
    if (target.isBot) continue;
    const copy = JSON.parse(JSON.stringify(room.state));
    copy.deck = (room.state.deck || []).map(() => ({}));
    copy.moveCount = (room.state.moveLog || []).length;
    delete copy.moveLog;

    const realHands = {};
    for (const p of room.players) {
      realHands[p.id] = p.id === target.id
        ? (room.state.hands[p.id] || [])
        : new Array(handLen(room.state, p.id)).fill({});
    }
    copy.hands = realHands;
    copy.playersInfo.forEach(info => { info.isYou = info.id === target.id; });
    getIO().to(target.id).emit('game_update', copy);
  }
}

function generateRoomCode() {
  let code, attempts = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
    if (++attempts > 9000) throw new Error('No free room codes');
  } while (rooms[code]);
  return code;
}

function updateLobby(room) {
  const humans = room.players.filter(p => !p.isBot).length;
  getIO().to(room.id).emit('lobby_update', {
    code: room.id, current: room.players.length,
    max: room.maxPlayers, humanCount: humans
  });
}

function fillRoomWithBots(room, difficulty) {
  const names = ['Бот Валера', 'Бот Степан', 'Бот Гриша'];
  let i = 0;
  while (room.players.length < room.maxPlayers) {
    room.players.push({
      id: 'BOT_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      isBot: true, name: names[i++ % names.length], botDifficulty: difficulty
    });
  }
}

function startRematchCountdown(room) {
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  room.rematchVotes.clear();
  let t = 15;
  getIO().to(room.id).emit('rematch_timer', t);
  room.rematchTimer = setInterval(() => {
    t--;
    getIO().to(room.id).emit('rematch_timer', t);
    if (t <= 0) {
      clearInterval(room.rematchTimer);
      const humans = room.players.filter(p => !p.isBot);
      if (humans.length > 0 && room.rematchVotes.size >= humans.length) {
        startRematch(room);
      } else {
        getIO().to(room.id).emit('room_expired');
        delete rooms[room.id];
      }
    }
  }, 1000);
}

function startRematch(room) {
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  initGameState(room);
  getIO().to(room.id).emit('game_restarted');
  broadcastState(room);
  scheduleBotTurn(room);
}

function attachHandlers(socket) {
  socket.on('create_room', data => {
    let maxPlayers = 2, playerName = 'Игрок 1';
    if (data && typeof data === 'object') {
      maxPlayers = parseInt(data.maxPlayers) || 2;
      if (data.playerName) playerName = String(data.playerName).trim().slice(0, 12);
    }
    maxPlayers = Math.max(2, Math.min(4, maxPlayers));
    let code;
    try { code = generateRoomCode(); }
    catch { socket.emit('error_msg', 'Сервер перегружен'); return; }

    const room = {
      id: code, maxPlayers,
      players: [{ id: socket.id, isBot: false, name: playerName || 'Игрок 1' }],
      state: null, rematchVotes: new Set(),
      rematchTimer: null, botLoopTimeout: null, turnTimeout: null
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code, maxPlayers });
    updateLobby(room);
  });

  socket.on('join_room', data => {
    let code = '', playerName = '';
    if (data && typeof data === 'object') {
      code = data.roomCode || '';
      playerName = data.playerName || '';
    } else if (typeof data === 'string') code = data;
    code = String(code).trim();
    if (!/^\d{4}$/.test(code)) { socket.emit('error_msg', 'Код комнаты — 4 цифры'); return; }
    const room = rooms[code];
    if (!room) { socket.emit('error_msg', 'Комната не найдена'); return; }
    if (room.state) { socket.emit('error_msg', 'Игра уже началась'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error_msg', 'Комната заполнена'); return; }

    const name = String(playerName || `Игрок ${room.players.length + 1}`).trim().slice(0, 12);
    room.players.push({ id: socket.id, isBot: false, name });
    socket.join(code);
    socket.roomCode = code;
    updateLobby(room);
    if (room.players.length === room.maxPlayers) {
      initGameState(room);
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('play_with_bots', data => {
    let playerName = 'Вы', botDifficulty = 'normal';
    if (data && typeof data === 'object') {
      if (data.playerName) playerName = String(data.playerName).trim().slice(0, 12);
      if (['easy', 'normal', 'hard'].includes(data.botDifficulty)) botDifficulty = data.botDifficulty;
    }
    const code = 'BOTS_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const room = {
      id: code, maxPlayers: 2,
      players: [{ id: socket.id, isBot: false, name: playerName || 'Вы' }],
      state: null, rematchVotes: new Set(),
      rematchTimer: null, botLoopTimeout: null, turnTimeout: null,
      botDifficulty
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    fillRoomWithBots(room, botDifficulty);
    initGameState(room);
    broadcastState(room);
    scheduleBotTurn(room);
  });

  socket.on('player_action', ({ roomCode, action, cardId }) => {
    const room = rooms[roomCode];
    if (!room || !room.state || room.state.isGameOver) return;
    if (!room.players.find(p => p.id === socket.id)) return;
    if (room.botLoopTimeout) { clearTimeout(room.botLoopTimeout); room.botLoopTimeout = null; }
    if (room.turnTimeout)    { clearTimeout(room.turnTimeout);    room.turnTimeout = null; }

    let ok = false;
    if (action === 'play_card')      ok = handlePlayCard(room, socket.id, cardId);
    else if (action === 'take')      ok = handleTake(room, socket.id);
    else if (action === 'done')      ok = handleDone(room, socket.id);
    else if (action === 'pass')      ok = handlePass(room, socket.id);

    if (ok) {
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('emoji', ({ roomCode, emoji }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players.find(p => p.id === socket.id)) return;
    const clean = String(emoji || '').slice(0, 8);
    getIO().to(room.id).emit('emoji', { playerId: socket.id, emoji: clean });
  });

  socket.on('send_message', ({ roomCode, message }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const clean = String(message || '').trim().slice(0, 150);
    if (!clean) return;
    getIO().to(room.id).emit('chat_message', {
      senderId: socket.id, senderName: player.name, message: clean
    });
  });

  socket.on('vote_rematch', roomCode => {
    const room = rooms[roomCode];
    if (!room || !room.state || !room.state.isGameOver) return;
    room.rematchVotes.add(socket.id);
    const humans = room.players.filter(p => !p.isBot);
    getIO().to(room.id).emit('rematch_voted', {
      votesCount: room.rematchVotes.size, totalNeeded: humans.length
    });
    if (room.rematchVotes.size >= humans.length) {
      if (room.rematchTimer) clearInterval(room.rematchTimer);
      startRematch(room);
    }
  });

  socket.on('client_ready', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) broadcastState(rooms[code]);
  });

  socket.on('leave_room', roomCode => {
    const room = rooms[roomCode];
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    if (room.rematchTimer) clearInterval(room.rematchTimer);
    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
    if (room.turnTimeout) clearTimeout(room.turnTimeout);
    socket.leave(roomCode);
    socket.roomCode = null;
    room.players.splice(idx, 1);
    const humans = room.players.filter(p => !p.isBot).length;
    if (humans === 0) delete rooms[roomCode];
    else if (room.state && !room.state.isGameOver) {
      getIO().to(roomCode).emit('opponent_disconnected');
      delete rooms[roomCode];
    } else updateLobby(room);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    if (room.rematchTimer) clearInterval(room.rematchTimer);
    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
    if (room.turnTimeout) clearTimeout(room.turnTimeout);
    room.players.splice(idx, 1);
    const humans = room.players.filter(p => !p.isBot).length;
    if (humans === 0) delete rooms[code];
    else if (room.state && !room.state.isGameOver) {
      getIO().to(code).emit('opponent_disconnected');
      delete rooms[code];
    } else updateLobby(room);
  });
}

function createApp() {
  const app = express();
  const httpServer = http.createServer(app);
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  const socketServer = new Server(httpServer, {
    cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
    pingTimeout: 60000, pingInterval: 25000
  });
  app.use(express.static(__dirname));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  socketServer.on('connection', attachHandlers);
  return { app, httpServer, socketServer };
}

if (require.main === module) {
  const { httpServer, socketServer } = createApp();
  setIO(socketServer);
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => console.log(`[Сервер] http://localhost:${PORT}`));
}

module.exports = {
  RANKS, SUITS,
  createDeck, shuffleDeck, sortHand, canBeat,
  getTableRanks,
  initGameState, refillAllHands, checkGameOver,
  handlePlayCard, handleTake, handleDone, handlePass,
  executeBotTurnChain, scheduleBotTurn,
  broadcastState, setIO, createApp
};