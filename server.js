const express=require('express');
const http=require('http');
const path=require('path');
const {Server}=require('socket.io');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*',methods:['GET','POST']},pingTimeout:60000,pingInterval:25000});
app.use(express.static(__dirname));
app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'index.html')));

const rooms=new Map();
const RANKS=[
 {rank:6,value:6},{rank:7,value:7},{rank:8,value:8},{rank:9,value:9},
 {rank:10,value:10},{rank:'J',value:11},{rank:'Q',value:12},{rank:'K',value:13},{rank:'A',value:14}
];
const SUITS=['♠','♥','♦','♣'];
const MAX_CARDS=6;

function safeName(v,fallback='Игрок'){return String(v||fallback).trim().slice(0,12)||fallback}
function newCode(prefix=''){let c;do{c=prefix+Math.random().toString(36).slice(2,8).toUpperCase()}while(rooms.has(c));return c}
function makeRoom(id,maxPlayers,player){return{id,maxPlayers,players:[player],state:null,rematchVotes:new Set(),rematchTimer:null,botTimer:null,botLoop:null}}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function buildDeck(){let id=0,deck=[];for(const s of SUITS)for(const r of RANKS)deck.push({id:id++,suit:s,rank:r.rank,value:r.value});return shuffle(deck)}
function sortHand(h,trump){h.sort((a,b)=>((a.suit===trump)-(b.suit===trump))||a.value-b.value)}
function cardCanBeat(a,d,trump){
 const at=a.suit===trump,dt=d.suit===trump;
 if(at&&!dt)return false;
 if(at&&dt)return d.value>a.value;
 if(!dt)return a.suit===d.suit&&d.value>a.value;
 return true;
}
function ranksOnTable(table){const s=new Set();for(const p of table){s.add(p.attack.rank);if(p.defense)s.add(p.defense.rank)}return s}
function defended(table){return table.filter(p=>p.defense).length}
function humanPlayers(room){return room.players.filter(p=>!p.isBot)}
function broadcastLobby(room){io.to(room.id).emit('lobby_update',{code:room.id,current:room.players.length,max:room.maxPlayers})}

function initGame(room){
 const deck=buildDeck(),trumpCard=deck[deck.length-1];
 const hands={};
 for(const p of room.players){hands[p.id]=deck.splice(0,MAX_CARDS);sortHand(hands[p.id],trumpCard.suit)}
 let attackerIdx=0,min=999;
 room.players.forEach((p,i)=>{for(const c of hands[p.id])if(c.suit===trumpCard.suit&&c.value<min){min=c.value;attackerIdx=i}});
 const defenderIdx=(attackerIdx+1)%room.players.length;
 room.state={roomCode:room.id,deck,trumpCard,trumpSuit:trumpCard.suit,hands,table:[],
  attackerIdx,defenderIdx,currentThrowerIdx:attackerIdx,
  playersInfo:room.players.map(p=>({id:p.id,name:p.name,isBot:p.isBot})),
  isGameOver:false,winner:null};
 room.rematchVotes.clear();
}

function adaptState(room,forId){
 const s=JSON.parse(JSON.stringify(room.state));
 for(const p of room.players){
   if(p.id!==forId)s.hands[p.id]=new Array((room.state.hands[p.id]||[]).length).fill({});
 }
 const me=s.playersInfo.find(p=>p.id===forId);if(me)me.name='Вы';
 return s;
}
function broadcastState(room){
 for(const p of humanPlayers(room))io.to(p.id).emit('game_update',adaptState(room,p.id));
}
function clearTimers(room){
 if(room.botTimer)clearTimeout(room.botTimer);
 if(room.botLoop)clearTimeout(room.botLoop);
 if(room.rematchTimer)clearInterval(room.rematchTimer);
 room.botTimer=room.botLoop=room.rematchTimer=null;
}
function fillBot(room){
 while(room.players.length<2)room.players.push({id:'BOT_'+Math.random().toString(36).slice(2,9),isBot:true,name:'Бот Валера'});
}
function refill(room){
 const s=room.state,count=s.playersInfo.length;
 for(let i=0;i<count;i++){
   const idx=(s.attackerIdx+i)%count,p=s.playersInfo[idx];
   while(s.hands[p.id].length<MAX_CARDS&&s.deck.length)s.hands[p.id].push(s.deck.pop());
   sortHand(s.hands[p.id],s.trumpSuit);
 }
 if(!s.deck.length)s.trumpCard=null;
}
function gameOver(room){
 const s=room.state;if(s.deck.length)return false;
 const alive=s.playersInfo.filter(p=>(s.hands[p.id]||[]).length>0);
 if(alive.length<=1){s.isGameOver=true;s.winner=alive.length?alive[0].id:null;io.to(room.id).emit('game_over',{winner:s.winner});startRematchTimer(room);return true}
 return false;
}
function startRematchTimer(room){
 clearTimers(room);let left=15;room.rematchVotes.clear();io.to(room.id).emit('rematch_timer',left);
 room.rematchTimer=setInterval(()=>{left--;io.to(room.id).emit('rematch_timer',left);if(left<=0){clearInterval(room.rematchTimer);const hp=humanPlayers(room);if(room.rematchVotes.size>=hp.length&&hp.length)restart(room);else{io.to(room.id).emit('room_expired');rooms.delete(room.id)}}},1000);
}
function restart(room){if(room.rematchTimer)clearInterval(room.rematchTimer);initGame(room);io.to(room.id).emit('game_restarted');broadcastState(room);scheduleBot(room)}

