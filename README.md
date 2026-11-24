# ⚔️ English Duel

A real-time English quiz duel for 3 people: one referee and two players, each on their own screen.

## How it works

1. Everyone opens the site and sees **"Game in progress…"**.
2. At a random moment (1–10 min by default) a **"DUEL!"** alert shows up on every screen at the same time.
3. Each person picks a role:
   - **Referee**: creates the room (duel length, question categories) and gets a 4-letter code.
   - **Player**: enters the room code and their name.
4. When both players are in, the referee starts the duel. After a 3-2-1 countdown, the shared timer starts.
5. Each player answers their own multiple-choice questions (4 choices). A correct answer is worth 1 point and a wrong one is worth 0. Either way, the next question comes right after.
6. When the timer ends, the referee sees both scores and the winner. Each player sees only their own score.

## Run it locally

Requires Node.js 18+. There are no dependencies.

```bash
npm start
```

Then open http://localhost:3000.

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DUEL_MIN_MINUTES` | `1` | Earliest random "DUEL!" alert |
| `DUEL_MAX_MINUTES` | `10` | Latest random "DUEL!" alert |

## Questions

Questions are in [`questions.js`](questions.js). Each question has a category, the correct answer `a`, and three wrong answers `w`:

```js
{ c: 'Translate', q: 'Translate: "une fourchette"', a: 'a fork', w: ['a spoon', 'a knife', 'a plate'] },
```

## Hosting

`server.js` is a long-running Node server. It keeps rooms in memory and pushes live updates with Server-Sent Events. Host it somewhere that runs a persistent Node process (Render, Railway, Fly.io, Coolify, a VPS…).
