#!/usr/bin/env node
/* Shipboard CLI — pull a repo's issues and bake them into a standalone HTML file.
   Needs node 18+ for global fetch. No dependencies.

     node shipboard.js owner/name                 write shipboard.html
     node shipboard.js owner/name -o out.html     write somewhere else
     node shipboard.js owner/name --serve         live at http://localhost:8080

   Private repos: set GITHUB_TOKEN, or just be logged in with `gh auth login`.
   The token stays on your machine — it is never written into the output. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const MAX_PAGES = 10;        // up to 1000 open issues
const CLOSED_PAGES = 3;      // fallback when search is unavailable
const WEEKS = 19;            // chart window; must match index.html
const mondayOf = (d) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t;
};
const TEMPLATE = path.join(__dirname, 'index.html');

function usage(msg) {
  console.error(`${msg ? msg + '\n\n' : ''}Usage: node shipboard.js owner/name [-o out.html] [--serve] [--port 8080] [--refresh 600]`);
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const o = {out: 'shipboard.html', port: 8080, refresh: 600, serve: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--serve') o.serve = true;
    else if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--refresh') o.refresh = Number(argv[++i]);
    else if (a.startsWith('-')) usage(`Unknown option ${a}`);
    else o.repo = a.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  }
  if (!o.repo) usage('Which repo? Pass it as owner/name.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) usage(`"${o.repo}" is not a repo. Use owner/name.`);
  if (!Number.isFinite(o.port) || !Number.isFinite(o.refresh)) usage('--port and --refresh take numbers.');
  return o;
}

/* GITHUB_TOKEN if you set one, otherwise borrow the gh CLI's. Public repos need neither. */
function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const t = execFileSync('gh', ['auth', 'token'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    if (t) return t;
  } catch (e) { /* gh not installed or not logged in */ }
  return null;
}

/* The list endpoint mixes in pull requests, so on a PR-heavy repo the page cap
   fills with PRs and the sample under-counts issues. Search gives exact totals. */
async function counts(repo, headers) {
  const one = async (extra) => {
    const q = encodeURIComponent(`repo:${repo} is:issue ${extra}`);
    const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {headers});
    if (!r.ok) throw new Error('search unavailable');
    return (await r.json()).total_count;
  };
  try {
    const [open, closed] = await Promise.all([one('is:open'), one('is:closed')]);
    return {open, closed};
  } catch (e) { return null; }   // fall back to counting the sample
}

async function fetchIssues(repo, auth) {
  const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'shipboard'};
  if (auth) headers.Authorization = 'Bearer ' + auth;

  const check = (res) => {
    if (res.ok) return;
    if (res.status === 404) throw new Error(auth
      ? `No repo called ${repo}, or your token cannot see it. A private repo needs the "repo" scope.`
      : `No public repo called ${repo}. If it is private, set GITHUB_TOKEN or run \`gh auth login\`.`);
    if (res.status === 401) throw new Error('GitHub rejected the token. Check GITHUB_TOKEN, or run `gh auth login`.');
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      throw new Error(`Rate-limited${auth ? '' : ' (60/hour without a token — set GITHUB_TOKEN for 5000)'}.` +
        (reset ? ` Resets ${new Date(reset).toLocaleTimeString()}.` : ''));
    }
    throw new Error(`GitHub returned ${res.status} for ${repo}.`);
  };

  const shape = (i) => ({
    n: i.number, title: i.title, state: i.state,
    created: i.created_at, closed: i.closed_at, updated: i.updated_at,
    assigned: !!i.assignee,
    labels: i.labels.map(l => typeof l === 'string' ? l : l.name),
  });

  /* Two passes. state=all spends the whole page budget on pull requests, which
     this endpoint mixes in and which we then throw away. */
  const grab = async (state, sort, pages) => {
    const out = [];
    let full = false;
    for (let p = 1; p <= pages; p++) {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=${state}&per_page=100&page=${p}&sort=${sort}&direction=desc`, {headers});
      check(res);
      const batch = await res.json();
      out.push(...batch.filter(i => !i.pull_request).map(shape));
      if (batch.length < 100) break;
      if (p === pages) full = true;
    }
    return {out, full};
  };

  /* Closed issues inside the chart window, exactly. Search returns issues only,
     so this costs ~2 requests where paging the list endpoint costs a dozen. */
  const closedSince = async () => {
    const m = mondayOf(new Date());
    m.setUTCDate(m.getUTCDate() - (WEEKS - 1) * 7);
    const q = encodeURIComponent(`repo:${repo} is:issue is:closed closed:>=${m.toISOString().slice(0, 10)}`);
    const out = [];
    let capped = false;
    for (let p = 1; p <= 10; p++) {
      const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=100&page=${p}&sort=updated&order=desc`, {headers});
      if (!r.ok) throw new Error('search unavailable');
      const j = await r.json();
      out.push(...j.items.map(shape));
      if (j.items.length < 100 || out.length >= j.total_count) break;
      if (p === 10) capped = true;   // search tops out at 1000 results
    }
    return {out, capped};
  };

  const totalsPending = counts(repo, headers);
  const open = await grab('open', 'created', MAX_PAGES);

  /* Sorted by updated descending, anything closed after the oldest updated_at in
     the sample is certainly in it. Older weeks are not, so we do not chart them. */
  const oldest = (rows) => Math.min(...rows.map(i => Date.parse(i.updated)));
  let closed, closedFrom = null;
  try {
    const found = await closedSince();
    closed = found.out;
    if (found.capped) closedFrom = oldest(closed);
  } catch (e) {
    const fallback = await grab('closed', 'updated', CLOSED_PAGES);   // search is rate-limited separately
    closed = fallback.out;
    if (fallback.full) closedFrom = oldest(closed);
  }

  return {at: Date.now(), repo, truncated: open.full, closedFrom,
    totals: await totalsPending, issues: open.out.concat(closed)};
}

