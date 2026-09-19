'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const PORT = Number(process.env.PORT || 3000);
const TURN_MS = 30_000;
const ROOM_TTL_MS = 5 * 60_000;
const REMATCH_TTL_MS = 60_000;
const MAX_MESSAGE = 150;
const MAX_NAME = 12;

// Serve the supplied client as the application entry point.
app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'sani-group-durak' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = new Map();
const socketRoom = new Map();
const playerSessions = new Map();

const RANKS = [
  ['6', 6], ['7', 7], ['8', 8], ['9', 9], ['10', 10],
  ['J', 11], ['Q', 12], ['K', 13], ['A', 14]
];
const SUITS = ['♠', '♥', '♦', '♣'];

function makeDeck() {
  let id = 1;
  const deck = [];
  for (const suit of SUITS) {
    for (const [rank, value] of RANKS) deck.push({ id: id++, suit, rank, value });
  }
  return shuffle(deck);
}

function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

function safeName(v) {
  return String(v || 'Игрок').replace(/[<>]/g, '').trim().slice(0, MAX_NAME) || 'Игрок';
}
function roomKey(code) { return String(code); }
function uniqueRoomCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('Не удалось создать код комнаты');
}
function activePlayers(room) { return room.players.filter(p => !p.eliminated); }
function nextIdx(room, from, { includeFrom = false, predicate = () => true } = {}) {
  const n = room.players.length;
  for (let step = includeFrom ? 0 : 1; step <= n; step++) {
    const idx = (from + step) % n;
    const p = room.players[idx];
    if (p && !p.eliminated && predicate(p, idx)) return idx;
  }
  return -1;
}
function playerBySocket(room, socketId) { return room.players.find(p => p.socketId === socketId); }
function idxBySocket(room, socketId) { return room.players.findIndex(p => p.socketId === socketId); }
function getPlayer(room, idx) { return room.players[idx]; }
function isHuman(p) { return !!p && !p.isBot; }

function lowestTrumpPlayer(room) {
  let best = null;
  for (const p of room.players) {
    if (p.eliminated) continue;
    for (const c of p.hand) {
      if (c.suit !== room.trumpSuit) continue;
      if (!best || c.value < best.value) best = { idx: p.idx, value: c.value };
    }
  }
  if (best) return best.idx;
  let fallback = null;
  for (const p of room.players) {
    if (p.eliminated || !p.hand.length) continue;
    const c = p.hand.reduce((a, b) => a.value < b.value ? a : b);
    if (!fallback || c.value < fallback.value) fallback = { idx: p.idx, value: c.value };
  }
  return fallback ? fallback.idx : 0;
}

function canBeat(att, def, trumpSuit) {
  if (!att || !def) return false;
  const aT = att.suit === trumpSuit;
  const dT = def.suit === trumpSuit;
  if (aT && !dT) return false;
  if (aT && dT) return def.value > att.value;
  if (!dT) return att.suit === def.suit && def.value > att.value;
  return true;
}

function tableRanks(room) {
  const set = new Set();
  for (const pair of room.table) {
    if (pair.attack) set.add(pair.attack.rank);
    if (pair.defense) set.add(pair.defense.rank);
  }
  return set;
}
function allDefended(room) {
  return room.table.length > 0 && room.table.every(x => x.defense);
}
function uncoveredPair(room) { return room.table.find(x => !x.defense); }
function attackLimit(room) {
  const defender = getPlayer(room, room.defenderIdx);
  return Math.min(6, defender ? defender.hand.length : 6);
}
function eligibleThrowers(room) {
  return room.players.filter((p, idx) => !p.eliminated && idx !== room.defenderIdx && p.hand.length > 0);
}
function nextThrower(room, from) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    const p = room.players[idx];
    if (!p || p.eliminated || idx === room.defenderIdx || !p.hand.length) continue;
    if (!room.passed.has(idx)) return idx;
  }
  return -1;
}

function resetTurnTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnStartedAt = Date.now();
  room.turnTimer = setTimeout(() => autoTimeout(room), TURN_MS + 50);
}

function clearTurnTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
}

function emitError(socket, msg) { socket.emit('error_msg', String(msg)); }
function broadcastRoom(room, event, payload) { io.to(room.code).emit(event, payload); }

