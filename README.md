# Mike's Day Book

Personal daily task and scheduling system: daily task tracking, end-of-day reviews (completed vs rescheduled vs dropped), 2-hour pending-task reminders, priority flags, categories, recurring tasks (e.g. Mon–Fri), a sidebar with week-at-a-glance, a copyable end-of-day report, a 7-day completion chart, and streaks.

Built with React + Vite, packaged as an installable PWA (Progressive Web App). Tasks are saved in the device's local storage — private, no account or database needed.

## Deploy to Vercel (free)

1. Push this folder's contents to a GitHub repository.
2. On https://vercel.com: Add New → Project → import the repo → Deploy.
   Vercel auto-detects Vite; no settings needed.

## Install on your phone (instant, no APK needed)

1. Open your live Vercel URL in Chrome on Android.
2. Chrome will show an "Install app" / "Add to Home Screen" prompt (or find it in the ⋮ menu).
3. Tap Install — the Day Book appears in your app drawer with its own icon, opens full-screen, and works offline.

## Generate an APK (optional)

1. Go to https://www.pwabuilder.com
2. Paste your live Vercel URL and click Start.
3. Choose Android → Generate Package → download the APK/AAB bundle.
4. Transfer the APK to your phone and install it (allow "install from unknown sources" when prompted).

## Run locally

```bash
npm install
npm run dev
```

## Notes

- Reminders fire every 2 hours while the app is open; enable notifications via the ⏰ toggle.
- Data is stored per device. A cloud-synced version would need a small database (e.g. Supabase).
