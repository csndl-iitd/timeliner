// app.js — static web version of Timeliner with full renderer.js behavior
// Requires: index.html with elements (oauthButton, patButton, statusText, statusActions, content, theme, showClosed, showNotPlanned, auth-section)
// and a Cloudflare Worker proxy available at PROXY that proxies /device/code and /device/token

const PROXY = window.__PROXY_URL__ || 'https://timeliner.gsaurabhr.workers.dev';
const ORG = 'csndl-iitd';

let TOKEN = localStorage.getItem('gh_token') || null;
let repoList = [];
let repoIssues = {};
let expandedState = {}; // issueNumber -> boolean
let isLoading = false;
let selectedRepoName = null;
let selectedRepoScrollOffset = null;

// DOM refs
const oauthButton = document.getElementById('oauthButton');
const patButton = document.getElementById('patButton');
const statusText = document.getElementById('statusText');
const statusActions = document.getElementById('statusActions');
const content = document.getElementById('content');
const showClosed = document.getElementById('showClosed');
const showNotPlanned = document.getElementById('showNotPlanned');
const themeSelect = document.getElementById('theme');
const authSection = document.getElementById('auth-section');

// Helpers: auth UI
function hideAuthButtons() { if (authSection) authSection.style.display = 'none'; }
function showAuthButtons() { if (authSection) authSection.style.display = 'block'; }

function showLogoutButton() {
  if (!statusActions) return;
  if (document.getElementById('logout-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'logout-btn';
  btn.textContent = 'Logout';
  btn.style.marginLeft = '8px';
  btn.style.padding = '4px 10px';
  btn.style.border = '1px solid #888';
  btn.style.borderRadius = '6px';
  btn.style.cursor = 'pointer';
  btn.onclick = () => {
    TOKEN = null;
    localStorage.removeItem('gh_token');
    statusText.textContent = 'Logged out';
    clearContent();
    showAuthButtons();
    const existing = document.getElementById('logout-btn');
    if (existing) existing.remove();
  };
  statusActions.appendChild(btn);
}

// Theme persistence and apply
const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const savedTheme = localStorage.getItem('theme') || (systemPrefersDark ? 'dark' : 'light');
document.body.className = savedTheme;
if (themeSelect) themeSelect.value = savedTheme;
if (themeSelect) themeSelect.addEventListener('change', ()=> {
  const newTheme = themeSelect.value;
  document.body.className = newTheme;
  localStorage.setItem('theme', newTheme);
  // rerender without losing selected repo position
  rerenderAll();
});

// header padding dynamic set
window.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('header');
  if (header && content) {
    const headerHeight = header.offsetHeight;
    content.style.paddingTop = `${headerHeight + 20}px`;
  }
});

