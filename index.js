// vvvv for debugging
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const OPTS = require('./config.js');

const messageQueue = [];

const REGEX = {
  SET_VOTING_PERIOD: /^!setvotingperiod \d+$/i,
  POTENTIAL_MOVE: /^([NBRQK0-8a-h+#x=]{2,7}|resign|offer draw|accept draw|offer\/accept draw)$/i, // very crude guesstimate
  KINGSIDE_CASTLE: /^[Oo0]-[Oo0]$/,
  QUEENSIDE_CASTLE: /^[Oo0]-[Oo0]-[Oo0]$/,
};

const { Chess } = require('chess.js');
let games = {};
let cooldownInterval;

// Socket.io part ---------------------------------------------

let app = require('express')();
let http = require('http').createServer(app);
let io = require('socket.io')(http);
let port = 3000;

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/votes.html');
});

io.on('connection', (socket) => {
  socket.on('streamer', (streamer) => {
    socket.join(streamer.toLowerCase());
    let game = games[gameIdFromTwitch(streamer)];
    if (game) socket.emit('candidates', game.candidates);
  });
});

http.listen(port, () => {
  console.log(`Express server listening on *:${port}`);
});

// ------------------------------------------------------------

// module to send http requests / communicate with the lichess api
const https = require('https');

// twitch messaging interface module
const tmi = require('tmi.js');

const client = new tmi.Client({
  options: { debug: true },
  connection: {
    secure: true,
    reconnect: true,
  },
  identity: {
    username: 'TTVChat', // just realized--this is wrong.. why does it still work?
    password: OPTS.BOT_TWITCH_OAUTH,
  },
  channels: [OPTS.STREAMER_TWITCH],
});

// connect twitch client
client.connect();

// twitch client joins the streamer's chat
client.on('join', () => {
  let userstate = client.userstate[`#${OPTS.STREAMER_TWITCH.toLowerCase()}`];
  OPTS.CHAT_COOLDOWN_APPLIES = !isModOrVIP(userstate);

  if (OPTS.CHAT_COOLDOWN_APPLIES && !cooldownInterval)
    cooldownInterval = setInterval(shiftChatQueue, OPTS.CHAT_COOLDOWN);
});

function isModOrVIP(userstate) {
  return userstate.mod || (userstate.badges && userstate.badges.vip);
}
function shiftChatQueue() {
  let msg;
  if ((msg = messageQueue.shift())) client.say(OPTS.STREAMER_TWITCH, msg);
}
function userIsAuthorized(username) {
  return OPTS.AUTHORIZED_USERS.includes(username);
}
function isBotsTurn(game) {
  return !(game.sloppyPGN === null);
}
function alreadyVoted(username, game) {
  return game.voters.has(username);
}
function alreadyOfferedDraw(username, game) {
  return game.offeringDraw.has(username);
}
function isDrawOffer(message) {
  return (
    message.toLowerCase().trim() === 'offer draw' ||
    message.toLowerCase().trim() === 'accept draw' ||
    message.toLowerCase().trim() === 'offer/accept draw'
  );
}
function checkMove(possibleMove, gameId) {
  let chess = games[gameId].initialFen ? new Chess(games[gameId].initialFen) : new Chess();
  for (move of games[gameId].sloppyPGN.split(' ')) {
    chess.move(move, { sloppy: true });
  }
  let result;
  if (possibleMove.toLowerCase().trim() === 'resign') return 'resign';
  else if (isDrawOffer(possibleMove)) return 'draw';
  else if ((result = chess.move(possibleMove, { sloppy: true }))) return result;
  else return chess.move(possibleMove.charAt(0).toUpperCase() + possibleMove.slice(1), { sloppy: true });
}
function emitCandidates(game) {
  io.to(game.streamer.twitch).emit('candidates', game.candidates);
}
function validChallenge(json) {
  return json.type === 'challenge' && json.challenge.challenger.id === OPTS.STREAMER_LICHESS.toLowerCase();
}
function gameIdFromTwitch(twitch) {
  for (const gameId of Object.keys(games)) {
    let game = games[gameId];
    if (game.streamer.twitch === twitch.toLowerCase()) return gameId;
  }
  return false;
}

let username = 'a';

