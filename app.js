// app.js — Static frontend for GitHub Device Flow (via Cloudflare Worker proxy)
const PROXY = 'https://timeliner.gsaurabhr.workers.dev'; // your deployed Worker URL
const ORG = 'csndl-iitd';

const oauthBtn = document.getElementById('oauthButton');
const patBtn = document.getElementById('patButton');
const statusText = document.getElementById('statusText');
const statusActions = document.getElementById('statusActions');
const contentArea = document.getElementById('contentArea');
const themeSelect = document.getElementById('theme');
const showClosed = document.getElementById('showClosed');
const showNotPlanned = document.getElementById('showNotPlanned');

let TOKEN = localStorage.getItem('gh_token') || null;
let repoList = [];
let repoIssues = {};

// === Theme persistence ===
const savedTheme = localStorage.getItem('theme') || 'light';
document.body.className = savedTheme;
themeSelect.value = savedTheme;
themeSelect.addEventListener('change', () => {
  const t = themeSelect.value;
  document.body.className = t;
  localStorage.setItem('theme', t);
});

// === Helpers ===
function setStatus(text) {
  statusText.textContent = text;
}
function setAuthenticated(token) {
  TOKEN = token;
  localStorage.setItem('gh_token', token);
  setStatus('Signed in');
  statusActions.innerHTML = '<button id="logout-btn">Logout</button>';
  document.getElementById('logout-btn').addEventListener('click', () => {
    TOKEN = null;
    localStorage.removeItem('gh_token');
    statusActions.innerHTML = '';
    setStatus('Not signed in');
    contentArea.innerHTML = '';
  });
}

