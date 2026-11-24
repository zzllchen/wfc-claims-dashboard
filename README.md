# WFC Claims & Leave (the accountant's dashboard)

A page with two tabs, **Claims** and **Leave**, on the same site and behind the same password.

- **Claims:** every claim in one clean table: who sent it, the month, the total, and a status the accountant can change (New, Checked, Paid, Has a question). Click a claim to see its lines, open the receipts, download everything as a zip, and read the history. It also shows spend by type and exports to Excel (CSV).
- **Leave:** every leave application, to track who is away and how much leave has been taken (see "The Leave tab" below).

It is a separate site from the Claim Builder. The Claim Builder's **Save my claim** and **Save my leave form** also post to a small **inbox**, and this page reads the inbox. The email with the zip still goes out as before.

```
Claim Builder  --(Save my claim)-->  inbox  <--(reads)--  this dashboard
```

**Password.** The online inbox can have one shared password (see "The password" below). With none set, anyone who has the inbox address or the page link can read the claims. The local demo has none.

## The Leave tab

Press **Leave** (the number beside it is how many applications are still New). A link ending in `#leave` opens straight on it.

- **Four tiles:** New, Recorded and Has a question (click one to filter the table, click again to show all) and **Away today** (who is on leave right now).
- **The table:** staff, type (a small **MC** tag when a medical certificate came with it), dates (with *Away now* or *Starts in 9 days* underneath), working days, when it was sent, and status. Filter by month (the month the leave starts in), staff or a search word; click a heading to sort.
- **Who is away** (the card beside the table, about the whole team, so the filters do not change it): who is away today, who is coming up in the next 30 days, and the **days taken this year** per person with the split by type (annual, sick, personal, unpaid).
- **Click an application** for the side panel: the days and dates, a status you can set (**New**, **Recorded** once the office has filled in the balance, **Has a question**) with a note, the details (type, from, to, days, reason, date signed, MC attached or not), **Open leave form** and **Download everything (.zip)**, the files (leave form PDF and Excel, medical certificate), who it was sent to, and the history.
- **Export > Leave list** gives one row per application for Excel.
- **Days** are working days: Monday to Friday, without the public holidays in the Claim Builder's list (the Claim Builder works it out and sends it).
- One application per person per start date: saving the same leave form again replaces it (and sets it back to New, history kept). Changing the start date and saving makes a second application.
- **Show sample claims** on the Claims tab fills both tabs with made-up examples, dated around today.

## The demo (one PC, needs Node.js and Python, nothing else)