function publicState(room, socketId) {
  const myIdx = idxBySocket(room, socketId);
  const hands = {};
  for (const p of room.players) {
    if (p.socketId === socketId) hands[p.id] = p.hand.map(cloneCard);
    else hands[p.id] = Array(p.hand.length).fill(null);
  }
  return {
    roomCode: room.code,
    sessionId: room.players[myIdx]?.sessionId || null,
    playersInfo: room.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      isYou: idx === myIdx,
      eliminated: !!p.eliminated
    })),
    hands,
    handCounts: Object.fromEntries(room.players.map(p => [p.id, p.hand.length])),
    deck: room.deck.map(cloneCard),
    trumpCard: (room.trumpCard && room.deck.some(c => c.id === room.trumpCard.id)) ? cloneCard(room.trumpCard) : null,
    trumpSuit: room.trumpSuit,
    table: room.table.map(pair => ({ attack: cloneCard(pair.attack), defense: pair.defense ? cloneCard(pair.defense) : null })),
    currentThrowerIdx: room.currentThrowerIdx,
    defenderIdx: room.defenderIdx,
    pendingTake: room.pendingTake,
    isGameOver: room.isGameOver,
    turnStartedAt: room.turnStartedAt,
    moveLog: room.moveLog.slice(-100),
    round: room.round,
    phase: room.phase,
    myIdx,
    finished: room.finishOrder.slice()
  };
}
function cloneCard(c) { return c ? { id: c.id, suit: c.suit, rank: c.rank, value: c.value } : null; }

function sendState(room) {
  for (const p of room.players) {
    if (p.socketId && io.sockets.sockets.get(p.socketId)) {
      io.to(p.socketId).emit('game_update', publicState(room, p.socketId));
    }
  }
}

function logMove(room, text) {
  room.moveLog.push({ at: Date.now(), text });
  if (room.moveLog.length > 200) room.moveLog.shift();
}

function addCard(room, player, card) {
  player.hand.push(card);
}
function removeCard(player, cardId) {
  const i = player.hand.findIndex(c => c.id === Number(cardId));
  if (i < 0) return null;
  return player.hand.splice(i, 1)[0];
}

function drawToSix(room) {
  if (!room.deck.length) return;
  // Common Durak draw order: starting attacker first, defender last.
  const order = [];
  const start = room.nextAttackerIdx >= 0 ? room.nextAttackerIdx : room.currentThrowerIdx;
  if (start >= 0) {
    for (let step = 0; step < room.players.length; step++) {
      const idx = (start + step) % room.players.length;
      if (!room.players[idx].eliminated) order.push(idx);
    }
  }
  for (const idx of order) {
    const p = room.players[idx];
    while (p.hand.length < 6 && room.deck.length) addCard(room, p, room.deck.shift());
  }
}

function markFinished(room) {
  if (room.deck.length > 0) return;
  for (const p of room.players) {
    if (!p.eliminated && p.hand.length === 0 && !room.finishOrder.includes(p.idx)) {
      room.finishOrder.push(p.idx);
      p.finishedAt = Date.now();
    }
  }
  const remaining = room.players.filter(p => !p.eliminated && p.hand.length > 0);
  if (remaining.length <= 1) finishGame(room);
  else if (remaining.length === 0) finishGame(room);
}

function finishGame(room) {
  if (room.isGameOver) return;
  room.isGameOver = true;
  room.phase = 'game_over';
  clearTurnTimer(room);
  const remaining = room.players.filter(p => p.hand.length > 0 && !p.eliminated);
  const winners = room.players.filter(p => p.hand.length === 0).map(p => p.id);
  const losers = remaining.map(p => p.id);
  if (!winners.length) {
    const last = room.finishOrder[room.finishOrder.length - 1];
    if (last != null) winners.push(room.players[last].id);
  }
  room.result = { winners, losers, finishOrder: room.finishOrder.map(i => room.players[i].id) };
  broadcastRoom(room, 'game_over', room.result);
  sendState(room);
  room.rematchVotes.clear();
  room.rematchExpiresAt = Date.now() + REMATCH_TTL_MS;
  clearTimeout(room.rematchTimer);
  let left = Math.ceil(REMATCH_TTL_MS / 1000);
  const countdown = setInterval(() => {
    if (!room.isGameOver || !rooms.has(room.code)) return clearInterval(countdown);
    left -= 1;
    if (left > 0 && left % 5 === 0) broadcastRoom(room, 'rematch_timer', left);
  }, 1000);
  room.rematchTimer = setTimeout(() => {
    clearInterval(countdown);
    if (!room.isGameOver) return;
    broadcastRoom(room, 'room_expired');
    deleteRoom(room.code);
  }, REMATCH_TTL_MS);
}