client.on('message', (channel, tags, message, self) => {
  if (self) return;

  if (userIsAuthorized(tags.username) && REGEX.SET_VOTING_PERIOD.test(message)) {
    const votingPeriod = parseInt(message.split(' ')[1]);
    if (votingPeriod && votingPeriod > 3 && votingPeriod < 1200) {
      OPTS.VOTING_PERIOD = votingPeriod;
      say(`Voting period is now ${OPTS.VOTING_PERIOD} seconds.`);
    }
    return;
  }

  if (userIsAuthorized(tags.username) && message === '!cu') {
    username += 'a';
  }
  tags.username = username;

  channel = channel.substr(1);
  let gameId = gameIdFromTwitch(channel);
  let game = games[gameId];
  if (
    game &&
    isBotsTurn(game) &&
    REGEX.POTENTIAL_MOVE.test(message) &&
    ((!alreadyVoted(tags.username, game) && !isDrawOffer(message)) ||
      (!alreadyOfferedDraw(tags.username, game) && isDrawOffer(message)))
  ) {
    if (REGEX.KINGSIDE_CASTLE.test(message)) message = 'O-O';
    else if (REGEX.QUEENSIDE_CASTLE.test(message)) message = 'O-O-O';

    const move = checkMove(message, gameId);
    if (move) {
      const key = move === 'resign' || move === 'draw' ? move : move.from + move.to;

      if (game.candidates[key]) game.candidates[key].votes++;
      else game.candidates[key] = { votes: 1, san: move.san };

      (key === 'draw' ? game.offeringDraw : game.voters).add(tags.username);

      game.candidates.total = new Set([...game.offeringDraw, ...game.voters]).size;

      emitCandidates(game);

      // log the vote
      const msg = `@${tags['display-name']} voted ${
        move === 'resign' ? 'to resign.' : move === 'draw' ? 'to offer/accept a draw.' : `for ${move.san}`
      }`;
      if (OPTS.ACKNOWLEDGE_VOTE) say(msg);
      else console.log(msg);
    }
  }
});

function streamIncomingEvents() {
  const options = {
    hostname: 'lichess.org',
    path: '/api/stream/event',
    headers: { Authorization: `Bearer ${OPTS.BOT_LICHESS_OAUTH}` },
  };

  return new Promise((resolve, reject) => {
    https.get(options, (res) => {
      res.on('data', (chunk) => {
        let data = chunk.toString();
        try {
          let json = JSON.parse(data);
          if (validChallenge(json)) {
            acceptChallenge(json.challenge.id);
          } else if (json.type === 'gameStart') {
            beginGame(json.game.id);
          }
        } catch (e) {
          return;
        }
      });
      res.on('end', () => {
        reject(new Error('[streamIncomingEvents()] Stream ended.'));
      });
    });
  });
}

async function streamGameState(gameId) {
  const options = {
    hostname: 'lichess.org',
    path: `/api/bot/game/stream/${gameId}`,
    headers: { Authorization: `Bearer ${OPTS.BOT_LICHESS_OAUTH}` },
  };

  return new Promise((resolve, reject) => {
    https.get(options, (res) => {
      res.on('data', async (chunk) => {
        let data = chunk.toString();
        if (!data.trim()) return;
        try {
          let lines = data.split('\n');
          for (const line of lines) {
            if (!line) return;
            let json = JSON.parse(line);

            if (json.type === 'gameFull') {
              // game started
              let initialFen = json.initialFen;
              games[gameId].initialFen = initialFen === 'startpos' ? null : initialFen;
              games[gameId].white = json.white.id === OPTS.BOT_LICHESS.toLowerCase();
              json = json.state;
            }
            if (json.type === 'gameState') {
              if (json.status === 'started') {
                // game in progress
                let numMoves = json.moves ? json.moves.split(' ').length : 0;
                if (numMoves % 2 != games[gameId].white) {
                  // bot's turn to move
                  if (numMoves >= 1) {
                    let moves = json.moves.split(' ');
                    let streamerMove = moves.pop();
                    let chess = games[gameId].initialFen ? new Chess(games[gameId].initialFen) : new Chess();
                    for (const move of moves) {
                      chess.move(move, { sloppy: true });
                    }
                    streamerMove = chess.move(streamerMove, { sloppy: true });
                    say(`Streamer played: ${streamerMove.san}`);
                  }

                  await initiateVote(gameId, json.moves);
                }
              } else if (json.winner || json.status === 'draw') {
                // game over
                if (json.status === 'draw') resolve('draw');
                if ((json.winner === 'white') ^ games[gameId].white) resolve('streamer');
                else resolve('chat');
              }
            }
          }
        } catch (e) {
          console.log(`Data: ${data}`, `Error: ${e}`);
        }
      });
      res.on('end', () => {
        resolve();
      });
    });
  });
}

