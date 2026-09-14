/**
 * BROWSER CONSOLE TEST - вставьте в консоль браузера (F12) после загрузки игры
 * Проверяет рендеринг карт на столе в реальном времени
 */

console.log('%c🔍 BROWSER RENDER TEST', 'color: #e8c56a; font-size: 16px; font-weight: bold');

// 1. Проверка DOM элементов
function checkDOM() {
  console.log('\n%c1. DOM ELEMENTS', 'color: #42d889');
  const checks = [
    ['#center', $('#center')],
    ['#pairs', $('#pairs')],
    ['#hand', $('#hand')],
    ['#trump', $('#trump')],
    ['#deck', $('#deck')]
  ];
  checks.forEach(([sel, el]) => {
    if (el) {
      const rect = el.getBoundingClientRect();
      console.log(`  ✅ ${sel}: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)} @ (${rect.x.toFixed(0)},${rect.y.toFixed(0)}) visible=${rect.width>0 && rect.height>0}`);
    } else {
      console.log(`  ❌ ${sel}: NOT FOUND`);
    }
  });
}

// 2. Проверка состояния игры
function checkState() {
  console.log('\n%c2. GAME STATE', 'color: #42d889');
  if (!window.state) {
    console.log('  ❌ window.state = undefined');
    return;
  }
  console.log('  ✅ state exists');
  console.log(`  table.length: ${state.table?.length || 0}`);
  console.log(`  hands[myId].length: ${state.hands?.[Object.keys(state.hands||{}).find(k=>k!=='p1'&&k!=='p2')]?.length || 'N/A'}`);
  console.log(`  defenderIdx: ${state.defenderIdx}, attackerIdx: ${state.attackerIdx}, currentThrowerIdx: ${state.currentThrowerIdx}`);
  console.log(`  deck.length: ${state.deck?.length}`);
  console.log(`  trumpSuit: ${state.trumpSuit}`);
  
  // Детальный разбор стола
  if (state.table && state.table.length > 0) {
    console.log('\n  TABLE DETAILS:');
    state.table.forEach((pair, i) => {
      console.log(`  Pair ${i}:`);
      console.log(`    attack: ${pair.attack?.rank}${pair.attack?.suit} (id:${pair.attack?.id})`);
      console.log(`    defense: ${pair.defense ? pair.defense.rank+pair.defense.suit+'(id:'+pair.defense.id+')' : 'null'}`);
      console.log(`    attackerId: ${pair.attackerId}`);
    });
  } else {
    console.log('  Table is empty');
  }
}

// 3. Проверка рендера стола
function checkTableRender() {
  console.log('\n%c3. TABLE RENDER', 'color: #42d889');
  const pairs = $('#pairs');
  if (!pairs) {
    console.log('  ❌ #pairs not found');
    return;
  }
  console.log(`  #pairs children: ${pairs.children.length}`);
  console.log(`  #pairs innerHTML length: ${pairs.innerHTML.length}`);
  console.log(`  #pairs display: ${getComputedStyle(pairs).display}`);
  console.log(`  #pairs visibility: ${getComputedStyle(pairs).visibility}`);
  console.log(`  #pairs rect:`, pairs.getBoundingClientRect());
  
  // Проверка каждой пары
  Array.from(pairs.children).forEach((pairEl, i) => {
    const rect = pairEl.getBoundingClientRect();
    const cards = pairEl.querySelectorAll('.card');
    console.log(`  Pair ${i}: ${cards.length} cards, rect: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)} @ (${rect.x.toFixed(0)},${rect.y.toFixed(0)})`);
    cards.forEach((card, j) => {
      const crect = card.getBoundingClientRect();
      const dataCard = card.dataset.card;
      const dataId = card.dataset.id;
      console.log(`    Card ${j}: ${dataCard} (id:${dataId}) rect: ${crect.width.toFixed(0)}x${crect.height.toFixed(0)} visible=${crect.width>0 && crect.height>0 && crect.x<window.innerWidth && crect.y<window.innerHeight}`);
    });
  });
}

// 4. Проверка CSS контейнеров
function checkCSS() {
  console.log('\n%c4. CSS CONTAINERS', 'color: #42d889');
  const center = $('#center');
  const pairs = $('#pairs');
  if (center && pairs) {
    const cRect = center.getBoundingClientRect();
    const pRect = pairs.getBoundingClientRect();
    console.log(`  #center: ${cRect.width.toFixed(0)}x${cRect.height.toFixed(0)} zIndex=${getComputedStyle(center).zIndex}`);
    console.log(`  #pairs: ${pRect.width.toFixed(0)}x${pRect.height.toFixed(0)} zIndex=${getComputedStyle(pairs).zIndex}`);
    console.log(`  #pairs inside #center: ${pRect.left >= cRect.left && pRect.right <= cRect.right && pRect.top >= cRect.top && pRect.bottom <= cRect.bottom}`);
  }
}

// 5. Проверка карт в руке
function checkHand() {
  console.log('\n%c5. HAND CARDS', 'color: #42d889');
  const hand = $('#hand');
  if (!hand) {
    console.log('  ❌ #hand not found');
    return;
  }
  const wraps = hand.querySelectorAll('.wrap');
  console.log(`  Wraps: ${wraps.length}`);
  wraps.forEach((wrap, i) => {
    const rect = wrap.getBoundingClientRect();
    const card = wrap.querySelector('.card');
    if (card) {
      const dataCard = card.dataset.card;
      const dataId = card.dataset.id;
      console.log(`  Wrap ${i}: ${dataCard} (id:${dataId}) rect: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)} transform: ${wrap.style.transform}`);
    }
  });
}

// ЗАПУСК ВСЕХ ПРОВЕРОК
checkDOM();
checkState();
checkTableRender();
checkCSS();
checkHand();

console.log('\n%c✅ TEST COMPLETE - см. вывод выше', 'color: #e8c56a; font-size: 14px; font-weight: bold');

// Функция для повторного запуска
window.runRenderTest = () => { checkDOM(); checkState(); checkTableRender(); checkCSS(); checkHand(); };
console.log('💡 Для повторного запуска: runRenderTest()');