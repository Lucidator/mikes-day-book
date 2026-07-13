# Mike's Day Book

Personal daily task and scheduling system: daily task tracking, end-of-day reviews (completed vs rescheduled vs dropped), 2-hour pending-task reminders, priority flags, categories, a 7-day completion chart, and streaks.

Built with React + Vite. Tasks are saved in your browser's localStorage — private to your device, no account or database needed.

## Deploy to Vercel (free) — Option A: no code tools needed

1. Go to https://vercel.com and sign up free (use "Continue with GitHub" if you have GitHub).
2. Push this folder to a new GitHub repository (see Option B step 1 if you're new to this), then in Vercel click **Add New → Project**, import the repo, and click **Deploy**. Vercel auto-detects Vite — no settings to change.
3. In ~1 minute you'll get a live URL like `mikes-day-book.vercel.app`.

## Option B: deploy from your computer with one command

1. Install Node.js from https://nodejs.org (LTS version).
2. Unzip this project, open a terminal in the folder, and run:

```bash
npm install
npx vercel
```

3. Follow the prompts (log in, accept defaults). Run `npx vercel --prod` to publish to your production URL.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:5173

## Notes

- **Reminders**: the app nudges you every 2 hours while the tab is open. Click the ⏰ toggle once to allow browser notifications so reminders also pop up when you're in another tab.
- **Data**: stored per-browser. If you switch devices or clear browser data, tasks won't follow you. (A cloud-synced version would need a small database — happy to build that as a next step.)
