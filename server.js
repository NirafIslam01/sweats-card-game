const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♣','♦','♥','♠'];
const RVAL  = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const SVAL  = {'♣':1,'♦':2,'♥':3,'♠':4};

// Clockwise seat order (left around the table from bottom)
const CLOCKWISE = [0,4,2,1,3,5];

// Bot player names pool
const BOT_NAMES = ['Ace','Lucky','Bluff','Hawk','Duke','Stone','Rio','Sly'];

// ═══════════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════════
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ═══════════════════════════════════════════════
// DECK & CARDS
// ═══════════════════════════════════════════════
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return d;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cardVal(c)  { return (RVAL[c.rank] || parseInt(c.rank)) * 10 + SVAL[c.suit]; }
function rankVal(r)  { return RVAL[r] || parseInt(r); }

// ═══════════════════════════════════════════════
// HAND EVALUATION
// ═══════════════════════════════════════════════
function evalHand(cards) {
  const rv    = cards.map(c => rankVal(c.rank)).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const flush = suits.every(s => s === suits[0]);

  let straight = new Set(rv).size === 5 && rv[0] - rv[4] === 4;
  const wheel  = JSON.stringify(rv) === JSON.stringify([14,5,4,3,2]);
  if (wheel) straight = true;

  const cnt = {};
  rv.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  const groups  = Object.entries(cnt).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const counts  = groups.map(g => g[1]);
  const ranked  = groups.map(g => parseInt(g[0]));

  let hr, name;
  if      (flush && straight)          { hr = ranked[0]===14&&!wheel ? 9 : 8; name = hr===9 ? 'Royal Flush' : 'Straight Flush'; }
  else if (counts[0] === 4)            { hr = 7; name = 'Four of a Kind'; }
  else if (counts[0]===3&&counts[1]===2){ hr = 6; name = 'Full House'; }
  else if (flush)                      { hr = 5; name = 'Flush'; }
  else if (straight)                   { hr = 4; name = 'Straight'; }
  else if (counts[0] === 3)            { hr = 3; name = 'Three of a Kind'; }
  else if (counts[0]===2&&counts[1]===2){ hr = 2; name = 'Two Pair'; }
  else if (counts[0] === 2)            { hr = 1; name = 'One Pair'; }
  else                                 { hr = 0; name = 'High Card'; }

  return { hr, name, ranked };
}

function cmpHands(a, b) {
  if (a.hr !== b.hr) return a.hr - b.hr;
  for (let i = 0; i < Math.min(a.ranked.length, b.ranked.length); i++) {
    if (a.ranked[i] !== b.ranked[i]) return a.ranked[i] - b.ranked[i];
  }
  return 0;
}

// ═══════════════════════════════════════════════
// BOT LOGIC
// ═══════════════════════════════════════════════
function botDecide(game, idx) {
  const p          = game.players[idx];
  const faceUpCard = p.cards.find(c => c.faceUp);
  const faceUpRv   = faceUpCard ? (RVAL[faceUpCard.rank] || parseInt(faceUpCard.rank)) : 0;

  if (game.phase === 'first_turn') {
    // Can't see face-down cards — decides purely on face-up card strength
    const playChance = faceUpRv >= 10 ? 0.72   // 10,J,Q,K,A
                     : faceUpRv >= 7  ? 0.52   // 7,8,9
                     :                  0.35;  // 2–6
    return Math.random() < playChance ? 'play' : 'fold';
  } else {
    // other_turns: can see all 5 cards — evaluate hand
    const allCards = p.cards.filter(c => c.rank);
    if (allCards.length < 5) return Math.random() < 0.5 ? 'play' : 'fold';
    const result   = evalHand(allCards);
    const playChance = result.hr === 0 ? 0.22   // High Card
                     : result.hr === 1 ? 0.62   // One Pair
                     : result.hr === 2 ? 0.82   // Two Pair
                     :                   0.92;  // Three of a Kind+
    return Math.random() < playChance ? 'play' : 'fold';
  }
}

function scheduleBotTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const game = room.game;
  const cur  = game.players[game.curIdx];
  if (!cur || !cur.isBot) return;
  if (game.phase !== 'first_turn' && game.phase !== 'other_turns') return;

  // Human-feeling delay: 1.2 – 2.4 seconds
  setTimeout(() => {
    if (!rooms[roomCode]) return;
    if (game.phase !== 'first_turn' && game.phase !== 'other_turns') return;
    const action = botDecide(game, game.curIdx);
    if (action === 'fold') doFold(roomCode, game.curIdx);
    else                   doPlay(roomCode, game.curIdx);
  }, 1200 + Math.random() * 1200);
}

// ═══════════════════════════════════════════════
// TURN QUEUE (clockwise from first player)
// ═══════════════════════════════════════════════
function buildTurnQueue(game, firstIdx) {
  const firstSeat = game.players[firstIdx].seat;
  const startPos  = CLOCKWISE.indexOf(firstSeat);
  const queue     = [firstIdx];
  for (let i = 1; i < CLOCKWISE.length; i++) {
    const seatNum = CLOCKWISE[(startPos + i) % CLOCKWISE.length];
    const match   = game.players.find(p => p.seat === seatNum && p.status === 'active');
    if (match) queue.push(game.players.indexOf(match));
  }
  return queue;
}

// ═══════════════════════════════════════════════
// GAME STATE FACTORY
// ═══════════════════════════════════════════════
function newGame(ante) {
  return {
    players:    [],
    deck:       [],
    pot:        0,
    ante:       ante || 2,
    round:      1,
    phase:      'lobby',   // lobby | first_turn | other_turns | showdown | round_over | game_over
    turnQueue:  [],
    firstIdx:   -1,
    curIdx:     -1,
    playedIdxs: [],
    winnerIdxs: [],
    prevPot:    0,
    gameWinnerIdx: -1,
    log:        [],
  };
}

function glog(game, msg) {
  game.log.unshift(msg);
  if (game.log.length > 25) game.log.pop();
}

// ═══════════════════════════════════════════════
// BROADCAST — each player gets a personalised view
// ═══════════════════════════════════════════════
function broadcast(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const game = room.game;

  game.players.forEach((me, myIdx) => {
    const sock = io.sockets.sockets.get(me.id);
    if (!sock) return;

    const personalPlayers = game.players.map((p, pIdx) => {
      const isMe       = pIdx === myIdx;
      const atShowdown = game.phase === 'showdown' || game.phase === 'round_over';
      const canPeek    = game.phase === 'other_turns'; // after first player plays

      return {
        id:         p.id,
        name:       p.name,
        money:      p.money,
        status:     p.status,
        isHost:     p.isHost,
        isFirst:    p.isFirst,
        isBot:      p.isBot || false,
        seat:       p.seat,
        handResult: (atShowdown && p.status === 'played') ? p.handResult : null,
        isMe,
        cards: p.cards.map(c => {
          if (c.faceUp)                                  return c;  // face-up always visible
          if (isMe && (canPeek || atShowdown))           return c;  // you see your own during other_turns+
          if (atShowdown && p.status === 'played')       return c;  // everyone revealed at showdown
          return { hidden: true, faceUp: false };                    // everything else: card back
        }),
      };
    });

    sock.emit('state', {
      phase:         game.phase,
      round:         game.round,
      pot:           game.pot,
      ante:          game.ante,
      players:       personalPlayers,
      curIdx:        game.curIdx,
      firstIdx:      game.firstIdx,
      winnerIdxs:    game.winnerIdxs,
      gameWinnerIdx: game.gameWinnerIdx,
      log:           game.log,
      myIdx,
      isMyTurn: game.curIdx === myIdx &&
                (game.phase === 'first_turn' || game.phase === 'other_turns'),
      isFirstPlayer: myIdx === game.firstIdx &&
                     game.phase === 'first_turn',
    });
  });
}

// ═══════════════════════════════════════════════
// GAME LOGIC
// ═══════════════════════════════════════════════
function startGame(roomCode) {
  const game = rooms[roomCode].game;
  game.pot = 0;
  game.players.forEach(p => {
    const pay = Math.min(game.ante, p.money);
    p.money -= pay;
    game.pot += pay;
  });
  glog(game, 'Game started!');
  dealHand(roomCode);
}

