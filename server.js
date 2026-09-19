/**
 * SANI GROUP — ДУРАК PREMIUM
 * Серверная логика (Express + Socket.IO)
 * v2.1.0 — исправлены правила, ротация ролей, утечка колоды, реконнект.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const RANKS = [
  { rank: 6, value: 6 }, { rank: 7, value: 7 }, { rank: 8, value: 8 },
  { rank: 9, value: 9 }, { rank: 10, value: 10 }, { rank: 'J', value: 11 },
  { rank: 'Q', value: 12 }, { rank: 'K', value: 13 }, { rank: 'A', value: 14 }
];
const SUITS = ['♠', '♥', '♦', '♣'];

const HAND_SIZE = 6;
const MAX_TABLE = 6;               // максимум пар на столе за один кон
const TURN_LIMIT_MS = 60000;       // авто-ход, если игрок завис
const RECONNECT_GRACE_MS = 60000;  // сколько ждём переподключения
const BOT_DELAY_MS = 700;
const MAX_TAKE_STREAK = 40;        // защита от бесконечной партии

let io = null;
const rooms = {};
let watchdog = null;

function setIO(instance) { io = instance; }
function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

/* ============================================================
   КАРТЫ
   ============================================================ */
function createDeck() {
  const deck = [];
  let id = 0;
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: id++, suit: s, rank: r.rank, value: r.value });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sortHand(hand, trumpSuit, mode = 'trump-right') {
  hand.sort((a, b) => {
    const aT = a.suit === trumpSuit ? 1 : 0;
    const bT = b.suit === trumpSuit ? 1 : 0;
    if (mode === 'trump-left') {
      if (aT !== bT) return bT - aT;
    } else {
      if (aT !== bT) return aT - bT;
    }
    if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    return a.value - b.value;
  });
}

function canBeat(att, def, trumpSuit) {
  const aT = att.suit === trumpSuit;
  const dT = def.suit === trumpSuit;
  if (aT && !dT) return false;
  if (aT && dT) return def.value > att.value;
  if (!dT) return att.suit === def.suit && def.value > att.value;
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

function countDefendedPairs(table) {
  return table.filter(p => p.defense !== null).length;
}

function countUncovered(table) {
  return table.filter(p => p.defense === null).length;
}

/* ============================================================
   СВЯЗЬ С ИГРОКАМИ (pid — постоянный id, sid — текущий сокет)
   ============================================================ */
function emitTo(room, pid, event, payload) {
  const p = room.players.find(x => x.pid === pid);
  if (p && p.sid) getIO().to(p.sid).emit(event, payload);
}
function errTo(room, pid, msg) { emitTo(room, pid, 'error_msg', msg); }

/* ============================================================
   СОСТОЯНИЕ ИГРЫ
   ============================================================ */
function initGameState(room) {
  const deck = shuffleDeck(createDeck());
  // Козырь лежит НА ДНЕ колоды (индекс 0) и уходит последним:
  // раздача и добор идут с конца массива.
  const trumpCard = deck[0];
  const trumpSuit = trumpCard.suit;
  const hands = {};

  for (const p of room.players) {
    hands[p.pid] = deck.splice(-HAND_SIZE);
    sortHand(hands[p.pid], trumpSuit);
  }

  let firstIdx = 0;
  let minV = Infinity;
  let foundTrump = false;
  room.players.forEach((p, idx) => {
    for (const c of hands[p.pid]) {
      if (c.suit === trumpSuit && c.value < minV) {
        minV = c.value; firstIdx = idx; foundTrump = true;
      }
    }
  });
  if (!foundTrump) firstIdx = crypto.randomInt(room.players.length);

  room.state = {
    roomCode: room.id,
    deck, trumpCard, trumpSuit, hands,
    table: [],
    attackerIdx: firstIdx,
    defenderIdx: (firstIdx + 1) % room.players.length,
    currentThrowerIdx: firstIdx,
    boutAttackerIdx: firstIdx,
    playersInfo: room.players.map(p => ({
      id: p.pid, name: p.name, isBot: !!p.isBot,
      botDifficulty: p.botDifficulty || 'normal',
      connected: p.isBot ? true : !!p.sid
    })),
    finished: [],
    passed: [],
    isGameOver: false,
    winners: [],
    loser: null,
    startedAt: Date.now(),
    turnStartedAt: Date.now(),
    moveLog: [],
    pendingTake: false,
    pendingTakePassed: [],
    discarded: 0,
    takeStreak: 0,
    dirty: false
  };
  room.rematchVotes.clear();
}

function logMove(state, text) {
  state.moveLog.push({ t: Date.now(), text });
  if (state.moveLog.length > 60) state.moveLog.shift();
}

function isFinished(state, pid) { return state.finished.includes(pid); }

function nextActiveIdx(state, fromIdx) {
  const n = state.playersInfo.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromIdx + i) % n;
    if (!isFinished(state, state.playersInfo[idx].id)) return idx;
  }
  return fromIdx;
}

