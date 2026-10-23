# EchoSphere email system (Google Sheets + Apps Script)

Subscriber list, signup form, unsubscribe handling and campaign sending, run
from a Google Sheet in the Naru account (hello@naru-m.com). Campaigns send
from whichever account deploys the script.

## Files

| File | What it does |
| --- | --- |
| `Config.gs` | Tab names, column headers, default settings, `setup()` |
| `Subscribers.gs` | Add / unsubscribe / list subscribers; unsubscribe tokens |
| `Email.gs` | Builds each email: `{{first_name}}`, footer, plain-text part, unsubscribe headers |
| `Send.gs` | Campaign sending: daily cap, resume after time limit, never re-sends |
| `WebApp.gs` | Public web app: signup and unsubscribe endpoints |
| `Menu.gs` | "EchoSphere Email" menu in the Sheet |
| `Unsubscribe.html` | Unsubscribe confirmation page |
| `appsscript.json` | Manifest: Gmail API, permissions, web app settings |
| `signup-form.html` | Form to paste into a Code Block on naru-m.com |
| `test/` | Local tests (Node), not uploaded to Google |

## Setup (about 20 minutes, signed in as hello@naru-m.com)

1. **Create the Sheet.** In Google Drive (Naru account): New → Google Sheets. Name it, for example, "EchoSphere Subscribers".
2. **Open Apps Script.** In the Sheet: Extensions → Apps Script.
3. **Show the manifest.** Project Settings (gear) → tick "Show appsscript.json manifest file in editor".
4. **Add the code.** In the editor, for each `.gs` file above, click + → Script, give it the same name (without `.gs`), and paste the contents. Click + → HTML for `Unsubscribe` and paste `Unsubscribe.html`. Replace the contents of `appsscript.json` with this repo's version. Delete the empty `Code.gs`. Save.
5. **Run setup.** Pick `setup` in the function dropdown → Run → approve the permissions (Gmail send, Sheets, external requests, triggers). The Sheet now has Subscribers, Campaigns and Send Log tabs.
6. **Deploy the web app.** Deploy → New deployment → type Web app → Execute as: **Me**; Who has access: **Anyone** → Deploy. Copy the URL ending in `/exec`. If "Anyone" isn't offered, the Workspace admin has limited web apps to the organization; ask them to allow it, or the website form and unsubscribe links won't work for the public.
7. **Settings.** Project Settings → Script properties:
   - `WEB_APP_URL` = the `/exec` URL
   - `SENDER_NAME` = display name in the From line (default "EchoSphere")
   - `POSTAL_ADDRESS` = the real business address (required before any real send)
   - `DAILY_CAP` = 1400 (default; Workspace allows about 1,500 recipients a day)
   - `MOSAIC_WEBHOOK_URL`, `MOSAIC_SECRET` = leave empty until Mosaic is hosted
8. **Reload the Sheet.** The "EchoSphere Email" menu appears.
9. **Test.** Add a row to Campaigns (Name `test`, a Subject, an HTML Body), then EchoSphere Email → Send a test of a campaign… to an outside Gmail address. In Gmail, open it → ⋮ → Show original and check SPF, DKIM and DMARC.
10. **Signup form.** In `signup-form.html`, replace `PASTE_WEB_APP_EXEC_URL_HERE` with the `/exec` URL, then paste it into a Code Block on naru-m.com.

After changing code later: Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy. The `/exec` URL stays the same.

## Running campaigns

- **A campaign** is one row in the Campaigns tab: Name, Subject, HTML Body. `{{first_name}}` works in Subject and Body (falls back to "there").
- **Send:** EchoSphere Email → Start sending a campaign…. It confirms the recipient count, then sends in the background up to `DAILY_CAP` a day, resuming automatically. Every send is logged in Send Log.
- **Stop:** EchoSphere Email → Stop sending. Starting the same campaign again skips everyone already sent.
- **Importing a list:** paste Email / First Name / Source rows into Subscribers, then EchoSphere Email → Add unsubscribe tokens to imported rows. Addresses that unsubscribed elsewhere must be imported with Status `unsubscribed`.

## Unsubscribe and compliance

- Every email carries the physical address and an unsubscribe link in the footer, plus `List-Unsubscribe` headers so Gmail/Yahoo show their own one-click Unsubscribe button.
- Unsubscribes take effect immediately, including mid-campaign.
- The footer link opens a page with an Unsubscribe button rather than unsubscribing on page load, because company link scanners open every link in an email.
- Real campaigns are blocked while `POSTAL_ADDRESS` is a placeholder.

## Security notes

- The web app is public. Only `doGet`, `doPost` and `confirmUnsubscribe` are meant to be reached from outside; every helper ends in `_` (private in Apps Script), and admin actions check the signed-in user.
- Keep settings in Script properties, never in the code.
- Sharing the Sheet with someone as Editor lets them run the menu, including sending.

## Local tests

```
cd test
npm install mailparser
node run.js
```

These run the code against fake Google services in Node. They do not replace a real test send.