function render(data) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');  // cannot break out of the script tag
  if (!template.includes('<!--BOARD_DATA-->')) throw new Error('index.html is missing its <!--BOARD_DATA--> marker.');
  // Function replacement, not a string: a string one expands $&, $` and $' in
  // the JSON, and issue titles really do contain those.
  return template.replace('<!--BOARD_DATA-->', () => `<script>window.BOARD_DATA = ${json};</script>`);
}

function selftest() {
  const title = 'a $` b $& c $\' d ${e} </script> "q" \\ end';
  const data = {at: 0, repo: 'o/n', truncated: false, closedFrom: null, totals: null,
    issues: [{n: 1, title, state: 'open', created: '2026-01-01T00:00:00Z', closed: null,
      updated: '2026-01-01T00:00:00Z', assigned: false, labels: ['x']}]};
  const html = render(data);
  const lead = 'window.BOARD_DATA = ';
  const from = html.indexOf(lead) + lead.length;
  const payload = html.slice(from, html.indexOf(';</script>', from));
  const back = JSON.parse(payload);

  const checks = [
    ['title survives the template', back.issues[0].title === title],
    ['no raw < can close the script tag', !payload.includes('<')],
    ['marker is consumed', !html.includes('<!--BOARD_DATA-->')],
  ];
  checks.forEach(([n, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`));
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const o = parseArgs(process.argv.slice(2));
  const auth = token();

  if (!o.serve) {
    const data = await fetchIssues(o.repo, auth);
    fs.writeFileSync(o.out, render(data));
    const open = data.totals ? data.totals.open : data.issues.filter(i => i.state === 'open').length;
    const closed = data.totals ? data.totals.closed : data.issues.length - open;
    console.error(`${o.out} — ${open} open, ${closed} closed${data.truncated ? ' (sampled)' : ''}` +
      (auth ? '\nHeads up: issue titles are baked into that file. Do not publish it for a private repo.' : ''));
    return;
  }

  let cache = null;
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') return res.writeHead(404).end('Not found');
    try {
      if (!cache || Date.now() - cache.at > o.refresh * 1000 || url.searchParams.has('refresh')) {
        cache = await fetchIssues(o.repo, auth);
        console.error(`fetched ${cache.issues.length} issues`);
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(render(cache));
    } catch (e) {
      res.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8'}).end(e.message);
    }
  }).listen(o.port, '127.0.0.1', () => {
    console.error(`${o.repo} → http://localhost:${o.port}  (refetches every ${o.refresh}s; add ?refresh to force)`);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
