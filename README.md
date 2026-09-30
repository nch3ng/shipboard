# Delivery Board

A delivery dashboard for any GitHub repo — pipeline, ageing backlog, weekly
throughput, and what is dispatchable right now. One static HTML file and one
dependency-free Node script. No build step, no framework, no service to run.

## Three ways to use it

**1 — Generate a file.** Pulls the issues and bakes them into a standalone
HTML file. Works on private repos. The result needs no network to open.

```bash
node board.js owner/name -o board.html
```

**2 — Serve it live.** Same thing, re-fetched on a timer, at
`http://localhost:8080`. This is the live view for a private repo.

```bash
node board.js owner/name --serve
```

**3 — Host `index.html` and pass a repo in the URL.** No CLI, no server. The
page reads the public GitHub API from the browser, so it is the one you can
embed anywhere — and it only works on **public** repos.

```
https://YOU.github.io/delivery-board/?repo=owner/name
```

Open it with no `?repo=` and it gives you a box to type one into.

## Private repos — why there is no OAuth

There is no OAuth app to register and no secret to store. Modes 1 and 2 use
credentials you already have, in this order:

1. `GITHUB_TOKEN` (or `GH_TOKEN`)
2. whatever `gh auth token` returns — so being logged in with `gh auth login`
   is enough

The token stays on your machine. It is never written into the generated HTML.

Browser OAuth would not help even if it were built: GitHub's token endpoints
send no CORS headers, so a static page cannot complete a device flow or a code
exchange on its own. Doing it properly means running a backend to hold the
client secret, which is the one thing this project is trying not to be. Add
that the day you want a hosted service other people log into — not before.

The real limit that falls out of this: **you cannot publicly embed a live
private board.** That would mean shipping a token to every viewer. Generate a
snapshot on a schedule and publish it somewhere access-controlled instead:

```bash
node board.js owner/private-repo -o board.html   # then rsync/S3/commit it
```

The generated file contains issue numbers, titles, and labels. Treat it as
being as sensitive as the repo it came from.

## Embed it

```html
<iframe src="https://YOU.github.io/delivery-board/?repo=owner/name"
        title="delivery board" style="width:100%;height:1600px;border:0" loading="lazy"></iframe>
```

The page posts its height to the parent, so the frame can size itself instead
of guessing:

```js
addEventListener('message', (e) => {
  if (e.data?.deliveryBoard === 'height') frame.style.height = e.data.height + 'px';
});
```

Generated files (mode 1) embed the same way — they are ordinary HTML.

## Host it

Fork, then Settings → Pages → deploy from `main` / root. There is nothing to
build. Opening `index.html` off the filesystem works too.

## Buckets

Every open issue lands in exactly one bucket, first match wins: **In flight**
(has an assignee, or a flight label) → **Blocked** → **Ready** → **Later** →
**Unlabelled** (no labels at all) → **Needs triage** (everything else).

Each bucket reads a comma-separated label list you can override in the URL:

| Param | Default |
|---|---|
| `flight` | `in progress,in-progress,wip,claimed,agent-claimed` |
| `blocked` | `blocked,on hold` |
| `ready` | `ready,agent-ready,good first issue,help wanted` |
| `later` | `later,backlog,icebox,wontfix` |
| `triage` | `triage,needs triage,needs-triage,agent-proposed` |

```
?repo=owner/name&ready=approved,scoped&flight=doing
```

Priority, bug, and security badges are matched from label names, and from the
title for priority — `P0`, `[HIGH]`, `critical`, `bug`, `security` and friends.

## Limits

- **1000 issues**, most recent first. Past that the board says so and the
  closed count shows a `+`. Raise `MAX_PAGES` in both files if you need more.
- **Rate limits.** 60 requests an hour unauthenticated, 5000 with a token, at
  one request per 100 issues. The browser mode caches for 10 minutes so an
  embedded board does not burn through the anonymous budget.
- **Areas are labels.** The "where the open work sits" panel shows your six
  most-used labels, not inferred categories.

## Options

```
node board.js owner/name [-o out.html] [--serve] [--port 8080] [--refresh 600]
```

`--refresh` is the server's re-fetch interval in seconds; `?refresh` on the URL
forces one. Node 18+ (for `fetch`). No npm install.

## Check it

`index.html?selftest=1` runs the bucketing, ageing, and week-binning assertions
in the page. No framework, nothing to install.

## Licence

MIT