/** Назначает роли на новый кон, пропуская вышедших из игры. */
function setRoles(state, attackerIdx) {
  state.attackerIdx = attackerIdx;
  state.defenderIdx = nextActiveIdx(state, attackerIdx);
  state.currentThrowerIdx = attackerIdx;
  state.boutAttackerIdx = attackerIdx;
  state.passed = [];
  state.pendingTake = false;
  state.pendingTakePassed = [];
  state.turnStartedAt = Date.now();
}

/** Сколько ещё карт можно положить на стол: не больше 6 пар и не больше, чем карт у защитника. */
function canAddCard(state) {
  if (state.table.length >= MAX_TABLE) return false;
  const defId = state.playersInfo[state.defenderIdx].id;
  const defLen = (state.hands[defId] || []).length;
  return countUncovered(state.table) < defLen;
}

/** Добор: начиная с того, кто открыл кон; защитник добирает последним. */
function refillHands(state, startIdx, defIdx) {
  const n = state.playersInfo.length;
  const order = [];
  for (let i = 0; i < n; i++) {
    const idx = (startIdx + i) % n;
    if (idx !== defIdx) order.push(idx);
  }
  order.push(defIdx);
  for (const idx of order) {
    const pid = state.playersInfo[idx].id;
    if (!state.hands[pid]) state.hands[pid] = [];
    while (state.hands[pid].length < HAND_SIZE && state.deck.length > 0) {
      state.hands[pid].push(state.deck.pop());
    }
    sortHand(state.hands[pid], state.trumpSuit);
  }
}

/** Фиксирует тех, кто вышел из игры (колода пуста и рука пуста). */
function updateFinished(state) {
  if (state.deck.length > 0) return;
  for (const p of state.playersInfo) {
    if (isFinished(state, p.id)) continue;
    if ((state.hands[p.id] || []).length === 0) {
      state.finished.push(p.id);
      logMove(state, `${p.name}: вышел из игры`);
    }
  }
}

function endGame(room, loser) {
  const state = room.state;
  state.isGameOver = true;
  state.loser = loser;
  state.winners = state.playersInfo.filter(p => p.id !== loser).map(p => p.id);
  logMove(state, loser
    ? `Игра окончена. Дурак — ${state.playersInfo.find(p => p.id === loser).name}`
    : 'Игра окончена. Ничья');

  broadcastState(room);
  getIO().to(room.id).emit('game_over', {
    winners: state.winners,
    loser: state.loser,
    moves: state.moveLog.length,
    durationSec: Math.floor((Date.now() - state.startedAt) / 1000)
  });
  startRematchCountdown(room);
  return true;
}

/** Конец игры проверяем ТОЛЬКО между конами (стол пуст). */
function checkGameOver(room) {
  const state = room.state;
  if (state.isGameOver) return true;
  if (state.table.length > 0) return false;

  // защита от вечной партии: слишком много конов подряд закончились взятием
  if (state.takeStreak >= MAX_TAKE_STREAK) return endGame(room, null);

  if (state.deck.length > 0) return false;
  const withCards = state.playersInfo.filter(p => (state.hands[p.id] || []).length > 0);
  if (withCards.length > 1) return false;
  return endGame(room, withCards.length === 1 ? withCards[0].id : null);
}

/* ============================================================
   ХОДЫ
   ============================================================ */