function dealHand(roomCode) {
  const game = rooms[roomCode].game;
  game.playedIdxs = [];
  game.winnerIdxs = [];

  const actives = game.players.filter(p => p.status !== 'out');
  if (actives.length < 2) { endGame(roomCode); return; }

  actives.forEach(p => {
    p.status = 'active'; p.cards = []; p.handResult = null; p.isFirst = false;
  });

  game.deck = shuffle(makeDeck());
  actives.forEach(p => {
    for (let i = 0; i < 4; i++) p.cards.push({ ...game.deck.pop(), faceUp: false });
    p.cards.push({ ...game.deck.pop(), faceUp: true });
  });

  // First player = highest face-up card
  let bestVal = -1, firstP = null;
  actives.forEach(p => {
    const v = cardVal(p.cards[4]);
    if (v > bestVal) { bestVal = v; firstP = p; }
  });

  firstP.isFirst    = true;
  game.firstIdx     = game.players.indexOf(firstP);
  game.turnQueue    = buildTurnQueue(game, game.firstIdx);
  game.curIdx       = game.turnQueue[0];
  game.phase        = 'first_turn';

  glog(game, `— Hand #${game.round}  ·  Pot $${game.pot} —`);
  glog(game, `${firstP.name} acts first (highest face-up card).`);
  broadcast(roomCode);
  scheduleBotTurn(roomCode);
}

function doFold(roomCode, idx) {
  const game = rooms[roomCode].game;
  const p    = game.players[idx];
  const isFirst = idx === game.firstIdx;

  if (isFirst) {
    p.status  = 'out';
    p.isFirst = false;
    glog(game, `${p.name} folded — eliminated from the game!`);
    broadcast(roomCode);
    setTimeout(() => promoteNext(roomCode), 2000);
  } else {
    p.status = 'folded_hand';
    glog(game, `${p.name} folded.`);
    broadcast(roomCode);
    advance(roomCode);
  }
}

function doPlay(roomCode, idx) {
  const game    = rooms[roomCode].game;
  const p       = game.players[idx];
  const isFirst = idx === game.firstIdx;

  p.status = 'played';
  game.playedIdxs.push(idx);
  glog(game, `${p.name} plays.`);

  if (isFirst) {
    game.phase = 'other_turns';
    glog(game, 'Cards unlocked — all players may look at their hands.');
    game.turnQueue.shift();

    if (game.turnQueue.length === 0) {
      broadcast(roomCode);
      setTimeout(() => doShowdown(roomCode), 1000);
    } else {
      game.curIdx = game.turnQueue[0];
      broadcast(roomCode);
      scheduleBotTurn(roomCode);
    }
  } else {
    broadcast(roomCode);
    advance(roomCode);
  }
}

function advance(roomCode) {
  const game = rooms[roomCode].game;
  game.turnQueue.shift();

  if (game.turnQueue.length === 0) {
    // Check game-over condition: first player played + all others folded
    const firstPlayed     = game.playedIdxs.includes(game.firstIdx);
    const othersAllFolded = game.players
      .filter((p, i) => i !== game.firstIdx && p.status !== 'out')
      .every(p => p.status === 'folded_hand');

    if (firstPlayed && othersAllFolded) {
      const winner = game.players[game.firstIdx];
      winner.money += game.pot;
      glog(game, `${winner.name} played — everyone else folded. Game over!`);
      broadcast(roomCode);
      setTimeout(() => endGame(roomCode, game.firstIdx), 2000);
      return;
    }
    broadcast(roomCode);
    setTimeout(() => doShowdown(roomCode), 1000);
  } else {
    game.curIdx = game.turnQueue[0];
    broadcast(roomCode);
    scheduleBotTurn(roomCode);
  }
}

function promoteNext(roomCode) {
  const game      = rooms[roomCode].game;
  const remaining = game.players.filter(p => p.status === 'active');

  if (remaining.length === 0) { endGame(roomCode); return; }
  if (remaining.length === 1) {
    const winner = remaining[0];
    winner.money += game.pot;
    endGame(roomCode, game.players.indexOf(winner));
    return;
  }

  let bestVal = -1, nextFirst = null;
  remaining.forEach(p => {
    const v = cardVal(p.cards[4]);
    if (v > bestVal) { bestVal = v; nextFirst = p; }
  });

  nextFirst.isFirst = true;
  game.firstIdx     = game.players.indexOf(nextFirst);
  game.curIdx       = game.firstIdx;
  game.phase        = 'first_turn';
  game.turnQueue    = buildTurnQueue(game, game.firstIdx);

  glog(game, `${nextFirst.name} now acts first (next highest face-up).`);
  broadcast(roomCode);
  scheduleBotTurn(roomCode);
}

