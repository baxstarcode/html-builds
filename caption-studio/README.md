# Caption Studio

Photo in, on-brand social caption out. Point it at a photo and it identifies what is in the
shot, drafts a one-to-two sentence caption in your voice, picks the hashtags, and tells you
which accounts to tag before you post.

**Live:** https://baxstarcode.github.io/html-builds/caption-studio/

One HTML file. No build step, no framework, no account. Works as a home-screen app on a phone.

## What it does

- **Photos in three ways.** Camera roll, the rear camera straight from the page, or drag and
  drop on desktop. Up to 6 per draft.
- **Reads the photo.** A vision model identifies the subjects and drafts the caption in the
  voice you describe in Settings.
- **Accounts to tag.** You list the accounts you tag (sponsors, venues, partners) with a
  one-line cue for each. The ones the model can see in the frame come back pre-armed. The
  rest are a tap.
- **Hashtag cap.** Set the max per post. A signature tag and always-on tags count toward it.
  Extras are trimmed and the trim is reported, never silent.
- **No handles in the caption text.** A typed `@handle` notifies nobody, and if you also tag
  properly in Instagram's Tag People field, everyone gets tagged twice. The caption stays
  clean and the handles and location come back on a before-you-share checklist.
- **Dead signal doesn't lose the work.** A failed read saves the photos on the device and
  offers to finish the draft next time you open with coverage.
- **One-tap out.** Share puts the full-quality originals into the native share sheet with the
  caption already on the clipboard.
- **Portable setup.** Export your settings as JSON and import them on another phone, or hand
  a finished setup to a client.

## Free tier and paid tokens

The page never holds an AI key. It posts to a small proxy (`proxy/Code.gs`, a Google Apps
Script web app) that adds the key, fixes the model and token budget, and enforces the limits.

| Tier | How you get it | Limit |
|---|---|---|
| Free | Built in. The page ships with the owner's proxy URL and free token. | 10 captions per device, for life. Plus a daily ceiling across all free devices. |
| Unlimited | The owner gives you a token; paste it under Settings → Caption endpoint. | None |
| Your own proxy | Deploy `Code.gs` yourself with your own key. | Whatever you set in `CONFIG` |

When the free captions run out, the page shows a wall with the owner's message and a link.
Both come from `Code.gs` (`UPGRADE_MESSAGE`, `UPGRADE_CTA`, `UPGRADE_URL`), so they change
without touching the page.

**How the limit works, honestly.** There are no accounts, so the page generates a random
device id, keeps it in localStorage, and sends it with every request. The proxy counts
captions against that id. Clearing site data, a private window, or a second browser starts a
fresh count. That is the ceiling of what an accountless free tier can do. The thing that
actually protects the bill is `FREE_DAILY_CEILING` in `Code.gs`: once all free devices
together hit it, the free tier pauses until the next UTC day. The fixed model and
`MAX_TOKENS` cap the cost of any single call.

The Settings → Test endpoint button uses a `_ping` request. The proxy answers it with a fixed
tiny prompt and never counts it.

## Deploying the proxy (the owner does this once)

1. Open [script.google.com](https://script.google.com), new project, paste `proxy/Code.gs`.
2. Project Settings → Script Properties: add `ANTHROPIC_API_KEY`, `PROXY_TOKEN` (any long
   random string), and optionally `UNLIMITED_TOKENS` (comma-separated paid tokens).
3. Run `setupCheck()` once from the editor and approve the permissions.
4. Deploy → New deployment → Web app, execute as **Me**, access **Anyone**. Copy the `/exec` URL.
5. Open `index.html` and set `FREE_PROXY_URL` and `FREE_PROXY_TOKEN` at the top of the
   script. Commit. Every visitor now gets the free tier with zero setup.
6. Open the live page → Settings → **Test endpoint**. It should answer "ready" and report
   0 of 10 used.

After any edit to `Code.gs`: Deploy → Manage deployments → pencil → New version → Deploy.
Editing the script alone does not change the live URL.

Maintenance functions in `Code.gs`, run from the editor: `usageReport()` (devices, captions,
today's total), `resetDevice()` (give one device its captions back; the id is shown at the
bottom of the page's Settings panel), `pruneOldDays()` (drop day counters older than 30 days).

## Security model

- The `sk-ant-` key lives only in Script Properties. Never in this repo, never in the HTML.
- The free token is a soft gate, not a secret. It ships in the page by design. The
  per-device limit, the daily ceiling, and the fixed model and `max_tokens` are what protect
  the bill.
- Unlimited tokens are worth protecting. Rotate one by editing `UNLIMITED_TOKENS`.
- Settings, including whichever token is in use, live in the browser's localStorage on that
  device only. A settings export includes the token.
- Model output is rendered as text, never as HTML.

## Files

| Path | What it is |
|---|---|
| `index.html` | The tool. Markup, styles, and app in one file |
| `proxy/Code.gs` | Apps Script proxy. Holds the key, fixes model and token budget, enforces the tiers |

## Lineage

Commercial edition of the Baxstar Fishing caption tool
([baxstarcode/caption-studio](https://github.com/baxstarcode/caption-studio)). Everything that
was hard-coded for one business there (brand block, sponsor list, bass-post rule, hashtag
rules, proxy URL) is a setting here, and the free tier is new.
