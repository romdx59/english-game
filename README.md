# ⚔️ English Duel

A quick English quiz duel between two players on **one screen**. It has no server, no database and no network connection: everything runs in the page, so it also works on 4G or offline once loaded.

## How it works

1. Open the site and leave it on **"Game in progress…"** while you play something else.
2. At a random moment (every 1–10 min) the screen flashes **"DUEL!"** with a siren. The person who was playing picks an opponent.
   - **Duel now** shows the alert right away.
   - If the device was asleep at that moment (locked screen, background tab), the alert shows as soon as it wakes up.
3. The referee types both names, the duel length and the question categories, then starts the duel.
4. After a 3-2-1 countdown, the shared timer starts. The screen is split in two: each player has their own multiple-choice questions (4 choices) and their own score.
   - A correct answer is worth 1 point and a wrong one is worth 0. Either way, the next question comes right after.
   - **On a computer**: player 1 (left) answers with keys **A Z E R**, player 2 (right) with **U I O P**. These are the physical key positions, so on a QWERTY keyboard player 1 uses Q W E R.
   - **On a tablet or phone held upright**: players sit face to face. The top half is upside down for the player across the table, and each player taps their own half.
5. When the timer ends, the screen shows both scores and the winner. Draws are possible. Then choose **Rematch** or **Back to the game**.

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
