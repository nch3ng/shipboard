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

const MAX_PAGES = 10;
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

async function fetchIssues(repo, auth) {
  const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'shipboard'};
  if (auth) headers.Authorization = 'Bearer ' + auth;

  const issues = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`;
    const res = await fetch(url, {headers});
    if (res.status === 404) throw new Error(auth
      ? `No repo called ${repo}, or your token cannot see it. A private repo needs the "repo" scope.`
      : `No public repo called ${repo}. If it is private, set GITHUB_TOKEN or run \`gh auth login\`.`);
    if (res.status === 401) throw new Error('GitHub rejected the token. Check GITHUB_TOKEN, or run `gh auth login`.');
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      throw new Error(`Rate-limited${auth ? '' : ' (60/hour without a token — set GITHUB_TOKEN for 5000)'}.` +
        (reset ? ` Resets ${new Date(reset).toLocaleTimeString()}.` : ''));
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${repo}.`);

    const batch = await res.json();
    issues.push(...batch.filter(i => !i.pull_request));  // this endpoint returns PRs too
    if (batch.length < 100) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return {at: Date.now(), repo, truncated, issues: issues.map(i => ({
    n: i.number, title: i.title, state: i.state,
    created: i.created_at, closed: i.closed_at,
    assigned: !!i.assignee,
    labels: i.labels.map(l => typeof l === 'string' ? l : l.name),
  }))};
}

function render(data) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');  // cannot break out of the script tag
  if (!template.includes('<!--BOARD_DATA-->')) throw new Error('index.html is missing its <!--BOARD_DATA--> marker.');
  return template.replace('<!--BOARD_DATA-->', `<script>window.BOARD_DATA = ${json};</script>`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const auth = token();

  if (!o.serve) {
    const data = await fetchIssues(o.repo, auth);
    fs.writeFileSync(o.out, render(data));
    const open = data.issues.filter(i => i.state === 'open').length;
    console.error(`${o.out} — ${open} open, ${data.issues.length - open} closed${data.truncated ? ' (truncated)' : ''}` +
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