function prepareNextRound(room) {
  // Finished players are no longer part of the active rotation once the deck is empty.
  markFinished(room);
  if (room.isGameOver) return;

  room.table = [];
  room.pendingTake = false;
  room.passed.clear();
  room.round += 1;
  room.phase = 'attack';

  drawToSix(room);
  markFinished(room);
  if (room.isGameOver) return;

  const nextAttacker = room.nextAttackerIdx >= 0 && !room.players[room.nextAttackerIdx].eliminated
    ? room.nextAttackerIdx
    : nextIdx(room, room.defenderIdx);
  room.currentThrowerIdx = nextAttacker >= 0 ? nextAttacker : lowestTrumpPlayer(room);
  room.defenderIdx = nextIdx(room, room.currentThrowerIdx);
  if (room.defenderIdx < 0) return finishGame(room);
  resetTurnTimer(room);
  sendState(room);
  scheduleBot(room);
}

function completeSuccessfulDefense(room) {
  const oldDef = room.defenderIdx;
  // Defender becomes the next attacker; the player to their left becomes defender.
  room.nextAttackerIdx = oldDef;
  room.table = [];
  room.pendingTake = false;
  room.passed.clear();
  room.currentThrowerIdx = oldDef;
  room.defenderIdx = nextIdx(room, oldDef);
  room.phase = 'attack';
  if (room.defenderIdx < 0) return finishGame(room);
  drawToSix(room);
  markFinished(room);
  if (room.isGameOver) return;
  resetTurnTimer(room);
  logMove(room, 'Раунд завершён: отбито');
  sendState(room);
  scheduleBot(room);
}

function defenderTake(room) {
  if (room.isGameOver) throw new Error('Партия уже завершена');
  if (room.pendingTake || room.phase === 'take') throw new Error('Карту уже забрали');
  const def = getPlayer(room, room.defenderIdx);
  if (!def) throw new Error('Защищающийся не найден');
  if (!uncoveredPair(room)) throw new Error('Сейчас нельзя взять');
  // Важно: переводим стол в состояние TAKE только один раз.
  // Повторный клик по БЕРУ больше не может повторно добавить те же карты в руку.
  for (const pair of room.table) {
    if (pair.attack) def.hand.push(pair.attack);
    if (pair.defense) def.hand.push(pair.defense);
  }
  room.pendingTake = true;
  room.phase = 'take';
  room.passed.clear();
  // Allow every non-defender with cards to throw in; rotate from the original attacker.
  room.currentThrowerIdx = nextIdx(room, room.defenderIdx, { predicate: p => !p.eliminated && p.hand.length > 0 });
  resetTurnTimer(room);
  logMove(room, `${def.name} — БЕРУ`);
  sendState(room);
  scheduleBot(room);
}

function finishTakePhase(room) {
  // All remaining table cards are discarded after the defender takes them.
  room.table = [];
  room.pendingTake = false;
  room.passed.clear();
  room.nextAttackerIdx = nextIdx(room, room.defenderIdx);
  room.currentThrowerIdx = room.nextAttackerIdx;
  room.defenderIdx = nextIdx(room, room.currentThrowerIdx);
  room.phase = 'attack';
  drawToSix(room);
  markFinished(room);
  if (room.isGameOver) return;
  resetTurnTimer(room);
  logMove(room, 'Подкидывание после БЕРУ завершено');
  sendState(room);
  scheduleBot(room);
}