function handlePlayCard(room, pid, cardId) {
  const state = room.state;
  const hand = state.hands[pid];
  if (!hand) { errTo(room, pid, 'Нет карт на руке'); return false; }
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) { errTo(room, pid, 'Карта не найдена'); return false; }

  const card = hand[idx];
  const defId = state.playersInfo[state.defenderIdx].id;
  const attId = state.playersInfo[state.attackerIdx].id;
  const pIdx = state.playersInfo.findIndex(p => p.id === pid);
  if (pIdx === -1) return false;
  const pName = state.playersInfo[pIdx].name;

  const putOnTable = () => {
    hand.splice(idx, 1);
    state.table.push({ attack: card, defense: null, attackerId: pid });
    state.currentThrowerIdx = pIdx;
    // новая карта на столе — право подкинуть снова открыто для всех
    state.passed = [];
    state.pendingTakePassed = [];
    state.turnStartedAt = Date.now();
  };

  // --- защитник уже сказал «БЕРУ»: остальные подкидывают
  if (state.pendingTake) {
    if (pid === defId) { errTo(room, pid, 'Вы уже взяли — ждём подкидывания'); return false; }
    if (pIdx !== state.currentThrowerIdx) { errTo(room, pid, 'Сейчас не ваша очередь'); return false; }
    if (!getTableRanks(state.table).has(card.rank)) {
      errTo(room, pid, 'Такого достоинства нет на столе'); return false;
    }
    if (!canAddCard(state)) { errTo(room, pid, 'Больше подкидывать нельзя'); return false; }
    hand.splice(idx, 1);
    state.table.push({ attack: card, defense: null, attackerId: pid });
    state.pendingTakePassed = [];
    logMove(state, `${pName}: подкинул ${card.rank}${card.suit}`);
    state.turnStartedAt = Date.now();
    return true;
  }

  // --- защита
  if (pid === defId) {
    if (state.table.length === 0) { errTo(room, pid, 'Стол пуст'); return false; }
    const unIdx = state.table.findIndex(p => p.defense === null);
    if (unIdx === -1) { errTo(room, pid, 'Всё уже отбито'); return false; }
    const attCard = state.table[unIdx].attack;
    if (!canBeat(attCard, card, state.trumpSuit)) {
      errTo(room, pid, 'Карта не бьёт атаку'); return false;
    }
    hand.splice(idx, 1);
    state.table[unIdx].defense = card;
    state.passed = [];
    logMove(state, `${pName}: отбил ${attCard.rank}${attCard.suit} → ${card.rank}${card.suit}`);
    state.turnStartedAt = Date.now();
    // конец игры здесь НЕ проверяем: кон ещё не сыгран
    return true;
  }

  if (isFinished(state, pid)) { errTo(room, pid, 'Вы уже вышли из игры'); return false; }

  // --- первая атака
  if (state.table.length === 0) {
    if (pid !== attId) { errTo(room, pid, 'Сейчас ход другого игрока'); return false; }
    putOnTable();
    logMove(state, `${pName}: ${card.rank}${card.suit}`);
    return true;
  }

  // --- подкидывание
  if (pIdx !== state.currentThrowerIdx) {
    errTo(room, pid, 'Сейчас не ваша очередь подкидывать'); return false;
  }
  if (!getTableRanks(state.table).has(card.rank)) {
    errTo(room, pid, 'Такого достоинства нет на столе'); return false;
  }
  if (!canAddCard(state)) { errTo(room, pid, 'Больше подкидывать нельзя'); return false; }
  putOnTable();
  logMove(state, `${pName}: подкинул ${card.rank}${card.suit}`);
  return true;
}

/** Кто ещё может подкинуть: не защитник, не вышедший, не спасовавший, есть подходящая карта. */
function findNextThrower(state, fromIdx, passedList) {
  if (!canAddCard(state)) return -1;
  const n = state.playersInfo.length;
  const defId = state.playersInfo[state.defenderIdx].id;
  const ranks = getTableRanks(state.table);
  for (let i = 1; i <= n; i++) {
    const idx = (fromIdx + i) % n;
    const p = state.playersInfo[idx];
    if (p.id === defId) continue;
    if (isFinished(state, p.id)) continue;
    if (passedList.includes(p.id)) continue;
    if ((state.hands[p.id] || []).some(c => ranks.has(c.rank))) return idx;
  }
  return -1;
}

function handleTake(room, pid) {
  const state = room.state;
  if (state.pendingTake) return false;
  const defId = state.playersInfo[state.defenderIdx].id;
  if (pid !== defId) { errTo(room, pid, 'Брать может только защищающийся'); return false; }
  if (state.table.length === 0) { errTo(room, pid, 'На столе нет карт'); return false; }

  state.pendingTake = true;
  state.pendingTakePassed = [];
  const nextIdx = findNextThrower(state, state.defenderIdx, []);
  if (nextIdx === -1) {
    state.pendingTake = false;
    return finalizeTake(room);
  }
  state.currentThrowerIdx = nextIdx;
  logMove(state, `${state.playersInfo[state.defenderIdx].name}: БЕРУ (ждём подкидывания)`);
  state.turnStartedAt = Date.now();
  return true;
}

