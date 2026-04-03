# WealthWatch

A personal finance dashboard — track your bank, investment, and crypto balances with history charts and net worth evolution.

## Features
- Dashboard with net worth hero, category totals, allocation donut chart
- Net worth evolution line chart (3M / 6M / 1Y / All)
- Stacked bar chart of category history
- Add / edit / delete accounts
- Manual balance updates with one-click snapshot
- Snapshot history table with CSV export
- Fully responsive — works great on mobile
- All data stored locally in your browser (no server needed)

## Deploy to GitHub Pages (5 minutes)

### Step 1 — Create a GitHub repository
1. Go to https://github.com/new
2. Name it `wealthwatch` (or anything you like)
3. Set it to **Public** (required for free GitHub Pages)
4. Click **Create repository**

### Step 2 — Upload files
Upload these 3 files to the repository root:
- `index.html`
- `style.css`
- `app.js`

You can drag & drop them directly on the GitHub web UI after creating the repo.

### Step 3 — Enable GitHub Pages
1. In your repo, go to **Settings → Pages**
2. Under "Source", select **Deploy from a branch**
3. Choose branch: `main`, folder: `/ (root)`
4. Click **Save**

Your app will be live at:
`https://YOUR_USERNAME.github.io/wealthwatch/`

(It takes ~1 minute to deploy the first time.)

### Step 4 — Bookmark on your phone
- Open the URL in Safari (iOS) or Chrome (Android)
- **iOS**: Share → "Add to Home Screen"
- **Android**: Menu → "Add to Home Screen"

It will appear as an app icon on your phone!

---

## Data & Privacy
All your data lives in your browser's `localStorage`. Nothing is sent to any server.
If you clear your browser data, you'll lose your history — consider exporting CSV periodically.

## Updating balances
1. Open the app
2. Go to **Update** tab
3. Edit the numbers
4. Tap **Save & take snapshot** to record today's values in history