// GraphQL wrapper
async function graphqlFetch(query, variables={}) {
  if (!TOKEN) throw new Error('No token');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Repo listing
async function listOrgRepos(org) {
  const q = `
  query($org:String!,$per:Int!,$after:String){
    organization(login:$org){
      repositories(first:$per, after:$after, orderBy:{field:UPDATED_AT, direction:DESC}){
        nodes{ name updatedAt issues(states:OPEN){ totalCount } }
        pageInfo{hasNextPage endCursor}
      }
    }
  }`;
  const per = 50;
  let all = []; let after = null; let hasNext = true;
  while (hasNext) {
    const data = await graphqlFetch(q, { org, per, after });
    const conn = data.organization && data.organization.repositories;
    if (!conn) break;
    all.push(...conn.nodes);
    hasNext = conn.pageInfo.hasNextPage;
    after = conn.pageInfo.endCursor;
  }
  return all.map(r => ({ name: r.name, updatedAt: r.updatedAt, openIssues: r.issues.totalCount }));
}

// Issues with subIssues (paginated)
async function getRepoIssuesWithSubIssues(owner, repo) {
  const q = `query($owner:String!,$repo:String!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){issues(first:$first,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title createdAt closedAt state stateReason url subIssues(first:100){nodes{number title createdAt closedAt state stateReason url}}} pageInfo{hasNextPage endCursor}}}}`;
  const per = 100;
  let all = []; let after = null; let hasNext = true;
  while (hasNext) {
    const data = await graphqlFetch(q, { owner, repo, first: per, after });
    if (!data.repository) break;
    const page = data.repository.issues;
    all.push(...page.nodes);
    hasNext = page.pageInfo.hasNextPage; after = page.pageInfo.endCursor;
  }
  return all;
}

// Rendering helpers
function clearContent() { content.innerHTML = ''; }

function renderRepoPlaceholder(repo) {
  const div = document.createElement('div');
  div.className = 'timeline placeholder';
  div.dataset.repo = repo.name;
  div.textContent = 'Loading ' + repo.name + '...';
  content.appendChild(div);
}

function renderRepoError(repoName, err) {
  const el = document.querySelector(`[data-repo="${repoName}"]`);
  if (el) el.textContent = 'Error: ' + (err.message || err);
}

// Full timeline render (copied and adapted from your renderer.js)
function renderRepoTimeline(repoName, issues) {
  const showClosedVal = showClosed.checked;
  const showNotPlannedVal = showNotPlanned.checked;
  const existing = document.querySelector(`[data-repo="${repoName}"]`);
  const container = existing || document.createElement('div');
  container.dataset.repo = repoName;
  container.className = 'timeline';

  if (!issues || issues.length === 0) {
    container.innerHTML = `<div class="repo-title">${repoName} — no issues</div>`;
    if (!existing) content.appendChild(container);
    return;
  }

  // Build parent-child from subIssues nodes, preserving expanded state
  const nodesMap = new Map();
  issues.forEach(i => {
    const wasExpanded = expandedState[i.number] || false;
    nodesMap.set(i.number, Object.assign({}, i, { children: [], expanded: wasExpanded }));
  });
  issues.forEach(i => {
    (i.subIssues && i.subIssues.nodes || []).forEach(c => {
      const child = nodesMap.get(c.number);
      if (child) {
        const parent = nodesMap.get(i.number);
        if (parent && !parent.children.includes(child)) parent.children.push(child);
      }
    });
  });
  const childSet = new Set();
  issues.forEach(i => (i.subIssues && i.subIssues.nodes || []).forEach(c => childSet.add(c.number)));
  const roots = issues.filter(i => !childSet.has(i.number)).map(i => nodesMap.get(i.number));

  // Filter by toggles
  function nodeVisible(n) {
    if (!showClosedVal && n.state === 'CLOSED') return false;
    if (!showNotPlannedVal && n.state === 'CLOSED' && n.stateReason === 'NOT_PLANNED') return false;
    return true;
  }
  function cloneIfVisible(node) {
    const cloned = Object.assign({}, node, { children: [] });
    for (const c of node.children) {
      const cc = cloneIfVisible(c);
      if (cc) cloned.children.push(cc);
    }
    return (nodeVisible(node) || cloned.children.length > 0) ? cloned : null;
  }
  const visibleRoots = roots.map(r => cloneIfVisible(r)).filter(x => x);

  if (visibleRoots.length === 0) {
    container.innerHTML = `<div class="repo-title">${repoName} — no visible issues</div>`;
    if (!existing) content.appendChild(container);
    return;
  }

  container.innerHTML = `<div class="repo-title">${repoName} — ${issues.length} issues</div><svg></svg>`;
  const svg = container.querySelector('svg');
  const marginLeft = 160;
  const width = Math.max(700, window.innerWidth - 200);
  const labelLeftX = 8;
  const indent = 16;

  function flatten(nodes, depth = 0) {
    let out = [];
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.expanded && n.children && n.children.length) out = out.concat(flatten(n.children, depth + 1));
    }
    return out;
  }

  function update() {
    const rows = flatten(visibleRoots);
    const rowsCount = Math.max(1, rows.length);
    const minDate = d3.min(rows, r => new Date(r.node.createdAt));
    const maxDate = d3.max(rows, r => new Date(r.node.closedAt || new Date()));
    const height = rowsCount * 28 + 60;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    // clear svg
    d3.select(svg).selectAll('*').remove();
    const g = d3.select(svg).append('g').attr('transform', `translate(${marginLeft},20)`);
    const x = d3.scaleTime().domain([minDate, maxDate]).range([0, width - marginLeft - 40]).nice();
    const y = d3.scaleBand().domain(rows.map((_,i) => i)).range([0, rowsCount * 28]).padding(0.12);

    g.append('g').attr('transform', `translate(0,${rowsCount * 28})`).call(d3.axisBottom(x).ticks(6));

    const row = g.selectAll('.row').data(rows).join('g').attr('class','row');

    row.append('rect')
      .attr('x', d => x(new Date(d.node.createdAt)))
      .attr('y', (_,i) => y(i))
      .attr('width', d => Math.max(3, x(new Date(d.node.closedAt || new Date())) - x(new Date(d.node.createdAt))))
      .attr('height', d => (d.node.state === 'CLOSED' && d.node.stateReason === 'NOT_PLANNED') ? Math.max(4, y.bandwidth() * 0.45) : Math.max(6, y.bandwidth()))
      .attr('rx', 3)
      .attr('fill', d => d.node.state === 'CLOSED' ? (d.node.stateReason === 'NOT_PLANNED' ? '#e53935' : '#4caf50') : '#1e88e5')
      .on('click', (_,d) => window.open(d.node.url, '_blank'))
      .append('title').text(d => `${d.node.title}\nCreated: ${d.node.createdAt}\nClosed: ${d.node.closedAt || 'Open'}`);

    // arrows for ongoing
    row.each(function(d,i) {
      if (d.node.state !== 'CLOSED') {
        const xEnd = x(new Date(d.node.closedAt || new Date()));
        const yMid = y(i) + y.bandwidth()/2;
        const s = Math.max(6, y.bandwidth()*0.45);
        d3.select(this).append('path')
          .attr('d', `M${xEnd} ${yMid - s/2} L${xEnd + s} ${yMid} L${xEnd} ${yMid + s/2} Z`)
          .attr('fill','#1e88e5');
      }
    });

    // labels left (with arrows / collapse)
    const labels = d3.select(svg).append('g').attr('transform', `translate(${labelLeftX},20)`);
    labels.selectAll('text').data(rows).join('text')
      .attr('x', d => d.depth * indent)
      .attr('y', (_,i) => y(i) + y.bandwidth()/1.35)
      .attr('text-anchor','start')
      .style('cursor', d => (d.node.children && d.node.children.length) ? 'pointer' : 'default')
      .text(d => ((d.node.children && d.node.children.length) ? (d.node.expanded ? '▼ ' : '▶ ') : '   ') + `#${d.node.number} ${d.node.title}`)
      .on('click', (_,d) => {
        if (d.node.children && d.node.children.length) {
          d.node.expanded = !d.node.expanded;
          expandedState[d.node.number] = d.node.expanded; // persist
          update();
        }
      });
  }

  update();
  if (!existing) content.appendChild(container);
}

