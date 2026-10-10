# Baseline (full stack)

1. Install Node.js 22 or newer.
2. In this folder run:  npm install
3. Copy `.env.example` to `.env` and paste your AI key (see below).
4. Start:  npm start
5. Open http://localhost:3000

## Pages
- `/` signup, `/login.html` log in  ->  `/profile.html` health profile  ->  `/app.html` dashboard
- The dashboard measures pulse with the phone camera (needs HTTPS or localhost), saves every reading, and lets you delete one reading or all of them.
- Logging in: 8 wrong passwords in 10 minutes pauses logins for that email. Sessions last 7 days.

## Database (baseline.db, created automatically)
users, sessions, profiles, readings, alerts. Passwords are stored as salted scrypt hashes.

## AI chatbot
Put ONE key in `.env` (never in the browser):
    LLM_PROVIDER=anthropic   (or gemini / openai)
    ANTHROPIC_API_KEY=...
Restart the server after changing `.env`. Without a key the chat says it is not switched on yet,
and the emergency warning for words like "chest pain" still appears.

## Alerts and the emergency contact
- When the rules reach **Get medical help**, the dashboard shows a dialog and a banner with a countdown (default 2 minutes), and a device notification if the person turned those on.
- **I'm OK** stops the countdown. If nobody responds, the **server** texts the emergency contact. This keeps working if the tab is closed after the alert starts.
- The contact is only messaged if the profile has a contact AND the consent box is ticked. There is a 30-minute cooldown between alerts and at most 3 real texts to the contact per day.
- **Watch** alerts are recorded and shown on the device, but never text anyone.
- Demo scenarios never send a real text.
- Real SMS needs Twilio details in `.env` (see `.env.example`). Without them the app says clearly that nothing was sent.
- Limits: the alert level is calculated in the browser, so the page must be open when the alert starts. Device notifications only work while the site is open in a browser. Trial Twilio accounts text verified numbers only.

## Heart score
Calculated in lib/score.js from the last 14 days of saved resting readings:
resting level 35, steadiness 20, share of high readings 25, direction 20 points.
A serious alert in the period caps it at 59, a "watch" alert at 79. It is a summary, not a medical measure.

## Files
server.js (API + database + alert timer), lib/notify.js (SMS), lib/score.js, lib/chat.js, public/*.html