function finalizeTake(room) {
  const state = room.state;
  const defIdx = state.defenderIdx;
  const defId = state.playersInfo[defIdx].id;
  if (!state.hands[defId]) state.hands[defId] = [];

  const takenCount = state.table.reduce((s, p) => s + (p.defense ? 2 : 1), 0);
  for (const p of state.table) {
    state.hands[defId].push(p.attack);
    if (p.defense) state.hands[defId].push(p.defense);
  }
  state.table = [];
  state.pendingTake = false;
  state.pendingTakePassed = [];
  state.passed = [];
  sortHand(state.hands[defId], state.trumpSuit);
  logMove(state, `${state.playersInfo[defIdx].name}: ЗАБРАЛ ${takenCount} карт`);
  state.takeStreak++;

  refillHands(state, state.boutAttackerIdx, defIdx);
  updateFinished(state);
  if (checkGameOver(room)) return true;
  // взявший пропускает ход: атакует следующий за ним
  setRoles(state, nextActiveIdx(state, defIdx));
  return true;
}

/** Завершение кона «БИТО». */
function finishBout(room, byPid) {
  const state = room.state;
  const defIdx = state.defenderIdx;
  state.discarded += state.table.reduce((s, p) => s + (p.defense ? 2 : 1), 0);
  state.table = [];
  const name = (state.playersInfo.find(p => p.id === byPid) || {}).name || '—';
  logMove(state, `${name}: БИТО`);
  state.takeStreak = 0;

  refillHands(state, state.boutAttackerIdx, defIdx);
  updateFinished(state);
  if (checkGameOver(room)) return true;
  // отбившийся становится атакующим (если ещё в игре)
  const nextAtt = isFinished(state, state.playersInfo[defIdx].id)
    ? nextActiveIdx(state, defIdx)
    : defIdx;
  setRoles(state, nextAtt);
  return true;
}

function handleDone(room, pid) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pid);
  const defId = state.playersInfo[state.defenderIdx].id;
  if (state.pendingTake) { errTo(room, pid, 'Защитник забирает карты'); return false; }
  if (pIdx === -1 || pIdx !== state.currentThrowerIdx) {
    errTo(room, pid, 'Сейчас не ваш ход'); return false;
  }
  if (pid === defId) { errTo(room, pid, 'Защищающийся не может сказать «Бито»'); return false; }
  if (state.table.length === 0 || countUncovered(state.table) > 0) {
    errTo(room, pid, 'Не все карты отбиты'); return false;
  }
  return finishBout(room, pid);
}

function handlePass(room, pid) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pid);
  if (pIdx === -1) return false;
  if (pIdx !== state.currentThrowerIdx) { errTo(room, pid, 'Сейчас не ваша очередь'); return false; }

  // пас во время «БЕРУ»
  if (state.pendingTake) {
    if (!state.pendingTakePassed.includes(pid)) state.pendingTakePassed.push(pid);
    const nextIdx = findNextThrower(state, pIdx, state.pendingTakePassed);
    if (nextIdx === -1) return finalizeTake(room);
    state.currentThrowerIdx = nextIdx;
    state.turnStartedAt = Date.now();
    return true;
  }

  if (state.table.length === 0) { errTo(room, pid, 'На столе пусто'); return false; }
  if (countUncovered(state.table) > 0) {
    errTo(room, pid, 'Сначала нужно отбить все карты'); return false;
  }
  if (!state.passed.includes(pid)) state.passed.push(pid);
  const nextIdx = findNextThrower(state, pIdx, state.passed);
  if (nextIdx === -1) return finishBout(room, pid);   // все спасовали → БИТО
  state.currentThrowerIdx = nextIdx;
  state.turnStartedAt = Date.now();
  return true;
}

/* ============================================================
   БОТЫ
   ============================================================ */
function pickDefenseCard(hand, attCard, trumpSuit, difficulty) {
  const valid = hand.filter(c => canBeat(attCard, c, trumpSuit));
  if (valid.length === 0) return null;
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
    // всегда ходим младшей некозырной; козырь бережём на защиту
    if (nonT.length) {
      nonT.sort((a, b) => a.value - b.value);
      return nonT[0];
    }
    t.sort((a, b) => a.value - b.value);
    return t[0] || null;
  }
  if (nonT.length) {
    nonT.sort((a, b) => a.value - b.value);
    return nonT[0];
  }
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
  return sorted[0];   // подкидываем самую младшую, козыри — в последнюю очередь
}