function playCard(room, p, cardId) {
  if (room.isGameOver) throw new Error('Партия уже завершена');
  const idx = p.idx;
  if (idx === room.defenderIdx) {
    const pair = uncoveredPair(room);
    if (!pair) throw new Error('Сейчас нельзя отбиваться');
    const card = p.hand.find(c => c.id === Number(cardId));
    if (!card) throw new Error('Карта не найдена');
    if (!canBeat(pair.attack, card, room.trumpSuit)) throw new Error('Этой картой нельзя отбить');
    removeCard(p, card.id);
    pair.defense = card;
    room.phase = 'defense';
    logMove(room, `${p.name} отбился ${card.rank}${card.suit}`);
    if (allDefended(room)) {
      room.currentThrowerIdx = nextIdx(room, room.currentThrowerIdx, { predicate: (q, qidx) => qidx !== room.defenderIdx && q.hand.length > 0 });
      if (room.currentThrowerIdx < 0) return completeSuccessfulDefense(room);
      room.passed.clear();
      room.phase = 'throw';
    } else {
      room.currentThrowerIdx = room.defenderIdx;
    }
    resetTurnTimer(room);
    sendState(room);
    scheduleBot(room);
    return;
  }

  const card = p.hand.find(c => c.id === Number(cardId));
  if (!card) throw new Error('Карта не найдена');
  const ranks = tableRanks(room);
  if (room.table.length === 0) {
    if (idx !== room.currentThrowerIdx) throw new Error('Сейчас ходит другой игрок');
    removeCard(p, card.id);
    room.table.push({ attack: card, defense: null });
    room.phase = 'defense';
    logMove(room, `${p.name} атакует ${card.rank}${card.suit}`);
    resetTurnTimer(room);
    sendState(room);
    scheduleBot(room);
    return;
  }

  if (!allDefended(room) && !room.pendingTake) throw new Error('Сначала защитник должен отбиться или взять');
  if (idx === room.defenderIdx) throw new Error('Защищающийся не подкидывает');
  if (idx !== room.currentThrowerIdx) throw new Error('Сейчас подкидывает другой игрок');
  if (room.table.length >= attackLimit(room)) throw new Error('Достигнут лимит подкидывания');
  if (!ranks.has(card.rank)) throw new Error('Можно подкинуть только карту подходящего достоинства');

  removeCard(p, card.id);
  room.table.push({ attack: card, defense: null });
  room.pendingTake = false;
  room.phase = 'defense';
  room.passed.clear();
  room.currentThrowerIdx = room.defenderIdx;
  logMove(room, `${p.name} подкинул ${card.rank}${card.suit}`);
  resetTurnTimer(room);
  sendState(room);
  scheduleBot(room);
}

function pass(room, p) {
  if (room.isGameOver) return;
  const idx = p.idx;
  if (idx === room.defenderIdx) throw new Error('Защищающийся не может пасовать');
  if (!room.table.length) throw new Error('Нечего завершать');
  if (!allDefended(room) && !room.pendingTake) throw new Error('Сначала нужно отбиться или взять');
  if (idx !== room.currentThrowerIdx) throw new Error('Сейчас очередь другого игрока');
  room.passed.add(idx);
  const next = nextThrower(room, idx);
  if (next >= 0) {
    room.currentThrowerIdx = next;
    resetTurnTimer(room);
    sendState(room);
    scheduleBot(room);
    return;
  }
  if (room.pendingTake) finishTakePhase(room);
  else completeSuccessfulDefense(room);
}

function done(room, p) {
  // In 2-player mode this is equivalent to passing after a fully defended table.
  // In multiplayer it passes the current thrower's chance, preserving other players' turns.
  pass(room, p);
}

function autoTimeout(room) {
  if (room.isGameOver) return;
  const p = getPlayer(room, room.currentThrowerIdx);
  if (!p) return;
  try {
    if (room.defenderIdx === p.idx && uncoveredPair(room)) defenderTake(room);
    else if (room.table.length && (allDefended(room) || room.pendingTake)) pass(room, p);
    else if (!room.table.length) {
      const card = chooseBotCard(room, p, true);
      if (card) playCard(room, p, card.id);
    }
  } catch (e) {
    logMove(room, `Автоход: ${e.message}`);
    resetTurnTimer(room);
    sendState(room);
    scheduleBot(room);
  }
}