function play(room,pid,idx){
 const s=room.state,h=s.hands[pid];if(!h||idx<0||idx>=h.length)return false;
 const my=s.playersInfo.findIndex(p=>p.id===pid),defId=s.playersInfo[s.defenderIdx].id;
 const card=h[idx];
 if(pid!==defId){
   if(!s.table.length){if(my!==s.attackerIdx)return false}
   else{
     if(!ranksOnTable(s.table).has(card.rank))return false;
     const max=Math.min(MAX_CARDS,(s.hands[defId]||[]).length+defended(s.table));
     if(s.table.length>=max)return false;
   }
   h.splice(idx,1);s.table.push({attack:card,defense:null,attackerId:pid});s.currentThrowerIdx=my;
   return true;
 }else{
   if(!s.table.length)return false;
   const u=s.table.findIndex(p=>!p.defense);if(u<0)return false;
   if(!cardCanBeat(s.table[u].attack,card,s.trumpSuit))return false;
   h.splice(idx,1);s.table[u].defense=card;return true;
 }
}
function take(room,pid){
 const s=room.state;if(s.playersInfo[s.defenderIdx].id!==pid||!s.table.length)return false;
 const h=s.hands[pid];for(const p of s.table){h.push(p.attack);if(p.defense)h.push(p.defense)}
 s.table=[];sortHand(h,s.trumpSuit);refill(room);
 if(gameOver(room))return true;
 s.attackerIdx=(s.defenderIdx+1)%s.playersInfo.length;s.defenderIdx=(s.attackerIdx+1)%s.playersInfo.length;s.currentThrowerIdx=s.attackerIdx;
 return true;
}
function done(room,pid){
 const s=room.state,idx=s.playersInfo.findIndex(p=>p.id===pid);if(idx<0||idx!==s.currentThrowerIdx||s.playersInfo[s.defenderIdx].id===pid||!s.table.length||!s.table.every(p=>p.defense))return false;
 s.table=[];refill(room);if(gameOver(room))return true;
 s.attackerIdx=s.defenderIdx;s.defenderIdx=(s.attackerIdx+1)%s.playersInfo.length;s.currentThrowerIdx=s.attackerIdx;return true;
}
function pass(room,pid){
 const s=room.state,idx=s.playersInfo.findIndex(p=>p.id===pid);
 if(idx<0||s.currentThrowerIdx!==idx||!s.table.length||!s.table.every(p=>p.defense))return false;
 let n=(idx+1)%s.playersInfo.length;if(n===s.defenderIdx)n=(n+1)%s.playersInfo.length;
 s.currentThrowerIdx=n;return true;
}

