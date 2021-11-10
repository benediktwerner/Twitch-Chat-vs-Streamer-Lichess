# Twitch-Chat-vs-Streamer-Lichess

## Setup:

1) Install [Node.js](https://nodejs.org/en/download/).

2) Download Twitch-Chat-vs-Streamer-Lichess and navigate to the folder in Terminal (Mac/Linux) or Command Prompt (Windows).

3) Run `npm i`. Note: if you get an error, try running `sudo npm i` on Mac/Linux or running the Command Prompt as Administrator on Windows.

4) Copy or rename the `config.sample.js` file to `config.js` and adjust the values:
```js
module.exports = {
  STREAMER_TWITCH: '',				// Streamer's Twitch username
  STREAMER_LICHESS: '',				// Streamer's Lichess username
  AUTHORIZED_USERS: [],				// List of usernames that can change the voting period via !setvotingperiod 42
  BOT_TWITCH_OAUTH: 'oauth:...',	// Bot's Twitch oauth token
  BOT_LICHESS: '',					// Bot's Lichess account
  BOT_LICHESS_OAUTH: 'lip_...',		// Bot's Lichess token
  CHAT_COOLDOWN: 2000,				// Minimum time between chat messages in ms (only really relevant when ACKNOWLEDGE_VOTE is enabled)
  VOTING_PERIOD: 20,				// Time to vote in s
  ACKNOWLEDGE_VOTE: false,			// Acknowledge each vote in the chat
};
```

You can get the twitch oauth token [here](https://twitchapps.com/tmi/).

5) Run `node index.js` to start the bot. The current votes can be viewed at [localhost:3000](localhost:3000) which can be added as a browser source to OBS. Append `?transparent=true` to the URL to make the background transparent and only show the text.

6) Challenge the Lichess bot. It will automatically accept challenges from the streamer's account and instructions will be sent to chat!

## How to vote

- `Ne3`
- `resign`
- `offer draw` or `accept draw` (separate from voting to move or resign, i.e. you can both vote to draw and for a move/resign)