// === GitHub GraphQL Wrapper ===
async function graphqlFetch(query, variables = {}) {
  if (!TOKEN) throw new Error('No token');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// === Render placeholder ===
function renderRepoPlaceholder(repo) {
  const d = document.createElement('div');
  d.className = 'repo-placeholder';
  d.dataset.repo = repo.name;
  d.textContent = `${repo.name} — updated ${repo.updatedAt || repo.updated_at || ''} — openIssues: ${repo.openIssues || ''}`;
  contentArea.appendChild(d);
}

// === Fetch Org Repositories ===
async function listOrgRepos(org) {
  const q = `
    query($org:String!,$per:Int!,$after:String){
      organization(login:$org){
        repositories(first:$per, after:$after, orderBy:{field:UPDATED_AT, direction:DESC}){
          nodes { name updatedAt issues(states:OPEN){ totalCount } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const per = 50;
  let all = [];
  let after = null;
  let hasNext = true;
  while (hasNext) {
    const data = await graphqlFetch(q, { org, per, after });
    const conn = data.organization && data.organization.repositories;
    if (!conn) break;
    conn.nodes.forEach(n => all.push({
      name: n.name,
      updatedAt: n.updatedAt,
      openIssues: n.issues ? n.issues.totalCount : 0
    }));
    hasNext = conn.pageInfo.hasNextPage;
    after = conn.pageInfo.endCursor;
  }
  return all;
}

// === Fetch Issues with Sub-Issues ===
async function getRepoIssuesWithSubIssues(owner, repo) {
  const q = `
    query($owner:String!,$repo:String!,$first:Int!,$after:String){
      repository(owner:$owner,name:$repo){
        issues(first:$first,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){
          nodes{
            number title createdAt closedAt state stateReason url
            subIssues(first:100){nodes{number title createdAt closedAt state stateReason url}}
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  `;
  const per = 100;
  let all = [];
  let after = null;
  let hasNext = true;
  while (hasNext) {
    const data = await graphqlFetch(q, { owner, repo, first: per, after });
    if (!data.repository) break;
    const page = data.repository.issues;
    all.push(...page.nodes);
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }
  return all;
}

// === Load Organization Data ===
async function loadOrgData() {
  contentArea.innerHTML = '';
  setStatus('Loading repositories...');
  try {
    repoList = await listOrgRepos(ORG);
  } catch (e) {
    setStatus('Failed to list repositories: ' + (e.message || e));
    return;
  }

  // Sort non-empty first
  repoList.sort((a, b) => {
    const aEmpty = (a.openIssues || 0) === 0;
    const bEmpty = (b.openIssues || 0) === 0;
    if (aEmpty && !bEmpty) return 1;
    if (!aEmpty && bEmpty) return -1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  repoList.forEach(r => renderRepoPlaceholder(r));

  // Fetch issues concurrently
  const concurrency = 4;
  const queue = [...repoList];
  const active = [];

  async function runNext() {
    if (!queue.length) return;
    const repo = queue.shift();
    const p = getRepoIssuesWithSubIssues(ORG, repo.name)
      .then(issues => {
        repoIssues[repo.name] = issues;
        const el = contentArea.querySelector(`[data-repo="${repo.name}"]`);
        if (el) el.textContent = `${repo.name} — ${issues.length} issues`;
      })
      .catch(e => {
        console.error('Error fetching', repo.name, e);
        const el = contentArea.querySelector(`[data-repo="${repo.name}"]`);
        if (el) el.textContent = `${repo.name} — Error`;
      })
      .finally(() => {
        const idx = active.indexOf(p);
        if (idx !== -1) active.splice(idx, 1);
        runNext();
      });
    active.push(p);
  }

  for (let i = 0; i < concurrency; i++) runNext();
  await Promise.all(active);
  setStatus('Loaded repositories');
  const f = document.createElement('div');
  f.className = 'footer';
  f.textContent = 'Done.';
  contentArea.appendChild(f);
}

// === Device Flow ===
async function startDeviceFlow() {
  setStatus('Requesting device code...');
  let r;
  try {
    r = await fetch(`${PROXY}/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'repo read:org' })
    });
  } catch (err) {
    setStatus('Network error: ' + err.message);
    console.error(err);
    return;
  }

  const data = await r.json();
  if (data.error) {
    setStatus('Error: ' + (data.error_description || data.error));
    console.error(data);
    return;
  }

  // Display verification instructions
  contentArea.innerHTML = `
    <div class="intro">
      Enter this code on GitHub: 
      <strong style="font-size:18px;">${data.user_code}</strong><br>
      <a href="${data.verification_uri}" target="_blank">Open GitHub Verification Page</a>
    </div>
  `;

  // Poll for token
  let interval = (data.interval || 5) * 1000;
  const expiresAt = Date.now() + ((data.expires_in || 900) * 1000);

  while (Date.now() < expiresAt) {
    await new Promise(r => setTimeout(r, interval));

    let tokResp;
    try {
      tokResp = await fetch(`${PROXY}/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: data.device_code })
      });
    } catch (err) {
      console.error('Polling error', err);
      continue;
    }

    const j = await tokResp.json();
    if (j.error) {
      if (j.error === 'authorization_pending') continue;
      if (j.error === 'slow_down') { interval += 5000; continue; }
      setStatus('Auth error: ' + (j.error_description || j.error));
      return;
    }
    if (j.access_token) {
      setAuthenticated(j.access_token);
      await loadOrgData();
      return;
    }
  }
  setStatus('Device flow timed out');
}

// === PAT (Manual Token) Flow ===
patBtn.addEventListener('click', async () => {
  const t = prompt('Paste your Personal Access Token (scopes: repo, read:org)');
  if (!t) return;
  setAuthenticated(t.trim());
  await loadOrgData();
});

// === OAuth Button ===
oauthBtn.addEventListener('click', () => {
  startDeviceFlow().catch(e => {
    console.error(e);
    setStatus('Device flow failed: ' + e.message);
  });
});

// === Restore session if token exists ===
if (TOKEN) {
  setAuthenticated(TOKEN);
  loadOrgData();
}