function doShowdown(roomCode) {
  const game = rooms[roomCode].game;
  game.phase = 'showdown';
  glog(game, '— Showdown! —');

  const contestants = game.players.map((p, i) => ({ p, i }))
    .filter(({ p }) => p.status === 'played');

  if (contestants.length === 0) { nextHand(roomCode); return; }

  contestants.forEach(({ p }) => {
    p.cards.forEach(c => c.faceUp = true);
    p.handResult = evalHand(p.cards);
    glog(game, `${p.name}: ${p.handResult.name}`);
  });

  contestants.sort((a, b) => cmpHands(b.p.handResult, a.p.handResult));
  const best    = contestants[0].p.handResult;
  const winners = contestants.filter(e => cmpHands(e.p.handResult, best) === 0);

  if (winners.length > 1) {
    const share = Math.floor(game.pot / winners.length);
    winners.forEach(e => e.p.money += share);
    game.winnerIdxs = winners.map(e => e.i);
    game.prevPot    = game.pot;
    glog(game, `Tie! ${winners.map(e => e.p.name).join(' & ')} each win $${share}.`);
  } else {
    const w = winners[0];
    w.p.money      += game.pot;
    game.winnerIdxs = [w.i];
    game.prevPot    = game.pot;
    glog(game, `${w.p.name} wins $${game.pot} with ${w.p.handResult.name}!`);
  }

  broadcast(roomCode);

  // Bot games: 4s showdown reveal, then auto-advance after 4 more seconds
  // Multiplayer: 8s showdown reveal, human clicks Next Hand
  const isBotGame      = rooms[roomCode]?.isBotGame;
  const showdownDelay  = isBotGame ? 4000 : 8000;

  setTimeout(() => {
    game.phase = 'round_over';
    broadcast(roomCode);
    if (isBotGame) {
      setTimeout(() => {
        if (rooms[roomCode]?.game.phase === 'round_over') nextHand(roomCode);
      }, 4000);
    }
  }, showdownDelay);
}

function nextHand(roomCode) {
  const game   = rooms[roomCode].game;
  const losers = game.playedIdxs.filter(i => !game.winnerIdxs.includes(i));

  game.pot = 0;
  if (losers.length > 0) {
    losers.forEach(i => {
      const p = game.players[i];
      if (p.status === 'out') return;
      const pay = Math.min(game.prevPot, p.money);
      p.money  -= pay;
      game.pot += pay;
      glog(game, `${p.name} antes $${pay}.`);
      if (p.money <= 0) { p.money = 100; glog(game, `${p.name} buys back in for $100.`); }
    });
  } else {
    game.players.filter(p => p.status !== 'out').forEach(p => {
      const pay = Math.min(game.ante, p.money);
      p.money  -= pay;
      game.pot += pay;
    });
  }

  game.players.forEach(p => {
    if (p.status === 'played' || p.status === 'folded_hand') {
      p.status = 'active'; p.isFirst = false; p.handResult = null;
    }
  });

  game.round++;
  game.winnerIdxs = [];
  dealHand(roomCode);
}

function endGame(roomCode, winnerIdx) {
  const game = rooms[roomCode].game;
  game.phase = 'game_over';
  game.gameWinnerIdx = winnerIdx !== undefined ? winnerIdx : -1;
  const winner = winnerIdx !== undefined ? game.players[winnerIdx] : null;
  glog(game, winner ? `Game over! ${winner.name} wins!` : 'Game over!');
  broadcast(roomCode);
}

