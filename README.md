# ⚔️ English Duel

A quick English quiz duel between two players on **one screen**, played with a single mouse. It has no server, no database and no network connection: everything runs in the page, so it also works on 4G or offline once loaded.

## How it works

1. Open the site and leave it on **"Game in progress…"** while you play something else.
2. At a random moment (every 1–10 min) the screen flashes **"DUEL!"** with a siren. The person who was playing picks an opponent.
   - **Duel now** shows the alert right away.
   - If the device was asleep at that moment (locked screen, background tab), the alert shows as soon as it wakes up.
3. The referee types both names, the time per player (60 s by default), who starts (random by default) and the question categories, then starts the duel.
4. After a 3-2-1 countdown, it's a **chess-clock duel**. Each player has their own clock, and only the player whose turn it is answers (4 choices); their clock is running.
   - **Correct answer**: +1. Their clock stops, and both clocks stay stopped for 1 s while the mouse changes hands. Then the opponent's clock starts with a new question.
   - **Wrong answer**: the right answer is shown, then a new question comes. Their clock keeps running.
   - **The first player to reach 0:00 loses.**
   - Keys **1 2 3 4** also answer. **Space** pauses.
5. At the end, the screen shows the winner, the time each player had left and their correct answers. Then choose **Rematch** or **Back to the game**. In a rematch with "Random" start, the loser starts.

The last duels are listed on the waiting screen. They are saved in this browser only.

To test the alert quickly, open the site with `?alert=0.1-0.2` (minutes) at the end of the URL.

## Deploy on Vercel

The site is plain static files in `public/`, and `vercel.json` already sets that up.
1. Import the GitHub repo in Vercel.
2. Keep the defaults and deploy.

## Run it locally

```bash
npm start
```

Then open http://localhost:3000. You can also just open `public/index.html` in a browser.

## Questions

Questions are in [`public/questions.js`](public/questions.js). Each question has a category, the correct answer `a`, and three wrong answers `w`:

```js
{ c: 'Translate', q: 'Translate: "une fourchette"', a: 'a fork', w: ['a spoon', 'a knife', 'a plate'] },
```
