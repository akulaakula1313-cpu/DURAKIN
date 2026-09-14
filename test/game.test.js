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

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function runTests() {
  console.log('Running unit tests...\n');
  
  // Test 1: Deck creation
  console.log('Test 1: Deck creation');
  const deck = createDeck();
  assert(deck.length === 36, 'Deck should have 36 cards');
  const uniqueCards = new Set(deck.map(c => c.rank + c.suit)).size;
  assert(uniqueCards === 36, 'All cards should be unique');
  console.log('  PASS\n');

  // Test 2: Shuffle
  console.log('Test 2: Shuffle');
  const shuffled = shuffleDeck([...deck]);
  assert(shuffled.length === 36, 'Shuffled deck should have 36 cards');
  assert(JSON.stringify(shuffled) !== JSON.stringify(deck), 'Deck should be shuffled');
  console.log('  PASS\n');

  // Test 3: Deal cards
  console.log('Test 3: Deal cards');
  const testDeck = [...deck];
  const hands = { p1: [], p2: [] };
  hands.p1 = testDeck.splice(0, 6);
  hands.p2 = testDeck.splice(0, 6);
  assert(hands.p1.length === 6, 'Player 1 should have 6 cards');
  assert(hands.p2.length === 6, 'Player 2 should have 6 cards');
  assert(testDeck.length === 24, 'Deck should have 24 cards left');
  console.log('  PASS\n');

  // Test 4: First attacker determination
  console.log('Test 4: First attacker determination');
  const trumpCard = { suit: '♠', rank: 'J', value: 11 };
  const players = [
    { id: 'p1', hand: [{ suit: '♠', rank: '6', value: 6 }, { suit: '♥', rank: 'A', value: 14 }] },
    { id: 'p2', hand: [{ suit: '♠', rank: '7', value: 7 }, { suit: '♦', rank: 'K', value: 13 }] }
  ];
  let minTrump = 999;
  let firstIdx = 0;
  players.forEach((p, i) => {
    const trumps = p.hand.filter(c => c.suit === trumpCard.suit);
    trumps.forEach(c => { if (c.value < minTrump) { minTrump = c.value; firstIdx = i; } });
  });
  assert(firstIdx === 0, 'Player with lowest trump (6♠) should attack first');
  console.log('  PASS\n');

  // Test 5: canBeat function
  console.log('Test 5: canBeat function');
  const trumpSuit = '♠';
  
  // Same suit, higher rank beats lower
  assert(canBeat({ suit: '♥', rank: '7', value: 7 }, { suit: '♥', rank: '9', value: 9 }, trumpSuit), '9♥ beats 7♥');
  assert(!canBeat({ suit: '♥', rank: '9', value: 9 }, { suit: '♥', rank: '7', value: 7 }, trumpSuit), '7♥ does not beat 9♥');
  
  // Trump beats non-trump
  assert(canBeat({ suit: '♥', rank: 'A', value: 14 }, { suit: '♠', rank: '6', value: 6 }, trumpSuit), '6♠ beats A♥');
  assert(!canBeat({ suit: '♠', rank: '6', value: 6 }, { suit: '♥', rank: 'A', value: 14 }, trumpSuit), 'A♥ does not beat 6♠');
  
  // Higher trump beats lower trump
  assert(canBeat({ suit: '♠', rank: '7', value: 7 }, { suit: '♠', rank: '9', value: 9 }, trumpSuit), '9♠ beats 7♠');
  assert(!canBeat({ suit: '♠', rank: '9', value: 9 }, { suit: '♠', rank: '7', value: 7 }, trumpSuit), '7♠ does not beat 9♠');
  
  // Different non-trump suits don't beat
  assert(!canBeat({ suit: '♥', rank: '7', value: 7 }, { suit: '♦', rank: '9', value: 9 }, trumpSuit), '9♦ does not beat 7♥');
  console.log('  PASS\n');

  // Test 6: getTableRanks
  console.log('Test 6: getTableRanks');
  const table = [
    { attack: { rank: '7' }, defense: { rank: '9' } },
    { attack: { rank: 'K' }, defense: null },
    { attack: { rank: 'A' }, defense: { rank: 'A' } }
  ];
  const ranks = getTableRanks(table);
  assert(ranks.has('7'), 'Should have rank 7');
  assert(ranks.has('9'), 'Should have rank 9');
  assert(ranks.has('K'), 'Should have rank K');
  assert(ranks.has('A'), 'Should have rank A');
  assert(ranks.size === 4, 'Should have 4 unique ranks');
  console.log('  PASS\n');

  // Test 7: countDefendedPairs
  console.log('Test 7: countDefendedPairs');
  assert(countDefendedPairs(table) === 2, 'Should count 2 defended pairs');
  console.log('  PASS\n');

  // Test 8: Refill hands
  console.log('Test 8: Refill hands');
  const state = {
    deck: [{ suit: '♠', rank: '6', value: 6 }, { suit: '♥', rank: '7', value: 7 }, { suit: '♦', rank: '8', value: 8 }],
    trumpSuit: '♠',
    hands: { p1: [{ suit: '♣', rank: 'A', value: 14 }], p2: [] },
    playersInfo: [{ id: 'p1' }, { id: 'p2' }],
    attackerIdx: 0
  };
  refillAllHands(state);
  assert(state.hands.p1.length >= 1, 'Player 1 should have at least 1 card');
  assert(state.hands.p2.length >= 1, 'Player 2 should have at least 1 card');
  console.log('  PASS\n');

  // Test 9: Check game over
  console.log('Test 9: Check game over');
  const room = {
    state: {
      deck: [],
      hands: { p1: [], p2: [{ suit: '♥', rank: '7', value: 7 }] },
      playersInfo: [{ id: 'p1' }, { id: 'p2' }],
      isGameOver: false,
      winner: null
    }
  };
  const gameOver = checkGameOver(room);
  assert(gameOver === true, 'Game should be over when one player has cards');
  assert(room.state.winner === 'p2', 'Player 2 should win');
  assert(room.state.isGameOver === true, 'isGameOver should be true');
  console.log('  PASS\n');

  // Test 10: Sort hand
  console.log('Test 10: Sort hand');
  const hand = [
    { suit: '♥', rank: 'A', value: 14 },
    { suit: '♠', rank: '6', value: 6 },
    { suit: '♠', rank: 'K', value: 13 },
    { suit: '♥', rank: '7', value: 7 }
  ];
  sortHand(hand, '♠');
  assert(hand[0].suit === '♥' && hand[0].rank === '7', 'Non-trumps first, sorted by value');
  assert(hand[1].suit === '♥' && hand[1].rank === 'A', 'Non-trumps sorted');
  assert(hand[2].suit === '♠' && hand[2].rank === '6', 'Trumps after non-trumps');
  assert(hand[3].suit === '♠' && hand[3].rank === 'K', 'Trumps sorted by value');
  console.log('  PASS\n');

  console.log('✅ All unit tests passed!');
}

runTests();