function scheduleBot(room){if(!room.state||room.state.isGameOver)return;if(room.botLoop)clearTimeout(room.botLoop);room.botLoop=setTimeout(()=>botTurn(room),650)}
function botTurn(room){
 if(!room.state||room.state.isGameOver)return;
 const s=room.state,def=s.playersInfo[s.defenderIdx],u=s.table.findIndex(p=>!p.defense);
 if(u>=0){
   if(!def.isBot){broadcastState(room);return}
   const h=s.hands[def.id],a=s.table[u].attack;
   let best=-1,bestScore=Infinity;
   h.forEach((c,i)=>{if(cardCanBeat(a,c,s.trumpSuit)){const score=(c.suit===s.trumpSuit?100:0)+c.value;if(score<bestScore){bestScore=score;best=i}}});
   if(best>=0)play(room,def.id,best);else take(room,def.id);
   broadcastState(room);scheduleBot(room);return;
 }
 if(!s.table.length){
   const att=s.playersInfo[s.attackerIdx];
   if(!att.isBot){broadcastState(room);return}
   const h=s.hands[att.id];if(!h.length){if(gameOver(room))return}
   let best=h.findIndex(c=>c.suit!==s.trumpSuit);if(best<0)best=0;
   play(room,att.id,best);broadcastState(room);scheduleBot(room);return;
 }
 const thrower=s.playersInfo[s.currentThrowerIdx];
 if(thrower.id===def.id||!(s.hands[thrower.id]||[]).length){pass(room,thrower.id);scheduleBot(room);return}
 if(!thrower.isBot){broadcastState(room);return}
 const ranks=ranksOnTable(s.table),h=s.hands[thrower.id];
 const max=Math.min(MAX_CARDS,s.hands[def.id].length+defended(s.table));
 if(s.table.length<max){
   let idx=h.findIndex(c=>ranks.has(c.rank));
   if(idx>=0){play(room,thrower.id,idx);broadcastState(room);scheduleBot(room);return}
 }
 const allCovered=s.table.every(p=>p.defense);
 if(allCovered)done(room,thrower.id);
 else pass(room,thrower.id);
 broadcastState(room);scheduleBot(room);
}

io.on('connection',socket=>{
 socket.on('create_room',data=>{
   const max=Math.max(2,Math.min(4,parseInt(data?.maxPlayers)||2));
   const room=makeRoom(newCode(),max,{id:socket.id,isBot:false,name:safeName(data?.playerName)});
   rooms.set(room.id,room);socket.join(room.id);socket.emit('room_created',{code:room.id,maxPlayers:max});broadcastLobby(room);
 });
 socket.on('play_with_bots',data=>{
   const room=makeRoom(newCode('BOTS_'),2,{id:socket.id,isBot:false,name:safeName(data?.playerName)});
   rooms.set(room.id,room);socket.join(room.id);fillBot(room);initGame(room);broadcastState(room);scheduleBot(room);
 });
 socket.on('join_room',data=>{
   const code=String(data?.roomCode||'').trim().toUpperCase(),room=rooms.get(code);
   if(!room)return socket.emit('error_msg','Комната не найдена');
   if(room.state)return socket.emit('error_msg','Игра уже началась');
   if(room.players.length>=room.maxPlayers)return socket.emit('error_msg','Комната заполнена');
   room.players.push({id:socket.id,isBot:false,name:safeName(data?.playerName,`Игрок ${room.players.length+1}`)});
   socket.join(code);broadcastLobby(room);
   if(room.players.length===room.maxPlayers){clearTimers(room);initGame(room);broadcastState(room);scheduleBot(room)}
 });
 socket.on('player_action',data=>{
   const room=rooms.get(data?.roomCode),pid=socket.id;if(!room||!room.state||room.state.isGameOver)return;
   let ok=false;
   if(data.action==='play_card')ok=play(room,pid,Number(data.cardIdx));
   else if(data.action==='take')ok=take(room,pid);
   else if(data.action==='done')ok=done(room,pid);
   else if(data.action==='pass')ok=pass(room,pid);
   if(!ok)return socket.emit('error_msg','Сейчас это действие недоступно');
   if(room.botLoop)clearTimeout(room.botLoop);
   if(gameOver(room)){broadcastState(room);return}
   broadcastState(room);scheduleBot(room);
 });
 socket.on('vote_rematch',code=>{
   const room=rooms.get(code);if(!room||!room.state?.isGameOver)return;
   room.rematchVotes.add(socket.id);const hp=humanPlayers(room);io.to(code).emit('rematch_voted',{votesCount:room.rematchVotes.size,totalNeeded:hp.length});
   if(hp.length&&room.rematchVotes.size>=hp.length)restart(room);
 });
 socket.on('leave_room',code=>removePlayer(socket.id,code));
 socket.on('disconnect',()=>{for(const [code,room] of rooms)if(room.players.some(p=>p.id===socket.id)){removePlayer(socket.id,code);break}});
});
function removePlayer(pid,code){
 const room=rooms.get(code);if(!room)return;clearTimers(room);
 const idx=room.players.findIndex(p=>p.id===pid);if(idx<0)return;
 room.players.splice(idx,1);
 if(!humanPlayers(room).length){rooms.delete(code);return}
 if(room.state&&!room.state.isGameOver){io.to(code).emit('opponent_disconnected');rooms.delete(code)}
 else broadcastLobby(room);
}
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`SANI GROUP Durak Premium: http://localhost:${PORT}`));
