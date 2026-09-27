# html-builds

Single-file HTML tools. Each folder is one shareable build: open the `index.html`, or use the
GitHub Pages link. No build step, no framework, no accounts.

**Gallery:** https://baxstarcode.github.io/html-builds/

| Tool | What it does | Link |
|---|---|---|
| [Caption Studio](caption-studio/) | Photo in, on-brand social caption out. Configurable business, voice, accounts to tag, hashtag rules. Free tier of 10 captions per device, paid tokens unlimited. | [open](https://baxstarcode.github.io/html-builds/caption-studio/) |

## Adding a build

1. Make a folder named after the tool, with `index.html` inside. Keep it to one file where
   possible. If it needs a backend script or a README, they go in the same folder.
2. Add a row to the table above and a card to the root `index.html`.
3. Commit and push. Pages serves `main` from the root, so the tool is live at
   `https://baxstarcode.github.io/html-builds/<folder>/` within a minute or two.

## House rules

- No secrets in any file. A tool that needs an API key talks to a proxy the user sets up
  themselves, and the key lives on the proxy.
- Anything hard-coded for one business belongs in a settings panel with export/import.
- Phone first. Every tool has to work at 375px wide with a 16px gutter.
