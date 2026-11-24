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

## Deploy on Vercel

The API lives in [`api/`](api) as Vercel serverless functions, and the game state is stored in **Upstash Redis**. Serverless functions can't keep anything in memory between requests, which is why Redis is needed.

1. Import this GitHub repo in Vercel (**Add New → Project**). Keep the defaults: framework preset **Other**, no build command. `vercel.json` already sets the output directory to `public`.
2. In the project, open **Storage → Create Database → Upstash (Redis)**, use the free plan, and connect it to the project. This adds the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables.
3. **Redeploy** so the functions pick up the new variables.

If Redis is missing, the waiting screen shows a red message explaining what to do.

Optional environment variables (Project → Settings → Environment Variables):

| Variable | Default | Meaning |
|---|---|---|
| `DUEL_MIN_MINUTES` | `1` | Earliest random "DUEL!" alert |
| `DUEL_MAX_MINUTES` | `10` | Latest random "DUEL!" alert |

## Run it locally

Requires Node.js 18+. There are no dependencies.

```bash
npm start
```

Then open http://localhost:3000. Without Redis variables, the state is kept in memory. With `KV_REST_API_URL` and `KV_REST_API_TOKEN` set, the local server uses Redis like on Vercel. `PORT` changes the port.

## How the live part works

There is no open connection to the server, so it runs on serverless hosting.
- **The "DUEL!" alert:** the server stores the time of the next alert in Redis. Every page asks for it every 4 s and fires the alert at that exact time, so all screens go off together.
- **During a duel:** pages fetch the room state every 0.7 s. The timer is computed on each screen from the shared end time, so it stays smooth.
- **Answers:** each answer is checked on the server, which then sends back the next question right away.

## Questions

Questions are in [`questions.js`](questions.js). Each question has a category, the correct answer `a`, and three wrong answers `w`:

```js
{ c: 'Translate', q: 'Translate: "une fourchette"', a: 'a fork', w: ['a spoon', 'a knife', 'a plate'] },
```