// --- loadOrgData (fetch repos, sort with 0-issue to bottom, then fetch issues concurrently) ---
async function loadOrgData() {
  clearContent();
  isLoading = true;

  // Intro + sorting placeholders
  const intro = Object.assign(document.createElement('div'), { className: 'intro', textContent: 'Loading repositories...' });
  const sortingMsg = Object.assign(document.createElement('div'), { className: 'intro', textContent: 'Sorting repositories...' });
  content.appendChild(intro);

  let repos;
  try {
    repos = await listOrgRepos(ORG);
  } catch (e) {
    clearContent();
    content.appendChild(Object.assign(document.createElement('div'), { className: 'intro', textContent: 'Failed to list repositories: ' + (e.message || e) }));
    isLoading = false;
    return;
  }

  content.removeChild(intro);
  content.appendChild(sortingMsg);

  // Sort: non-empty first, then updatedAt desc. 0-issue repos to bottom
  repos.sort((a,b) => {
    const aEmpty = a.openIssues === 0;
    const bEmpty = b.openIssues === 0;
    if (aEmpty && !bEmpty) return 1;
    if (!aEmpty && bEmpty) return -1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  content.removeChild(sortingMsg);

  repoList = repos;
  repoList.forEach(r => renderRepoPlaceholder(r));

  // concurrent fetching
  const concurrency = 4;
  const queue = [...repoList];
  const active = [];

  async function runNext() {
    if (queue.length === 0) return;
    const repo = queue.shift();
    const p = getRepoIssuesWithSubIssues(ORG, repo.name)
      .then(issues => {
        repoIssues[repo.name] = issues;
        renderRepoTimeline(repo.name, issues);
      })
      .catch(e => {
        console.error('Error fetching', repo.name, e);
        renderRepoError(repo.name, e);
      })
      .finally(() => {
        const idx = active.indexOf(p);
        if (idx !== -1) active.splice(idx, 1);
        runNext();
      });
    active.push(p);
  }

  for (let i=0;i<concurrency;i++) runNext();
  await Promise.all(active);
  isLoading = false;
  const foot = document.createElement('div'); foot.className='footer'; foot.textContent='Done.'; content.appendChild(foot);
}

// --- Rerender preserving selected repo position (offsetTop method) ---
function rerenderAll() {
  if (isLoading) return;

  // Save absolute offsetTop of selected repo relative to container scroll
  let savedOffset = null;
  if (selectedRepoName) {
    const repoEl = document.querySelector(`[data-repo="${CSS.escape(selectedRepoName)}"]`);
    if (repoEl) savedOffset = repoEl.offsetTop - content.scrollTop;
  }

  // Rebuild UI
  clearContent();
  for (const r of repoList) {
    const issues = repoIssues[r.name];
    if (issues) renderRepoTimeline(r.name, issues);
    else renderRepoPlaceholder(r);
  }

  // Restore selected repo position and highlight
  if (selectedRepoName && savedOffset !== null) {
    const repoEl = document.querySelector(`[data-repo="${CSS.escape(selectedRepoName)}"]`);
    if (repoEl) {
      content.scrollTop = repoEl.offsetTop - savedOffset;
      repoEl.classList.add('repo-selected');
    }
  }
}

// --- Click-to-select repo + keep scroll offset ---
content.addEventListener('click', (ev) => {
  const repoEl = ev.target.closest && ev.target.closest('[data-repo]');
  if (!repoEl) return;

  // Remove previous highlight
  document.querySelectorAll('.timeline.repo-selected').forEach(el => el.classList.remove('repo-selected'));

  // Add new highlight
  repoEl.classList.add('repo-selected');
  selectedRepoName = repoEl.getAttribute('data-repo');

  // Save current scroll offset of that repo relative to content
  const rect = repoEl.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  selectedRepoScrollOffset = rect.top - contentRect.top + content.scrollTop;
  // also save offsetTop-based saved offset (used in rerender)
  // we keep selectedRepoName and saved offset is computed when rerender is called
});

// --- Filters handlers ---
showClosed.addEventListener('change', () => rerenderAll());
showNotPlanned.addEventListener('change', () => rerenderAll());

// --- Device flow (via Worker proxy) ---
async function startDeviceFlow() {
  try {
    oauthButton.disabled = true;
    statusText.textContent = 'Requesting device code from GitHub...';
    const resp = await fetch(`${PROXY}/device/code`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ scope: 'repo read:org' }) });
    const deviceData = await resp.json();
    if (deviceData.error) {
      statusText.textContent = 'Error: ' + (deviceData.error_description || deviceData.error);
      oauthButton.disabled = false;
      return;
    }

    // display code
    statusText.innerHTML = `<div><strong>Enter this code on GitHub:</strong></div>
      <div style="font-size:20px;font-weight:700;background:#fff;color:#000;padding:8px;border-radius:6px;display:inline-block;margin-top:6px;">${deviceData.user_code}</div>
      <div style="margin-top:8px;">Open the browser window and enter the code, then approve the app. Waiting for authorization...</div>`;
    content.innerHTML = `<div class="intro">Enter this code on GitHub: <strong style="font-size:18px;">${deviceData.user_code}</strong><br/><a href="${deviceData.verification_uri}" target="_blank">Open verification page</a></div>`;

    // Poll for token
    let interval = (deviceData.interval || 5) * 1000;
    const expiresAt = Date.now() + ((deviceData.expires_in || 900) * 1000);
    while (Date.now() < expiresAt) {
      await new Promise(r => setTimeout(r, interval));
      let tokenResp;
      try {
        tokenResp = await fetch(`${PROXY}/device/token`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ device_code: deviceData.device_code }) });
      } catch (e) {
        console.warn('Polling error', e);
        continue;
      }
      const j = await tokenResp.json();
      if (j.error) {
        if (j.error === 'authorization_pending') continue;
        if (j.error === 'slow_down') { interval += 5000; continue; }
        statusText.textContent = 'Auth error: ' + (j.error_description || j.error);
        oauthButton.disabled = false;
        return;
      }
      if (j.access_token) {
        TOKEN = j.access_token;
        localStorage.setItem('gh_token', TOKEN);
        hideAuthButtons();
        showLogoutButton();
        statusText.innerHTML = `<div style="color:lightgreen;font-weight:700;">Authorized successfully</div>`;
        await loadOrgData();
        oauthButton.disabled = false;
        return;
      }
    }
    statusText.textContent = 'Device flow timed out';
    oauthButton.disabled = false;
  } catch (e) {
    console.error('OAuth failed', e);
    statusText.textContent = 'OAuth failed: ' + (e.message || e);
    oauthButton.disabled = false;
  }
}

// --- PAT fallback ---
patButton.addEventListener('click', async ()=> {
  const t = prompt('Paste your GitHub Personal Access Token (scopes: repo, read:org)');
  if (!t) return;
  TOKEN = t.trim();
  localStorage.setItem('gh_token', TOKEN);
  hideAuthButtons();
  showLogoutButton();
  statusText.textContent = 'Authenticated (PAT)';
  await loadOrgData();
});

// attach OAuth button
oauthButton.addEventListener('click', () => startDeviceFlow());

// --- Auto-restore token on load ---
if (TOKEN) {
  hideAuthButtons();
  showLogoutButton();
  statusText.textContent = 'Restored previous session';
  // attempt to load data
  loadOrgData().catch(e => {
    console.warn('Failed to load after restore', e);
  });
} else {
  // ensure auth buttons visible
  if (authSection) authSection.style.display = 'block';
  statusText.textContent = 'Not signed in';
}

// expose for debugging
window._internal = { loadOrgData, rerenderAll };