function chooseBotCard(room, p, attackFirst = false) {
  const hand = [...p.hand];
  if (room.defenderIdx === p.idx) {
    const pair = uncoveredPair(room);
    if (!pair) return null;
    const legal = hand.filter(c => canBeat(pair.attack, c, room.trumpSuit));
    if (!legal.length) return null;
    if (p.difficulty === 'easy') return legal[Math.floor(Math.random() * legal.length)];
    legal.sort((a, b) => (a.suit === room.trumpSuit) - (b.suit === room.trumpSuit) || a.value - b.value);
    return p.difficulty === 'hard' ? legal[0] : legal[Math.min(1, legal.length - 1)];
  }
  if (!room.table.length) {
    hand.sort((a, b) => (a.suit === room.trumpSuit) - (b.suit === room.trumpSuit) || a.value - b.value);
    if (p.difficulty === 'easy') return hand[Math.floor(Math.random() * hand.length)];
    return hand[0];
  }
  const ranks = tableRanks(room);
  const legal = hand.filter(c => ranks.has(c.rank) && room.table.length < attackLimit(room));
  if (!legal.length) return null;
  legal.sort((a, b) => (a.suit === room.trumpSuit) - (b.suit === room.trumpSuit) || a.value - b.value);
  return p.difficulty === 'hard' ? legal[0] : legal[Math.min(1, legal.length - 1)];
}

function scheduleBot(room) {
  if (room.isGameOver) return;
  const p = getPlayer(room, room.currentThrowerIdx);
  if (!p || !p.isBot) return;
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => botAct(room), 450 + Math.random() * 650);
}
function botAct(room) {
  if (room.isGameOver) return;
  const p = getPlayer(room, room.currentThrowerIdx);
  if (!p || !p.isBot) return;
  try {
    if (p.idx === room.defenderIdx) {
      const c = chooseBotCard(room, p);
      if (c) playCard(room, p, c.id);
      else defenderTake(room);
      return;
    }
    const c = chooseBotCard(room, p);
    if (c) playCard(room, p, c.id);
    else pass(room, p);
  } catch (e) {
    logMove(room, `Бот: ${e.message}`);
    try { pass(room, p); } catch { resetTurnTimer(room); }
  }
}

function startGame(room) {
  if (room.started || room.players.length < 2) return;
  room.started = true;
  room.isGameOver = false;
  room.deck = makeDeck();
  room.trumpCard = room.deck[room.deck.length - 1];
  room.trumpSuit = room.trumpCard.suit;
  room.table = [];
  room.moveLog = [];
  room.finishOrder = [];
  room.round = 1;
  room.pendingTake = false;
  room.passed.clear();
  for (const p of room.players) p.hand = [];
  for (let i = 0; i < 6; i++) {
    for (const p of room.players) p.hand.push(room.deck.shift());
  }
  room.currentThrowerIdx = lowestTrumpPlayer(room);
  room.nextAttackerIdx = room.currentThrowerIdx;
  room.defenderIdx = nextIdx(room, room.currentThrowerIdx);
  room.phase = 'attack';
  resetTurnTimer(room);
  logMove(room, `Партия началась. Козырь ${room.trumpSuit}`);
  sendState(room);
  scheduleBot(room);
}

function makeRoom(code, maxPlayers) {
  return {
    code,
    maxPlayers: Math.max(2, Math.min(4, Number(maxPlayers) || 2)),
    players: [],
    started: false,
    isGameOver: false,
    deck: [],
    trumpCard: null,
    trumpSuit: null,
    table: [],
    currentThrowerIdx: -1,
    defenderIdx: -1,
    nextAttackerIdx: -1,
    pendingTake: false,
    phase: 'lobby',
    turnStartedAt: 0,
    turnTimer: null,
    botTimer: null,
    moveLog: [],
    passed: new Set(),
    finishOrder: [],
    rematchVotes: new Set(),
    rematchTimer: null,
    lastActivity: Date.now(),
    round: 0
  };
}