/** Один шаг бота. true — состояние изменилось и его надо разослать. */
function executeBotTurnChain(room) {
  if (!room || !room.state || room.state.isGameOver) return false;
  const state = room.state;
  state.dirty = false;
  const defP = state.playersInfo[state.defenderIdx];

  // 1) защитник забрал — подкидываем
  if (state.pendingTake) {
    const curP = state.playersInfo[state.currentThrowerIdx];
    if (!curP.isBot) return false;
    const ranks = getTableRanks(state.table);
    const matches = (state.hands[curP.id] || []).filter(c => ranks.has(c.rank));
    if (matches.length && canAddCard(state)) {
      const card = pickThrowCard(matches, state.trumpSuit, curP.botDifficulty);
      if (card && handlePlayCard(room, curP.id, card.id)) return true;
    }
    return handlePass(room, curP.id);
  }

  // 2) есть неотбитая карта — ходит защитник
  const unIdx = state.table.findIndex(p => p.defense === null);
  if (unIdx !== -1) {
    if (!defP.isBot) return false;
    const card = pickDefenseCard(state.hands[defP.id] || [], state.table[unIdx].attack,
      state.trumpSuit, defP.botDifficulty);
    if (card) return handlePlayCard(room, defP.id, card.id);
    return handleTake(room, defP.id);
  }

  // 3) стол пуст — новая атака
  if (state.table.length === 0) {
    if (isFinished(state, state.playersInfo[state.attackerIdx].id)) {
      setRoles(state, nextActiveIdx(state, state.attackerIdx));
      state.dirty = true;
    }
    if (checkGameOver(room)) return false;
    const att = state.playersInfo[state.attackerIdx];
    if (!att.isBot) return state.dirty;
    const card = pickAttackCard(state.hands[att.id] || [], state.trumpSuit,
      state.deck.length, att.botDifficulty);
    if (!card) return state.dirty;
    return handlePlayCard(room, att.id, card.id);
  }

  // 4) всё отбито — подкидываем или «БИТО»
  const curP = state.playersInfo[state.currentThrowerIdx];
  if (!curP.isBot) return false;
  const ranks = getTableRanks(state.table);
  const matches = (state.hands[curP.id] || []).filter(c => ranks.has(c.rank));
  if (matches.length && canAddCard(state)) {
    const card = pickThrowCard(matches, state.trumpSuit, curP.botDifficulty);
    if (card && handlePlayCard(room, curP.id, card.id)) return true;
  }
  return handlePass(room, curP.id);
}

function scheduleBotTurn(room) {
  if (!room || !room.state || room.state.isGameOver) return;
  if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
  room.botLoopTimeout = setTimeout(() => {
    room.botLoopTimeout = null;
    if (!rooms[room.id] || !room.state || room.state.isGameOver) return;
    const acted = executeBotTurnChain(room);
    if (acted) {
      broadcastState(room);
      if (!room.state.isGameOver) scheduleBotTurn(room);
    }
  }, BOT_DELAY_MS);
}

/* ============================================================
   АВТО-ХОД ПРИ ЗАВИСАНИИ (ограничение времени хода)
   ============================================================ */
function currentActorIdx(state) {
  if (state.pendingTake) return state.currentThrowerIdx;
  if (countUncovered(state.table) > 0) return state.defenderIdx;
  return state.currentThrowerIdx;
}

function forceMove(room) {
  const state = room.state;
  const idx = currentActorIdx(state);
  const actor = state.playersInfo[idx];
  if (!actor || actor.isBot) return false;

  if (state.pendingTake) return handlePass(room, actor.id);
  if (countUncovered(state.table) > 0) return handleTake(room, actor.id);
  if (state.table.length === 0) {
    const card = pickAttackCard(state.hands[actor.id] || [], state.trumpSuit, state.deck.length, 'normal');
    return card ? handlePlayCard(room, actor.id, card.id) : false;
  }
  return handlePass(room, actor.id);
}

function tickRooms() {
  for (const room of Object.values(rooms)) {
    if (!room.state || room.state.isGameOver) continue;
    if (Date.now() - room.state.turnStartedAt < TURN_LIMIT_MS) continue;
    if (forceMove(room)) {
      broadcastState(room);
      scheduleBotTurn(room);
    } else {
      room.state.turnStartedAt = Date.now();
    }
  }
}

/* ============================================================
   РАССЫЛКА СОСТОЯНИЯ (колода НЕ раскрывается)
   ============================================================ */
