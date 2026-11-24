# ⚔️ English Duel

A real-time English quiz duel for 3 people: one referee and two players, each on their own screen. There is no database and no backend: the referee's browser runs the game, and the players connect to it directly.

## How it works

1. Everyone opens the site and sees **"Game in progress…"**.
2. At a random moment (every 1–10 min) a **"DUEL!"** alert shows up on every screen at the same time.
3. Each person picks a role:
   - **Referee**: creates the room (duel length, question categories) and gets a 4-letter code. Their page runs the game, so it must stay open.
   - **Player**: enters the room code and their name.
4. When both players are in, the referee starts the duel. After a 3-2-1 countdown, the shared timer starts.
5. Each player answers their own multiple-choice questions (4 choices). A correct answer is worth 1 point and a wrong one is worth 0. Either way, the next question comes right after.
6. When the timer ends, the referee sees both scores and the winner. Each player sees only their own score.

## How it works without a server

- **Connections**: they are peer-to-peer (WebRTC) through [PeerJS](https://peerjs.com).
  - The referee's page registers as `english-duel-v1-<CODE>` on the free PeerJS service.
  - Players use it only to find the referee, then talk to them directly.
  - If a direct connection is impossible (strict networks), PeerJS falls back to its relay servers.
- **The game itself** ([`public/host.js`](public/host.js)) runs in the referee's browser:
  - it keeps the questions, scores and timer;
  - it checks every answer.
- **Reloads**:
  - If a player reloads, they get their seat back.
  - If the referee reloads, the room is reopened and the players reconnect automatically.
  - If the referee closes the tab, the room ends.
- **The random "DUEL!" alert**: every page computes the same pseudo-random alert times from the date, so all screens go off together without talking to each other. Devices keep their clocks in sync over the internet.
  - A screen that was asleep (locked phone, background tab) still shows an alert it missed when it wakes up, up to 2 min late.
  - To test it, add `?alert=0.2-0.5` (minutes) to the URL on every screen.
- **The "Duel now" button and the screen counter** use a shared waiting room:
  - The first open page claims the PeerJS id `english-duel-v1-lobby` and becomes the hub; the other pages connect to it.
  - "Duel now" on any screen goes through the hub, which rings every connected screen.
  - Every 3 s, each screen checks that the hub still answers. If the hub page is closed, the remaining screens elect a new hub within about 15 s.
  - Pages opened on `localhost` use a separate waiting room (`…-lobby-dev`), so local tests never ring the real site.

## Deploy on Vercel

The site is plain static files in `public/`, and `vercel.json` already sets that up.
1. Import the GitHub repo in Vercel.
2. Keep the defaults and deploy.

No environment variables or storage are needed.

## Run it locally

```bash
npm start
```

Then open http://localhost:3000. It needs an internet connection for PeerJS. You can also play on several tabs of the same browser.

## Questions

Questions are in [`public/questions.js`](public/questions.js). Each question has a category, the correct answer `a`, and three wrong answers `w`:

```js
{ c: 'Translate', q: 'Translate: "une fourchette"', a: 'a fork', w: ['a spoon', 'a knife', 'a plate'] },
```
