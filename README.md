# WFC Claims (the accountant's dashboard)

A page where the accountant sees every claim in one clean table: who sent it, the month, the total, and a status she can change (New, Checked, Paid, Has a question). Click a claim to see its lines, open the receipts, download everything as a zip, and read the history. It also shows spend by type and exports to Excel (CSV).

It is a separate site from the Claim Builder. The Claim Builder's **Save my claim** also posts each claim to a small **inbox**, and this page reads the inbox. The email with the zip still goes out as before.

```
Claim Builder  --(Save my claim)-->  inbox  <--(reads)--  this dashboard
```

**Password.** The online inbox can have one shared password (see "The password" below). With none set, anyone who has the inbox address or the page link can read the claims. The local demo has none.

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

If you ever change `Code.gs`: **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**. The address stays the same.

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
| `GET ?action=list` | all finished claims (lines, status, notes, history, the list of files) |
| `GET ?action=file&id=&file=` | one file, base64 |
| `POST list` / `POST file` | the same two reads, with the password (`key`) in the body; needed once a password is set |
| `POST submit` | the claim's details; returns a one-time upload token |
| `POST upload` | one file (base64) for that token |
| `POST finish` | makes the claim appear on the dashboard (so nobody sees a half-sent claim) |
| `POST status` | status and/or note, with a history line |

One claim per person per month (`2026-10_chin-zhi-liang`); saving again replaces it and keeps the history. While a new version is uploading, the dashboard keeps showing the old one. The same calls are answered by `server/server.js` (local) and `backend/Code.gs` (Google); `tests/protocol.js` runs one scenario against both.

## Files

```
index.html, css/, js/       the dashboard page (js/config.js holds the inbox address)
js/inbox.js                 talks to the inbox
js/sample.js                made-up claims for the demo view
server/server.js            the local inbox (also serves the page); no packages needed
backend/Code.gs             the Google inbox (Apps Script)
tests/                      node tests/server.test.js, appsscript.test.js, sender.test.js
Start Demo.bat              one click: inbox + dashboard + local Claim Builder, opens both pages
Start.bat                   starts only the local inbox + dashboard
data/                       claims received locally (never commit this folder)
```

## Tests

```
node tests/server.test.js       the local inbox over real HTTP (+ browser rules, only the page is served)
node tests/appsscript.test.js   Code.gs against a stand-in for Google (logic only: see below)
node tests/sender.test.js       the Claim Builder's sender against the local inbox
```

`appsscript.test.js` proves the logic and that Google's version answers exactly like the local one. It cannot prove that Google accepts the script and its permissions: that is only known at the first real deploy.