function say(msg) {
  console.log(...arguments);

  if (OPTS.CHAT_COOLDOWN_APPLIES) messageQueue.push(msg);
  else client.say(OPTS.STREAMER_TWITCH, msg);
}

async function initiateVote(gameId, moves, revote = 0) {
  const game = games[gameId];
  if (!game) return;
  // say(revote ? `Nobody voted for a valid move! You have ${OPTS.VOTING_PERIOD} seconds to vote again. (${revote})` : `Voting time! You have ${OPTS.VOTING_PERIOD} seconds to name a move (UCI format, ex: e2e4).`);
  if (!revote) say(`Voting time! You have ${OPTS.VOTING_PERIOD} seconds to name a move.`);
  game.sloppyPGN = moves;
  setTimeout(async () => {
    const game = games[gameId];
    if (!game) return;

    const arr = Object.entries(game.candidates).filter(([key, _]) => key !== 'total' && key !== 'draw');
    if (arr.length === 0) {
      await initiateVote(gameId, moves, ++revote);
      return;
    }

    const winningMove = arr.sort(([_, a], [__, b]) => b.votes - a.votes)[0];
    const draw = (game.candidates.draw?.votes ?? 0) / game.candidates.total >= 0.5;

    game.sloppyPGN = null;
    game.voters = new Set();
    game.offeringDraw = new Set();
    game.candidates = {};
    emitCandidates(game);

    if (winningMove[0] === 'resign') await resignGame(gameId);
    else await makeMove(gameId, winningMove[0], draw);
    say(`Playing move: ${winningMove[1].san}`);
  }, OPTS.VOTING_PERIOD * 1000);
}

async function beginGame(gameId) {
  try {
    say('Game started!', gameId);
    games[gameId] = {
      white: null,
      sloppyPGN: null,
      candidates: {},
      voters: new Set(),
      offeringDraw: new Set(),
      streamer: { twitch: OPTS.STREAMER_TWITCH.toLowerCase(), lichess: OPTS.STREAMER_LICHESS },
    };
    let result = await streamGameState(gameId);
    delete games[gameId];
    switch (result) {
      case 'draw':
        say("Game over - It's a draw!", gameId);
        break;
      case 'chat':
        say('Chat wins! PogChamp', gameId);
        break;
      case 'streamer':
        say(`${OPTS.STREAMER_TWITCH} wins! Better luck next time chat.`, gameId);
        break;
      default:
        // should only happen if game state stops streaming for unknown reason
        say('Game over.', gameId);
    }
  } catch (e) {
    console.error(e);
  }
}

async function acceptChallenge(challengeId) {
  const options = {
    hostname: 'lichess.org',
    path: `/api/challenge/${challengeId}/accept`,
    headers: { Authorization: `Bearer ${OPTS.BOT_LICHESS_OAUTH}` },
    method: 'POST',
  };

  return new Promise((resolve, reject) => {
    let req = https.request(options, (res) => {
      res.on('data', (data) => {
        data = JSON.parse(data.toString());
        if (data.ok) {
          resolve(true);
        } else {
          reject(data);
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

async function resignGame(gameId) {
  const options = {
    hostname: 'lichess.org',
    path: `/api/bot/game/${gameId}/resign`,
    headers: { Authorization: `Bearer ${OPTS.BOT_LICHESS_OAUTH}` },
    method: 'POST',
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on('data', (data) => {
        data = JSON.parse(data.toString());
        if (data.ok) {
          resolve(true);
        } else {
          reject(data);
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

async function makeMove(gameId, move, draw = false) {
  const options = {
    hostname: 'lichess.org',
    path: `/api/bot/game/${gameId}/move/${move}?offeringDraw=${draw}`,
    headers: { Authorization: `Bearer ${OPTS.BOT_LICHESS_OAUTH}` },
    method: 'POST',
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on('data', (data) => {
        data = JSON.parse(data.toString());
        if (data.ok) {
          resolve(true);
        } else {
          reject(data);
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

streamIncomingEvents();
