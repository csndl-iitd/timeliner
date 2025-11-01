// app.js — static frontend that uses a Cloudflare Worker proxy for GitHub Device Flow
const PROXY = window.__PROXY_URL__ || 'https://timeliner.gsaurabhr.workers.dev'; // your deployed Worker
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

// --- Theme persistence ---
const savedTheme = localStorage.getItem('theme') || 'light';
document.body.className = savedTheme;
themeSelect.value = savedTheme;
themeSelect.addEventListener('change', () => {
  const t = themeSelect.value;
  document.body.className = t;
  localStorage.setItem('theme', t);
});

// --- UI helpers ---
function setStatus(text) {
  statusText.textContent = text;
}

function setAuthenticated(token) {
  TOKEN = token;
  localStorage.setItem('gh_token', token);
  setStatus('Signed in');
  statusActions.innerHTML = '<button id="logout-btn">Logout</button>';
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn.addEventListener('click', () => {
    TOKEN = null;
    localStorage.removeItem('gh_token');
    setStatus('Not signed in');
    statusActions.innerHTML = '';
    contentArea.innerHTML = '';
  });
}

// --- GraphQL wrapper ---
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

// --- Render placeholder (simplified) ---
function renderRepoPlaceholder(repo) {
  const d = document.createElement('div');
  d.className = 'repo-placeholder';
  d.dataset.repo = repo.name;
  d.textContent = `${repo.name} — updated ${repo.updatedAt || ''} — openIssues: ${repo.openIssues || 0}`;
  contentArea.appendChild(d);
}

// --- Fetch org repos ---
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
    const conn = data.organization?.repositories;
    if (!conn) break;
    conn.nodes.forEach(n => 
      all.push({
        name: n.name,
        updatedAt: n.updatedAt,
        openIssues: n.issues?.totalCount || 0
      })
    );
    hasNext = conn.pageInfo.hasNextPage;
    after = conn.pageInfo.endCursor;
  }
  return all;
}

// --- Fetch issues + subissues ---
async function getRepoIssuesWithSubIssues(owner, repo) {
  const q = `
    query($owner:String!,$repo:String!,$first:Int!,$after:String){
      repository(owner:$owner,name:$repo){
        issues(first:$first,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){
          nodes{
            number title createdAt closedAt state stateReason url
            subIssues(first:100){
              nodes{ number title createdAt closedAt state stateReason url }
            }
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

// --- Load all org data ---
async function loadOrgData() {
  contentArea.innerHTML = '';
  setStatus('Loading repositories...');
  try {
    repoList = await listOrgRepos(ORG);
  } catch (e) {
    setStatus('Failed to list repositories: ' + (e.message || e));
    return;
  }

  // sort: non-empty first, then updatedAt desc
  repoList.sort((a, b) => {
    const aEmpty = (a.openIssues || 0) === 0;
    const bEmpty = (b.openIssues || 0) === 0;
    if (aEmpty && !bEmpty) return 1;
    if (!aEmpty && bEmpty) return -1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  repoList.forEach(r => renderRepoPlaceholder(r));

  // fetch issues concurrently and update
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

// --- Device flow ---
async function startDeviceFlow() {
  try {
    setStatus('Requesting device code...');
    const res = await fetch(`${PROXY}/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'repo read:org' })
    });

    const data = await res.json();
    if (data.error) {
      setStatus('Error: ' + (data.error_description || data.error));
      return;
    }

    // show user code
    setStatus('');
    contentArea.innerHTML = `
      <div class="intro">
        Enter this code on GitHub: 
        <strong style="font-size:18px;">${data.user_code}</strong> — 
        <a href="${data.verification_uri}" target="_blank">Open verification page</a>
      </div>
    `;

    const interval = (data.interval || 5) * 1000;
    const expiresAt = Date.now() + ((data.expires_in || 900) * 1000);

    while (Date.now() < expiresAt) {
      await new Promise(r => setTimeout(r, interval));
      const tokenRes = await fetch(`${PROXY}/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: data.device_code })
      });
      const tokenJson = await tokenRes.json();

      if (tokenJson.error) {
        if (tokenJson.error === 'authorization_pending') continue;
        if (tokenJson.error === 'slow_down') {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        setStatus('Auth error: ' + (tokenJson.error_description || tokenJson.error));
        return;
      }

      if (tokenJson.access_token) {
        setAuthenticated(tokenJson.access_token);
        await loadOrgData();
        return;
      }
    }

    setStatus('Device flow timed out.');
  } catch (err) {
    console.error(err);
    setStatus('Device flow failed: ' + err.message);
  }
}

// --- PAT flow ---
patBtn.addEventListener('click', async () => {
  const t = prompt('Paste your Personal Access Token (scopes: repo, read:org)');
  if (!t) return;
  setAuthenticated(t.trim());
  await loadOrgData();
});

oauthBtn.addEventListener('click', () => {
  startDeviceFlow();
});

// --- Auto-load if token already exists ---
if (TOKEN) {
  setAuthenticated(TOKEN);
  loadOrgData();
} else {
  setStatus('Not signed in');
}