function joinRoom(socket, room, name, isBot = false, difficulty = 'normal') {
  if (room.started) throw new Error('Партия уже началась');
  if (room.players.length >= room.maxPlayers) throw new Error('Комната заполнена');
  const p = {
    id: `${isBot ? 'bot' : 'p'}_${Math.random().toString(36).slice(2, 10)}`,
    socketId: isBot ? null : socket.id,
    sessionId: isBot ? null : Math.random().toString(36).slice(2) + Date.now().toString(36),
    name: safeName(name),
    isBot,
    difficulty,
    hand: [],
    idx: room.players.length,
    eliminated: false,
    finishedAt: null
  };
  room.players.push(p);
  if (!isBot) {
    socketRoom.set(socket.id, room.code);
    playerSessions.set(p.sessionId, { roomCode: room.code, playerId: p.id });
    socket.join(room.code);
  }
  room.lastActivity = Date.now();
  return p;
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTurnTimer(room);
  clearTimeout(room.botTimer);
  clearTimeout(room.rematchTimer);
  for (const p of room.players) {
    if (p.socketId) socketRoom.delete(p.socketId);
    if (p.sessionId) playerSessions.delete(p.sessionId);
  }
  rooms.delete(code);
}

function lobbyPayload(room) {
  return { code: room.code, current: room.players.length, max: room.maxPlayers };
}

io.on('connection', socket => {
  socket.on('client_ready', ({ sessionId } = {}) => {
    if (sessionId && playerSessions.has(sessionId)) {
      const info = playerSessions.get(sessionId);
      const room = rooms.get(info.roomCode);
      const p = room && room.players.find(x => x.id === info.playerId);
      if (room && p) {
        p.socketId = socket.id;
        p.eliminated = false;
        socketRoom.set(socket.id, room.code);
        socket.join(room.code);
        room.lastActivity = Date.now();
        socket.emit('session_restored', { roomCode: room.code });
        if (room.started) sendState(room);
        else broadcastRoom(room, 'lobby_update', lobbyPayload(room));
        return;
      }
    }
    socket.emit('ready_ok', { ok: true });
  });

  socket.on('create_room', ({ maxPlayers, playerName } = {}) => {
    try {
      const code = uniqueRoomCode();
      const room = makeRoom(code, maxPlayers);
      rooms.set(code, room);
      joinRoom(socket, room, playerName);
      socket.emit('room_created', { code, maxPlayers: room.maxPlayers, sessionId: room.players[0].sessionId });
      broadcastRoom(room, 'lobby_update', lobbyPayload(room));
    } catch (e) { emitError(socket, e.message); }
  });

  socket.on('join_room', ({ roomCode, playerName } = {}) => {
    try {
      const code = roomKey(roomCode).replace(/\D/g, '');
      const room = rooms.get(code);
      if (!room) throw new Error('Комната не найдена');
      const joined = joinRoom(socket, room, playerName);
      socket.emit('session_assigned', { sessionId: joined.sessionId, roomCode: room.code });
      broadcastRoom(room, 'lobby_update', lobbyPayload(room));
      if (room.players.length >= room.maxPlayers) startGame(room);
    } catch (e) { emitError(socket, e.message); }
  });

  socket.on('play_with_bots', ({ playerName, botDifficulty } = {}) => {
    try {
      const code = `BOTS_${socket.id.slice(-6)}`;
      const room = makeRoom(code, 2);
      rooms.set(code, room);
      joinRoom(socket, room, playerName);
      joinRoom(null, room, 'Бот', true, ['easy','normal','hard'].includes(botDifficulty) ? botDifficulty : 'normal');
      startGame(room);
    } catch (e) { emitError(socket, e.message); }
  });

  socket.on('player_action', ({ roomCode, action, cardId } = {}) => {
    try {
      const code = roomKey(roomCode);
      const room = rooms.get(code);
      if (!room) throw new Error('Комната не найдена');
      const p = playerBySocket(room, socket.id);
      if (!p) throw new Error('Вы не участник этой комнаты');
      room.lastActivity = Date.now();
      if (action === 'play_card') playCard(room, p, cardId);
      else if (action === 'take') {
        if (p.idx !== room.defenderIdx || !uncoveredPair(room) || room.pendingTake) throw new Error('Сейчас нельзя взять');
        defenderTake(room);
      } else if (action === 'done' || action === 'pass') pass(room, p);
      else throw new Error('Неизвестное действие');
    } catch (e) { emitError(socket, e.message); }
  });

  socket.on('vote_rematch', roomCode => {
    try {
      const room = rooms.get(roomKey(roomCode));
      if (!room || !room.isGameOver) throw new Error('Реванш сейчас недоступен');
      const p = playerBySocket(room, socket.id);
      if (!p) throw new Error('Вы не участник комнаты');
      room.rematchVotes.add(p.id);
      const total = room.players.filter(x => isHuman(x)).length;
      broadcastRoom(room, 'rematch_voted', { votesCount: room.rematchVotes.size, totalNeeded: total });
      if (room.rematchVotes.size >= total) {
        clearTimeout(room.rematchTimer);
        restartGame(room);
      }
    } catch (e) { emitError(socket, e.message); }
  });

  socket.on('leave_room', roomCode => {
    const room = rooms.get(roomKey(roomCode));
    if (!room) return;
    const p = playerBySocket(room, socket.id);
    if (p) {
      p.socketId = null;
      p.eliminated = true;
      if (p.sessionId) playerSessions.delete(p.sessionId);
      if (!room.started) {
        deleteRoom(room.code);
      } else {
        finishOnDisconnect(room, p);
      }
    }
    socket.leave(room.code);
    socketRoom.delete(socket.id);
  });

  socket.on('emoji', ({ roomCode, emoji } = {}) => {
    const room = rooms.get(roomKey(roomCode));
    if (!room || !playerBySocket(room, socket.id)) return;
    const allowed = ['😂','😎','👍','😱','🎯','🔥'];
    if (!allowed.includes(emoji)) return;
    socket.to(room.code).emit('emoji', { playerId: playerBySocket(room, socket.id).id, emoji });
  });

  socket.on('send_message', ({ roomCode, message } = {}) => {
    const room = rooms.get(roomKey(roomCode));
    const p = room && playerBySocket(room, socket.id);
    if (!p) return;
    const text = String(message || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, MAX_MESSAGE);
    if (!text) return;
    socket.to(room.code).emit('chat_message', { senderName: p.name, message: text });
  });

  socket.on('disconnect', () => {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    socketRoom.delete(socket.id);
    if (!room) return;
    const p = playerBySocket(room, socket.id);
    if (!p) return;
    p.socketId = null;
    // Keep the seat for a short reconnect grace period.
    clearTimeout(p.disconnectTimer);
    p.disconnectTimer = setTimeout(() => {
      if (p.socketId) return;
      p.eliminated = true;
      finishOnDisconnect(room, p);
    }, 20_000);
  });
});

