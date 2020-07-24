/*
To-do:
 - vote to offer draw
 - vote to resign
 - web page to put on stream that visualizes the voting process
*/

// vvvv for debugging
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

var OPTS = require('./config.js');

/*
OPTS:
{
	STREAMER: 'streamer's twitch username',
	STREAMER_LICHESS: 'streamer's lichess username',
	TWITCH_OAUTH: 'oauth token for bot's twitch account,
	LICHESS_OAUTH: 'oauth token for bot's lichess account,
	CHAT_COOLDOWN: time in milliseconds to wait between sending messages (1-2 seconds is good) not needed if bot is vip or mod,
	VOTING_PERIOD: time in seconds that chat has to vote
};
*/

var messageQueue = [];

const { Chess } = require('chess.js');
const chess = new Chess();
var sloppyPGN = false;
var candidates = {};
var voters = [];
var ongoingGames = {};

const https = require('https');
const tmi = require('tmi.js');

const client = new tmi.Client({
	options: { debug: false }, // set to false to get rid of console messages
	connection: {
		secure: true,
		reconnect: true
	},
	identity: {
		username: 'TTVChat',
		password: OPTS.TWITCH_OAUTH
	},
	channels: [ OPTS.STREAMER ]
});

client.connect();

client.on('join', () => {
	let userstate = client.userstate[`#${OPTS.STREAMER.toLowerCase()}`];
	OPTS.COOLDOWN_APPLIES = !(userstate.mod || (userstate.badges && userstate.badges.vip));

	if (OPTS.COOLDOWN_APPLIES) {
		setInterval(() => {
			let msg;
			if (msg = messageQueue.shift()) client.say(OPTS.STREAMER, msg)
		}, OPTS.CHAT_COOLDOWN);
	}
});

client.on('message', (channel, tags, message, self) => {
	if (self) return;

	// console.log(sloppyPGN !== false , /^[RNBKQqK0-8a-h+#]{1,7}$/.test(message) , !voters.includes(tags.username))
	// console.log(voters);
	if (sloppyPGN !== false && /^[RNBKQqK0-8a-h+#x]{1,7}$/.test(message) && !voters.includes(tags.username)) { // regex here is a *very* crude filter to only let messages that might be moves in
		chess.load_pgn(sloppyPGN, { sloppy: true });
		
		let move;
		if (move = chess.move(message, { sloppy: true })) {
			let UCI = move.from + move.to;
			if (candidates[UCI])
				candidates[UCI]++;
			else
				candidates[UCI] = 1;

			voters.push(tags.username)

			client.say(channel, `@${tags['display-name']} voted for ${UCI}!`);

			// console.log(candidates);
		}
	}
});

function streamIncomingEvents() {
    const options = {
        hostname: 'lichess.org',
        path: '/api/stream/event',
        headers: { Authorization: `Bearer ${OPTS.LICHESS_OAUTH}` }
    };

    return new Promise((resolve, reject) => {
        https.get(options, (res) => {
            res.on('data', (chunk) => {
                let data = chunk.toString();
                try {
                	let json = JSON.parse(data);

                	if (json.type === 'challenge' && json.challenge.challenger.id === OPTS.STREAMER_LICHESS.toLowerCase()) {
                		beginGame(json.challenge.id);
                	}
                } catch (e) { return; }
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
        headers: { Authorization: `Bearer ${OPTS.LICHESS_OAUTH}` }
    };

    return new Promise((resolve, reject) => {
        https.get(options, (res) => {
            res.on('data', async (chunk) => {
                let data = chunk.toString();
                if (!data.trim()) return;
                try {
                	let json = JSON.parse(data);

                	if (json.type === 'gameFull') {
                		ongoingGames[gameId].white = json.white.title === 'BOT'; // assumes we're not playing against a bot account
                		json = json.state;
                	}
                	if (json.type === 'gameState') {
                		if (json.status === 'started') {
	                		let numMoves = json.moves ? json.moves.split(' ').length : 0;
	                		if (numMoves % 2 != ongoingGames[gameId].white) {
	                			// bot's turn to move
	                			if (numMoves >= 1) {
	                				say(`Opponent played: ${json.moves.split(' ').pop()}`);
	                			}

	                			await initiateVote(gameId, json.moves);
	                		}
                		} else if (json.winner || json.status === 'draw') {
                			if (json.status === 'draw') resolve('draw');
                			if (json.winner === 'white' ^ ongoingGames[gameId].white)
                				resolve('streamer');
                			else
                				resolve('chat');
                		}
                	}
                } catch (e) { console.log(`Data: ${data}`, `Error: ${e}`); }
            });
            res.on('end', () => {
                resolve();
            });
        });
    });
}

function say(msg) {
	console.log(...arguments);

	if (OPTS.COOLDOWN_APPLIES)
		messageQueue.push(msg);
	else
		client.say(OPTS.STREAMER, msg);
}

async function initiateVote(gameId, moves, revote=0) {
	if (!Object.keys(ongoingGames).includes(gameId)) return;
	// say(revote ? `Nobody voted for a valid move! You have ${OPTS.VOTING_PERIOD} seconds to vote again. (${revote})` : `Voting time! You have ${OPTS.VOTING_PERIOD} seconds to name a move (UCI format, ex: e2e4).`);
	if (!revote) say(`Voting time! You have ${OPTS.VOTING_PERIOD} seconds to name a move (UCI format, ex: 'e2e4').`);
	sloppyPGN = moves;
	setTimeout(async () => {
		var arr = Object.keys(candidates).map(key => [key, candidates[key]]);
		if (arr.length == 0) {
			await initiateVote(gameId, moves, ++revote);
			return;
		}
		var winningMove = arr.sort((a, b) => b[1] - a[1])[0][0];

		sloppyPGN = false;
		voters = [];
		candidates = {};

		await makeMove(gameId, winningMove);
		say(`Playing move: ${winningMove}`);
	}, OPTS.VOTING_PERIOD * 1000);
}

async function beginGame(gameId) {
	try {
		if (await acceptGame(gameId)) {
			say('Game started!', gameId);
			ongoingGames[gameId] = { white: null };
			var result = await streamGameState(gameId);
			delete ongoingGames[gameId];
			switch (result) {
				case 'draw':
					say('Game over - It\'s a draw!', gameId);
					break;
				case 'chat':
					say('Chat wins! PogChamp', gameId);
					break;
				case 'streamer':
					say(`${OPTS.STREAMER} wins! Better luck next time chat.`, gameId);
					break;
				default: // should only happen if game state stops streaming for unknown reason
					say('Game over.', gameId);
			}
		}
	} catch (e) {
		console.log(e);
	}
}

async function acceptGame(gameId) {
	const options = {
        hostname: 'lichess.org',
        path: `/api/challenge/${gameId}/accept`,
        headers: { Authorization: `Bearer ${OPTS.LICHESS_OAUTH}` },
        method: 'POST'
    };

    return new Promise((resolve, reject) => {
    	var req = https.request(options, (res) => {
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
        headers: { Authorization: `Bearer ${OPTS.LICHESS_OAUTH}` },
        method: 'POST'
    };

    return new Promise((resolve, reject) => {
    	var req = https.request(options, (res) => {
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

async function makeMove(gameId, move, draw=false) {
	const options = {
        hostname: 'lichess.org',
        path: `/api/bot/game/${gameId}/move/${move}?offeringDraw=${draw}`,
        headers: { Authorization: `Bearer ${OPTS.LICHESS_OAUTH}` },
        method: 'POST'
    };

    return new Promise((resolve, reject) => {
    	var req = https.request(options, (res) => {
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