// ═══════════════════════════════════════════════
// SOCKET EVENTS
// ═══════════════════════════════════════════════
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  // ── Create room ──
  socket.on('create_room', ({ name, ante }) => {
    const code = genCode();
    const game = newGame(ante);

    game.players.push({
      id: socket.id, name: name || 'Player 1',
      money: 100, cards: [], status: 'active',
      isHost: true, isFirst: false, seat: 0, handResult: null,
    });

    rooms[code]        = { game };
    socket.roomCode    = code;
    socket.join(code);

    socket.emit('room_ready', { code });
    broadcast(code);
    console.log(`Room ${code} created by ${name}`);
  });

  // ── Create bot game ──
  socket.on('create_bot_game', ({ name, ante, numBots }) => {
    numBots = Math.max(1, Math.min(5, parseInt(numBots) || 2));
    const code = genCode();
    const game = newGame(ante || 2);

    // Human player at seat 0
    game.players.push({
      id: socket.id, name: (name || 'Player').trim().slice(0, 14),
      money: 100, cards: [], status: 'active',
      isHost: true, isFirst: false, seat: 0, handResult: null, isBot: false,
    });

    // Bot players at remaining seats
    const botPool = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    for (let i = 0; i < numBots; i++) {
      game.players.push({
        id: `bot_${i}_${code}`,
        name: botPool[i] || `Bot ${i + 1}`,
        money: 100, cards: [], status: 'active',
        isHost: false, isFirst: false, seat: i + 1, handResult: null, isBot: true,
      });
    }

    rooms[code]     = { game, isBotGame: true };
    socket.roomCode = code;
    socket.join(code);

    socket.emit('room_ready', { code, isBotGame: true });
    startGame(code);
    console.log(`Bot game ${code} created by ${name} with ${numBots} bots`);
  });

  // ── Join room ──
  socket.on('join_room', ({ name, code }) => {
    const c    = (code || '').toUpperCase().trim();
    const room = rooms[c];

    if (!room)                            { socket.emit('err', 'Room not found.'); return; }
    if (room.game.phase !== 'lobby')      { socket.emit('err', 'Game already started.'); return; }
    if (room.game.players.length >= 6)    { socket.emit('err', 'Room is full (max 6).'); return; }

    const takenSeats = room.game.players.map(p => p.seat);
    const seat       = [0,1,2,3,4,5].find(s => !takenSeats.includes(s));

    room.game.players.push({
      id: socket.id, name: name || 'Player',
      money: 100, cards: [], status: 'active',
      isHost: false, isFirst: false, seat, handResult: null,
    });

    socket.roomCode = c;
    socket.join(c);
    socket.emit('room_ready', { code: c });
    broadcast(c);
    console.log(`${name} joined room ${c}`);
  });

  // ── Start game (host only) ──
  socket.on('start_game', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    const me = room.game.players.find(p => p.id === socket.id);
    if (!me || !me.isHost) { socket.emit('err', 'Only the host can start.'); return; }
    if (room.game.players.length < 2) { socket.emit('err', 'Need at least 2 players to start.'); return; }

    startGame(code);
  });

  // ── Player action (fold / play) ──
  socket.on('action', ({ action }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    const game = room.game;
    const idx  = game.players.findIndex(p => p.id === socket.id);
    if (idx === -1 || game.curIdx !== idx) return;
    if (game.phase !== 'first_turn' && game.phase !== 'other_turns') return;

    if (action === 'fold') doFold(code, idx);
    else if (action === 'play') doPlay(code, idx);
  });

  // ── Next hand (triggered by any player clicking the button) ──
  socket.on('next_hand', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.game.phase !== 'round_over') return;
    nextHand(code);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const game = rooms[code].game;
    const p    = game.players.find(p => p.id === socket.id);
    if (!p) return;

    if (game.phase === 'lobby') {
      // Remove from lobby
      const i = game.players.indexOf(p);
      game.players.splice(i, 1);
      // If host left, assign host to next player
      if (p.isHost && game.players.length > 0) game.players[0].isHost = true;
    } else {
      // Mark out mid-game
      p.status = 'out';
      glog(game, `${p.name} disconnected.`);
      // If it was their turn, advance
      if (game.curIdx === game.players.indexOf(p) &&
          (game.phase === 'first_turn' || game.phase === 'other_turns')) {
        doFold(code, game.players.indexOf(p));
        return;
      }
    }
    broadcast(code);
    console.log(`${p.name} disconnected from room ${code}`);
  });
});

// ═══════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sweats running on http://localhost:${PORT}`));