function finishOnDisconnect(room, p) {
  room.lastActivity = Date.now();
  if (!room.started || room.isGameOver) {
    broadcastRoom(room, 'opponent_disconnected');
    if (!room.players.some(x => isHuman(x) && x.socketId)) deleteRoom(room.code);
    return;
  }
  const remainingHumans = room.players.filter(x => isHuman(x) && x.socketId);
  if (remainingHumans.length <= 1) {
    broadcastRoom(room, 'opponent_disconnected');
    room.isGameOver = true;
    room.phase = 'game_over';
    clearTurnTimer(room);
    const winner = remainingHumans[0];
    const winners = winner ? [winner.id] : [];
    const losers = [p.id];
    room.result = { winners, losers, reason: 'disconnect' };
    broadcastRoom(room, 'game_over', room.result);
    sendState(room);
  }
}

function restartGame(room) {
  room.rematchVotes.clear();
  room.started = false;
  room.isGameOver = false;
  room.result = null;
  room.finishOrder = [];
  room.table = [];
  room.deck = [];
  room.trumpCard = null;
  room.trumpSuit = null;
  room.moveLog = [];
  room.round = 0;
  room.phase = 'lobby';
  room.pendingTake = false;
  room.passed.clear();
  for (const p of room.players) { p.hand = []; p.eliminated = false; p.finishedAt = null; }
  broadcastRoom(room, 'game_restarted');
  startGame(room);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.started && now - room.lastActivity > ROOM_TTL_MS) {
      broadcastRoom(room, 'room_expired');
      deleteRoom(code);
    }
  }
}, 30_000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`SANI GROUP Durak server listening on :${PORT}`));
}

module.exports = { makeDeck, canBeat, attackLimit, shuffle, makeRoom, joinRoom, startGame, playCard, pass, defenderTake, completeSuccessfulDefense, drawToSix, chooseBotCard, tableRanks, allDefended };