function broadcastState(room) {
  if (!room.state) return;
  const st = room.state;
  for (const target of room.players) {
    if (target.isBot || !target.sid) continue;
    const copy = {
      roomCode: st.roomCode,
      trumpCard: st.trumpCard,
      trumpSuit: st.trumpSuit,
      table: st.table,
      attackerIdx: st.attackerIdx,
      defenderIdx: st.defenderIdx,
      currentThrowerIdx: st.currentThrowerIdx,
      finished: st.finished,
      isGameOver: st.isGameOver,
      winners: st.winners,
      loser: st.loser,
      startedAt: st.startedAt,
      turnStartedAt: st.turnStartedAt,
      moveLog: st.moveLog,
      pendingTake: st.pendingTake,
      discarded: st.discarded,
      deckCount: st.deck.length,
      // клиент использует только длину — карты не раскрываем
      deck: new Array(st.deck.length).fill(null),
      hands: {},
      playersInfo: st.playersInfo.map(info => ({ ...info, isYou: info.id === target.pid }))
    };
    for (const p of room.players) {
      copy.hands[p.pid] = p.pid === target.pid
        ? (st.hands[p.pid] || [])
        : new Array((st.hands[p.pid] || []).length).fill({});
    }
    getIO().to(target.sid).emit('game_update', copy);
  }
}

/* ============================================================
   КОМНАТЫ
   ============================================================ */
function generateRoomCode() {
  let code, attempts = 0;
  do {
    code = String(1000 + crypto.randomInt(9000));
    if (++attempts > 9000) throw new Error('No free room codes');
  } while (rooms[code]);
  return code;
}

function updateLobby(room) {
  const humans = room.players.filter(p => !p.isBot).length;
  getIO().to(room.id).emit('lobby_update', {
    code: room.id,
    current: room.players.length,
    max: room.maxPlayers,
    humanCount: humans
  });
}

function fillRoomWithBots(room, difficulty) {
  const names = ['Бот Валера', 'Бот Степан', 'Бот Гриша'];
  let i = 0;
  while (room.players.length < room.maxPlayers) {
    const id = 'BOT_' + crypto.randomBytes(5).toString('hex');
    room.players.push({
      pid: id, sid: null, isBot: true,
      name: names[i++ % names.length],
      botDifficulty: difficulty
    });
  }
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
  if (room.graceTimer) clearTimeout(room.graceTimer);
  delete rooms[code];
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
      room.rematchTimer = null;
      const humans = room.players.filter(p => !p.isBot && p.sid);
      if (humans.length > 0 && room.rematchVotes.size >= humans.length) {
        startRematch(room);
      } else {
        getIO().to(room.id).emit('room_expired');
        destroyRoom(room.id);
      }
    }
  }, 1000);
}

function startRematch(room) {
  if (room.rematchTimer) { clearInterval(room.rematchTimer); room.rematchTimer = null; }
  initGameState(room);
  getIO().to(room.id).emit('game_restarted');
  broadcastState(room);
  scheduleBotTurn(room);
}

/* ============================================================
   SOCKET.IO
   ============================================================ */
function cleanPid(raw, fallback) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : fallback;
}
function cleanName(raw, fallback) {
  const s = String(raw || '').trim().slice(0, 12);
  return s || fallback;
}
function findRoomBySid(sid) {
  return Object.values(rooms).find(r => r.players.some(p => p.sid === sid)) || null;
}