1. Double-click **`Start Demo.bat`**. Two black windows open (leave them), then two browser tabs: the **dashboard** (http://localhost:8787/) and the **Claim Builder** (http://localhost:8080/, already pointed at the dashboard).
2. In the Claim Builder make a claim as usual and press **Save my claim**. The line *Also on the accountant's dashboard* appears and the claim shows up in the dashboard tab within 20 seconds (press Refresh to see it at once). Saving the same claim again replaces it, and its status goes back to New.
3. In the dashboard click the claim to open the receipts, set it to Checked or Paid, add a note.
4. Close the two black windows to stop. Claims received are kept in the `data` folder here (delete a sub-folder to remove a claim).

`Start Demo.bat` opens the Claim Builder with `?dash=http://localhost:8787/api`, which the Claim Builder remembers on that PC. Only a localhost address is accepted from a link. The same can be set by hand in the Claim Builder's **Settings > Accountant's dashboard address**.

`Start.bat` starts only the dashboard and inbox. **Show sample claims** on the dashboard fills it with made-up claims (tagged *Sample*, never saved) for a busy-looking screen.

Claims received this way are kept as plain files in the `data` folder next to `Start.bat`.

## Put it online (Google) - so the boss and Agnes can open it from anywhere

The inbox runs for free as a Google Apps Script web app in a Google account (use the company one, for example marketing.wfcsystems@gmail.com). Claims go into a Google Sheet called *WFC Claims* and the files into a Drive folder called *WFC Claims files*, both created automatically in that account.

1. Open https://script.google.com signed in to that account, **New project**, name it *WFC Claims inbox*.
2. Delete the sample code and paste in everything from `backend/Code.gs`. Save.
3. **Deploy > New deployment**, type **Web app**. *Execute as:* **Me**. *Who has access:* **Anyone**. Press **Deploy**.
4. Google asks you to allow it: **Advanced > Go to WFC Claims inbox (unsafe) > Allow**. (It is your own script; Google shows this for every script it has not reviewed.)
5. Copy the **Web app URL** (it ends in `/exec`). Check it by opening `<that address>?action=ping`: it should answer `{"ok":true,"service":"wfc-claims",...}`.
6. Put the address in two places and publish both:
   - `js/config.js` in this folder (`api: '...'`), then host this folder as a static site (GitHub Pages, Netlify, any web server).
   - `DEFAULTS.dashApi` in the Claim Builder's `js/app.js`, so every colleague sends to it without touching Settings.

If you ever change `Code.gs`: **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**. The address stays the same. **Leave tracking (version 2 of the script) needs this once:** paste the new `Code.gs` over the old one and deploy a New version. Until then the dashboard's Leave tab says "This inbox can't track leave yet" and the Claim Builder says its leave form was saved and emailed but not sent to the dashboard (claims are not affected either way).

Limits: about 8 MB per file (the Claim Builder leaves out a bigger file and says so; it is still in the emailed zip) and 60 lines per claim. A claim with a few receipts takes a few seconds to arrive because each file is sent separately.

## The password

One shared password protects reading claims, opening files, changing a status and deleting. The Claim Builder's own calls (a colleague pressing **Save my claim**) never need it, so colleagues are not affected.

- **Where it lives:** in the Google script's private settings, never in this code or on GitHub. Open the script, **Project settings** (the cog), **Script properties**, **Add script property**: name `DASH_KEY`, value the password. Remove the property to open the inbox again. Changing it signs everyone out: the dashboard asks again.
- **Dashboard:** asks for it once per browser and remembers it there (**Sign out** in the top bar forgets it). It is sent only to the inbox, in the body of a request, never in an address.
- **Local demo:** `node server/server.js --password <word>` (or the environment variable `WFC_DASH_PASSWORD`) does the same locally; `Start Demo.bat` sets none.
- **Honest limits:** it is a shared password, not one per person, and there is no lock-out after wrong guesses (each wrong guess just waits 1.5 seconds). Choose a long one (three or four words). Anyone can still send junk claims to the inbox, because colleagues need it open, but cannot read anything.

## Before real use
- Everyone who knows the password sees every claim, so share it only with the accountant and the boss.
- The inbox trusts what the Claim Builder sends but adds up the totals itself, caps text lengths and refuses odd file names. It has no rate limit.

## How it works

| Call | What it does |
|---|---|
| `GET ?action=list` | all finished claims (lines, status, notes, history, the list of files) as `claims`, and all leave applications as `leave` (a dashboard that only knows claims ignores `leave`) |
| `GET ?action=file&id=&file=` | one file, base64 |
| `POST list` / `POST file` | the same two reads, with the password (`key`) in the body; needed once a password is set |
| `POST submit` | the claim's details (`claim`), or a leave application's (`leave`: `claimant`, `type`, `start`, `end`, `days`, `reason`, `signedOn`, `from`, `to`, `subject`); returns a one-time upload token |
| `POST upload` | one file (base64) for that token |
| `POST finish` | makes the claim appear on the dashboard (so nobody sees a half-sent claim) |
| `POST status` | status and/or note, with a history line (a claim: new, checked, paid, question; a leave application: new, recorded, question) |
| `POST remind` | the monthly reminder list, no password (see "Monthly reminders"): `op: 'key'` gives the public key the phones subscribe with, `op: 'join'` (`endpoint`, `name`, optional `email`) puts a phone on the list, `op: 'leave'` (`endpoint`) takes it off, `op: 'status'` (`endpoint`) says whether it is on |

One claim per person per month (`2026-10_chin-zhi-liang`) and one leave application per person per start date (`leave-2026-11-05_chin-zhi-liang`); saving again replaces it and keeps the history. On Google, claims are on the sheet *Claims* and leave on a sheet *Leave* of the same spreadsheet (made when the first leave arrives); locally each application is a folder under `data`. `ping` says `leave: true` when the inbox understands leave, so the Claim Builder and the dashboard can tell an older inbox. While a new version is uploading, the dashboard keeps showing the old one. The same calls are answered by `server/server.js` (local) and `backend/Code.gs` (Google); `tests/protocol.js` runs one scenario against both.


## Monthly reminders (push notifications)

Staff can switch a reminder on inside the Claim Builder. The inbox then sends a short notification to their phone or laptop on the **1st, 8th, 13th and 15th of every month, at about 09:00 Malaysia time**, to claim last month's expenses. **Nobody is reminded after they have submitted that claim**: the inbox looks for a claim for last month under the same name, so the name given when switching reminders on must be the name used on the claim. The notification carries no text from the inbox; the Claim Builder writes its words from the date. It only works on the online (Google) inbox, not the local demo.

**One-time steps for the owner** (the Google account the script runs in):

1. Open the script and paste in the new `backend/Code.gs` over the old one. Save.
2. **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy.**
3. In the editor's function list (the drop-down above the code) pick **`setupReminders`** and press **Run**. Google asks to authorise: **Review permissions > choose the account > Advanced > Go to WFC Claims inbox (unsafe) > Allow**. This lets the script start by itself each morning, when nobody is there to press anything. Run it once only; running it again just replaces the trigger with a fresh one, never doubles it.
4. Optional test: pick **`remindNow`** and press **Run**. It sends a reminder to everyone who has switched reminders on, on any day, claimed or not (the log underneath says how many).
5. Staff then switch reminders on inside the Claim Builder.

Good to know:

- Google starts a daily job at some point in the hour from 09:00, so a reminder may arrive up to an hour after nine.
- **The list** is the sheet *Reminders* in the *WFC Claims* spreadsheet (name, when it was added, when a reminder was last sent and what the push service answered). A phone or browser that has switched notifications off for good is taken off the list on its own. Up to 300 phones; each run stops sending after about four minutes.
- **The sender's key.** The script makes its own key pair the first time it needs one and keeps it in the script properties `VAPID_PRIVATE` and `VAPID_PUBLIC` (never in the code). Do not delete them and do not share the private one: every phone is tied to that key, and a new one means everyone has to switch reminders on again.
- The push services are given `mailto:marketing.wfcsystems@gmail.com` as the contact for this sender. Set the script property `VAPID_SUBJECT` (for example `mailto:accounts@yourcompany.com`) to use another.
- **To stop all reminders:** in the editor open **Triggers** (the clock icon) and delete the `remindDaily` trigger. Run `setupReminders` to start again.

## Claude through the company (optional)

The Claim Builder can read receipt photos with Claude without anyone pasting a key. The Anthropic key lives only in this Google script (script property CLAUDE_KEY), never in a web page or on GitHub. The Claim Builder asks the inbox (ction: claude), and the inbox adds the key, fixes the model (Sonnet 5.5, or script property CLAUDE_MODEL), caps the answer at 1000 tokens, accepts only one JPEG photo and a short note, and stops at a daily limit for the whole team (300 calls, or script property CLAUDE_DAILY_CAP). Errors are in our words and never carry the key.

- **Turn it on:** Project settings, Script properties, add CLAUDE_KEY = the Anthropic key. Then Deploy, Manage deployments, edit, New version. Also set a monthly spend limit on the key in the Anthropic Console.
- **Turn it off:** delete the CLAUDE_KEY property. The Claim Builder then reads photos on the computer, as before.
- **Not password-gated:** colleagues have no dashboard password, so the relay is open like submitting a claim; the daily limit and the spend limit are what protect the credit.
- A person who pastes their own key in the Claim Builder still uses that instead.
- Cost: about RM 0.03 per photo.

## Files

```
index.html, css/, js/       the dashboard page (js/config.js holds the inbox address)
js/inbox.js                 talks to the inbox
js/sample.js                made-up claims for the demo view
server/server.js            the local inbox (also serves the page); no packages needed
backend/Code.gs             the Google inbox (Apps Script)
tests/                      node tests/server.test.js, appsscript.test.js, remind.test.js, sender.test.js (fakegoogle.js is the stand-in for Google they share)
Start Demo.bat              one click: inbox + dashboard + local Claim Builder, opens both pages
Start.bat                   starts only the local inbox + dashboard
data/                       claims received locally (never commit this folder)
```

## Tests

```
node tests/server.test.js       the local inbox over real HTTP (+ browser rules, only the page is served)
node tests/appsscript.test.js   Code.gs against a stand-in for Google (logic only: see below)
node tests/remind.test.js       the monthly reminders: the signing maths against Node's own crypto, who is pinged on which day, the trigger
node tests/sender.test.js       the Claim Builder's sender against the local inbox
```

`appsscript.test.js` proves the logic and that Google's version answers exactly like the local one. It cannot prove that Google accepts the script and its permissions: that is only known at the first real deploy. In the same way `remind.test.js` proves the reminder signature is valid (Node's crypto checks it) but cannot prove that Google's, Apple's or Mozilla's push services accept the pings: that is only known at the first real `remindNow`.