function attachHandlers(socket) {
  socket.on('rejoin', data => {
    const pid = cleanPid(data && data.pid, null);
    if (!pid) return;
    const room = Object.values(rooms).find(r => r.players.some(p => p.pid === pid));
    if (!room) { socket.emit('rejoin_failed'); return; }
    const player = room.players.find(p => p.pid === pid);
    player.sid = socket.id;
    socket.join(room.id);
    socket.data.pid = pid;
    if (room.state) {
      const info = room.state.playersInfo.find(i => i.id === pid);
      if (info) info.connected = true;
      const allBack = room.players.filter(p => !p.isBot).every(p => p.sid);
      if (allBack && room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
      getIO().to(room.id).emit('player_reconnected', { name: player.name });
      socket.emit('rejoined', { roomCode: room.id });
      broadcastState(room);
      scheduleBotTurn(room);
    } else {
      socket.emit('rejoined', { roomCode: room.id });
      updateLobby(room);
    }
  });

  socket.on('create_room', data => {
    const d = (data && typeof data === 'object') ? data : {};
    let maxPlayers = Math.max(2, Math.min(4, parseInt(d.maxPlayers) || 2));
    const pid = cleanPid(d.pid, socket.id);
    // старая комната этого игрока больше не нужна
    const prev = Object.values(rooms).find(r => !r.state && r.players.some(p => p.pid === pid));
    if (prev) destroyRoom(prev.id);

    let code;
    try { code = generateRoomCode(); }
    catch { socket.emit('error_msg', 'Сервер перегружен'); return; }

    rooms[code] = {
      id: code, maxPlayers,
      players: [{ pid, sid: socket.id, isBot: false, name: cleanName(d.playerName, 'Игрок 1') }],
      state: null, rematchVotes: new Set(),
      rematchTimer: null, botLoopTimeout: null, graceTimer: null
    };
    socket.join(code);
    socket.data.pid = pid;
    socket.emit('room_created', { code, maxPlayers });
    updateLobby(rooms[code]);
  });

  socket.on('join_room', data => {
    const d = (data && typeof data === 'object') ? data : { roomCode: data };
    const code = String(d.roomCode || '').trim();
    const pid = cleanPid(d.pid, socket.id);
    if (!/^\d{4}$/.test(code)) { socket.emit('error_msg', 'Код комнаты — 4 цифры'); return; }
    const room = rooms[code];
    if (!room) { socket.emit('error_msg', 'Комната не найдена'); return; }
    if (room.players.some(p => p.pid === pid)) { socket.emit('error_msg', 'Вы уже в этой комнате'); return; }
    if (room.state) { socket.emit('error_msg', 'Игра уже началась'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error_msg', 'Комната заполнена'); return; }

    room.players.push({
      pid, sid: socket.id, isBot: false,
      name: cleanName(d.playerName, `Игрок ${room.players.length + 1}`)
    });
    socket.join(code);
    socket.data.pid = pid;
    updateLobby(room);
    if (room.players.length === room.maxPlayers) {
      initGameState(room);
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('play_with_bots', data => {
    const d = (data && typeof data === 'object') ? data : {};
    const pid = cleanPid(d.pid, socket.id);
    const botCount = Math.max(1, Math.min(3, parseInt(d.botCount) || 1));
    const botDifficulty = ['easy', 'normal', 'hard'].includes(d.botDifficulty) ? d.botDifficulty : 'normal';
    const prev = Object.values(rooms).find(r => r.players.some(p => p.pid === pid));
    if (prev) destroyRoom(prev.id);

    const code = 'BOTS_' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const room = {
      id: code, maxPlayers: botCount + 1,
      players: [{ pid, sid: socket.id, isBot: false, name: cleanName(d.playerName, 'Вы') }],
      state: null, rematchVotes: new Set(),
      rematchTimer: null, botLoopTimeout: null, graceTimer: null,
      botDifficulty
    };
    rooms[code] = room;
    socket.join(code);
    socket.data.pid = pid;
    fillRoomWithBots(room, botDifficulty);
    initGameState(room);
    broadcastState(room);
    scheduleBotTurn(room);
  });

  socket.on('player_action', payload => {
    const d = payload || {};
    const room = rooms[d.roomCode] || findRoomBySid(socket.id);
    if (!room || !room.state || room.state.isGameOver) return;
    const player = room.players.find(p => p.sid === socket.id);
    if (!player) return;

    let ok = false;
    if (d.action === 'play_card') ok = handlePlayCard(room, player.pid, d.cardId);
    else if (d.action === 'take') ok = handleTake(room, player.pid);
    else if (d.action === 'done') ok = handleDone(room, player.pid);
    else if (d.action === 'pass') ok = handlePass(room, player.pid);

    if (ok) {
      // таймер бота сбрасываем ТОЛЬКО после удачного хода
      if (room.botLoopTimeout) { clearTimeout(room.botLoopTimeout); room.botLoopTimeout = null; }
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('emoji', payload => {
    const d = payload || {};
    const room = rooms[d.roomCode] || findRoomBySid(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.sid === socket.id);
    if (!player) return;
    if (!rateOk(player, 'emoji', 1500)) return;
    getIO().to(room.id).emit('emoji', { playerId: player.pid, emoji: String(d.emoji || '').slice(0, 8) });
  });

  socket.on('send_message', payload => {
    const d = payload || {};
    const room = rooms[d.roomCode] || findRoomBySid(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.sid === socket.id);
    if (!player) return;
    if (!rateOk(player, 'chat', 800)) return;
    const clean = String(d.message || '').trim().slice(0, 150);
    if (!clean) return;
    getIO().to(room.id).emit('chat_message', {
      senderId: player.pid, senderName: player.name, message: clean
    });
  });

  socket.on('vote_rematch', roomCode => {
    const room = rooms[roomCode] || findRoomBySid(socket.id);
    if (!room || !room.state || !room.state.isGameOver) return;
    const player = room.players.find(p => p.sid === socket.id);
    if (!player) return;
    room.rematchVotes.add(player.pid);
    const humans = room.players.filter(p => !p.isBot && p.sid);
    getIO().to(room.id).emit('rematch_voted', {
      votesCount: room.rematchVotes.size, totalNeeded: humans.length
    });
    if (humans.length > 0 && room.rematchVotes.size >= humans.length) startRematch(room);
  });

  socket.on('client_ready', () => {
    const room = findRoomBySid(socket.id);
    if (room && room.state) broadcastState(room);
  });

  socket.on('leave_room', () => {
    const room = findRoomBySid(socket.id);
    if (!room) return;
    const idx = room.players.findIndex(p => p.sid === socket.id);
    if (idx === -1) return;
    socket.leave(room.id);
    room.players.splice(idx, 1);
    if (room.players.filter(p => !p.isBot).length === 0) { destroyRoom(room.id); return; }
    if (room.state && !room.state.isGameOver) {
      getIO().to(room.id).emit('opponent_disconnected');
      destroyRoom(room.id);
    } else updateLobby(room);
  });

  socket.on('disconnect', () => {
    const room = findRoomBySid(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.sid === socket.id);
    if (!player) return;
    player.sid = null;

    // в лобби игрок просто выходит
    if (!room.state) {
      room.players = room.players.filter(p => p.pid !== player.pid);
      if (room.players.filter(p => !p.isBot).length === 0) destroyRoom(room.id);
      else updateLobby(room);
      return;
    }

    const info = room.state.playersInfo.find(i => i.id === player.pid);
    if (info) info.connected = false;
    getIO().to(room.id).emit('player_disconnected', {
      name: player.name, graceSec: Math.floor(RECONNECT_GRACE_MS / 1000)
    });
    broadcastState(room);

    if (room.players.filter(p => !p.isBot && p.sid).length === 0 && room.state.isGameOver) {
      destroyRoom(room.id);
      return;
    }
    if (room.graceTimer) clearTimeout(room.graceTimer);
    room.graceTimer = setTimeout(() => {
      if (!rooms[room.id]) return;
      getIO().to(room.id).emit('opponent_disconnected');
      destroyRoom(room.id);
    }, RECONNECT_GRACE_MS);
  });
}

/** Простой анти-спам на игрока. */
function rateOk(player, key, ms) {
  const now = Date.now();
  player._rate = player._rate || {};
  if (player._rate[key] && now - player._rate[key] < ms) return false;
  player._rate[key] = now;
  return true;
}

/* ============================================================
   HTTP
   ============================================================ */
function createApp() {
  const app = express();
  const httpServer = http.createServer(app);

  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  const socketServer = new Server(httpServer, {
    cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // раздаём ТОЛЬКО public/, исходники сервера наружу не уходят
  const PUBLIC_DIR = path.join(__dirname, 'public');
  app.use(express.static(PUBLIC_DIR));
  app.get('/health', (req, res) => res.status(200).json({
    status: 'ok', uptime: process.uptime(), rooms: Object.keys(rooms).length
  }));
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  socketServer.on('connection', attachHandlers);
  if (!watchdog) watchdog = setInterval(tickRooms, 5000);
  return { app, httpServer, socketServer };
}

if (require.main === module) {
  const { httpServer, socketServer } = createApp();
  setIO(socketServer);
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Сервер] слушает http://0.0.0.0:${PORT}`);
    console.log(`[Health] http://0.0.0.0:${PORT}/health`);
  });
}

module.exports = {
  RANKS, SUITS, MAX_TABLE, HAND_SIZE,
  createDeck, shuffleDeck, sortHand, canBeat,
  getTableRanks, countDefendedPairs, countUncovered, canAddCard,
  initGameState, refillHands, endGame, updateFinished, checkGameOver, setRoles, nextActiveIdx,
  handlePlayCard, handleTake, handleDone, handlePass,
  finalizeTake, finishBout, findNextThrower,
  pickAttackCard, pickDefenseCard, pickThrowCard,
  executeBotTurnChain, scheduleBotTurn, tickRooms,
  broadcastState, setIO, createApp, rooms
};
