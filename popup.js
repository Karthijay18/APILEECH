(function() {
  const theme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  chrome.storage.local.get(['theme', 'shellMode'], (result) => {
    if (result.theme && result.theme !== theme) {
      document.documentElement.setAttribute('data-theme', result.theme);
      localStorage.setItem('theme', result.theme);
      const icon = document.getElementById('themeIcon');
      if (icon) icon.innerHTML = result.theme === 'dark' ? '&#9728;' : '&#9790;';
    }
    if (result.shellMode && (result.shellMode === 'cmd' || result.shellMode === 'ps')) {
      shellMode = result.shellMode;
      localStorage.setItem('shellMode', result.shellMode);
    }
  });
})();

function updateThemeIcon() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const icon = document.getElementById('themeIcon');
  if (icon) icon.innerHTML = theme === 'dark' ? '&#9728;' : '&#9790;';
}

let currentRequests = [];
let combinedRequestsCache = [];
let activeTabId = -1;
let activeTabDomain = '';
let currentView = 'current';
let modalList = [];
let modalIndex = -1;
let twitterRefreshInterval = null;
let tiktokRefreshInterval = null;
let soundcloudRefreshInterval = null;
let discordRefreshInterval = null;
let facebookRefreshInterval = null;
let instagramRefreshInterval = null;
let githubRefreshInterval = null;
let pinterestRefreshInterval = null;
let requestUrlSearchQuery = '';
const requestFilterMethods = new Set();
const requestFilterTypes = new Set();
const FILTER_METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const FILTER_TYPES = ['fetch', 'document'];
const TWITTER_REFRESH_MS = 2000;
const TIKTOK_REFRESH_MS = 2000;
const SOUNDCLOUD_REFRESH_MS = 2000;
const DISCORD_REFRESH_MS = 2000;
const FACEBOOK_REFRESH_MS = 2000;
const INSTAGRAM_REFRESH_MS = 2000;
const GITHUB_REFRESH_MS = 2000;
const PINTEREST_REFRESH_MS = 2000;
let lastTwitterDataSignature = '';
let lastTikTokDataSignature = '';
let lastSoundCloudDataSignature = '';
let lastDiscordDataSignature = '';
let lastFacebookDataSignature = '';
let lastInstagramDataSignature = '';
let lastGitHubDataSignature = '';
let lastPinterestDataSignature = '';
let instagramProfilePicBlobUrls = new Set();

function isGraphQLRequest(request) {
  if (!request.body || request.method !== 'POST') return false;
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    return body && typeof body.query === 'string';
  } catch {
    return false;
  }
}

function parseGraphQLBody(request) {
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    return { query: body.query || '', variables: body.variables || {} };
  } catch {
    return null;
  }
}

function formatGraphQLValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  if (Array.isArray(value)) return '[' + value.map(formatGraphQLValue).join(', ') + ']';
  if (typeof value === 'object') {
    const fields = Object.entries(value).map(([k, v]) => `${k}: ${formatGraphQLValue(v)}`);
    return '{ ' + fields.join(', ') + ' }';
  }
  return String(value);
}

function inlineVariables(queryStr, variables) {
  if (!variables) variables = {};

  let result = '';
  let inString = false;
  let escapeNext = false;
  let i = 0;

  while (i < queryStr.length) {
    if (escapeNext) {
      result += queryStr[i]; escapeNext = false; i++; continue;
    }
    if (queryStr[i] === '\\' && inString) {
      result += queryStr[i]; escapeNext = true; i++; continue;
    }
    if (queryStr[i] === '"') {
      result += queryStr[i]; inString = !inString; i++; continue;
    }
    if (inString) {
      result += queryStr[i]; i++; continue;
    }

    if (queryStr[i] === '$') {
      let varName = '';
      let j = i + 1;
      while (j < queryStr.length && /[a-zA-Z0-9_]/.test(queryStr[j])) {
        varName += queryStr[j]; j++;
      }
      if (varName) {
        const value = variables.hasOwnProperty(varName) ? variables[varName] : null;
        result += formatGraphQLValue(value);
        i = j;
        continue;
      }
    }

    result += queryStr[i]; i++;
  }
  return result;
}

function extractQueryInner(queryStr) {
  let q = queryStr.trim();
  q = q.replace(/^(query|subscription)\s*\w*\s*(\([^)]*\))?\s*/, '');

  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') { if (depth === 0) start = i + 1; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start !== -1) return q.slice(start, i).trim(); }
  }
  return q;
}

function isMutation(queryStr) {
  return queryStr.trim().startsWith('mutation');
}

function groupGraphQLRequests(requests) {
  const groups = {};
  requests.forEach((req, index) => {
    if (isGraphQLRequest(req)) {
      const parsed = parseGraphQLBody(req);
      if (parsed && !isMutation(parsed.query)) {
        if (!groups[req.url]) groups[req.url] = [];
        groups[req.url].push({ request: req, index });
      }
    }
  });
  const result = [];
  for (const [url, items] of Object.entries(groups)) {
    if (items.length >= 2) result.push({ url, items });
  }
  return result;
}

function buildCombinedRequest(group) {
  const seen = new Set();
  const uniqueItems = [];
  group.items.forEach(({ request }) => {
    const parsed = parseGraphQLBody(request);
    if (!parsed) return;
    const key = parsed.query.replace(/\s+/g, ' ').trim();
    if (!seen.has(key)) { seen.add(key); uniqueItems.push(request); }
  });
  if (uniqueItems.length < 2) return null;

  const queryParts = [];
  const descriptions = [];

  uniqueItems.forEach((request, i) => {
    const parsed = parseGraphQLBody(request);
    if (!parsed) return;

    let inner = extractQueryInner(parsed.query);
    inner = inlineVariables(inner, parsed.variables);

    queryParts.push(`q${i}: ${inner}`);

    const fieldMatch = inner.match(/^(\w+)/);
    const argMatch = inner.match(/\(([^)]*)\)/s);
    let desc = fieldMatch ? fieldMatch[1] : `query ${i}`;
    if (argMatch) {
      const strMatch = argMatch[1].match(/"([^"]*)"/);
      if (strMatch) {
        const val = strMatch[1];
        const short = val.split('~').pop() || val.split('@').pop() || val;
        desc += ` [${short.length > 30 ? short.substring(0, 30) + '...' : short}]`;
      }
    }
    descriptions.push(`q${i}: ${desc}`);
  });

  const combinedQuery = `{ ${queryParts.join(' ')} }`;
  const combinedBody = JSON.stringify({ variables: {}, query: combinedQuery });

  const template = group.items[0].request;
  return {
    url: group.url,
    method: 'POST',
    headers: template.headers,
    body: combinedBody,
    timestamp: new Date().toISOString(),
    type: 'combined',
    _combinedCount: uniqueItems.length,
    _descriptions: descriptions,
    _originalRequests: uniqueItems
  };
}

function compactBody(request) {
  if (!request.body || request.body === 'null') return null;
  let raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  try {
    const obj = JSON.parse(raw);
    if (obj.query && typeof obj.query === 'string') {
      obj.query = obj.query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return JSON.stringify(obj);
  } catch { return raw.replace(/\n/g, ' ').replace(/\s+/g, ' '); }
}

let shellMode = 'ps';

function generateCurl(request) {
  const method = request.method ? request.method.toUpperCase().replace(/[^A-Z]/g, '') : 'GET';
  
  if (shellMode === 'ps') {
    return generateCurlPS(request, method);
  } else {
    return generateCurlCMD(request, method);
  }
}

function generateCurlPS(request, method) {
  const esc = (str) => String(str).replace(/'/g, "''");
  
  let cmd = `curl.exe '${esc(request.url)}' -X ${method}`;
  
  if (request.headers) {
    const headers = Array.isArray(request.headers)
      ? request.headers
      : Object.entries(request.headers).map(([name, value]) => ({ name, value }));
    
    headers.forEach(h => {
      const name  = h.name  || h[0];
      const value = h.value || h[1];
      const skip  = ['host', 'connection', 'content-length', 'accept-encoding'];
      if (String(value) === 'undefined' || String(value) === 'null' || !value) return;
      if (skip.includes(name.toLowerCase())) return;
      
      cmd += ` -H '${esc(name)}: ${esc(value)}'`;
    });
  }

  const body = compactBody(request);
  if (body) {
    cmd += ` --data-raw '${esc(body)}'`;
  }
  
  cmd += ` --compressed`;
  return cmd;
}

function generateCurlCMD(request, method) {
  const escCmd = (str) => String(str).replace(/"/g, '\\"').replace(/&/g, '^&').replace(/\^/g, '^^');
  
  let cmd = `curl.exe "${escCmd(request.url)}" -X ${method}`;
  
  if (request.headers) {
    const headers = Array.isArray(request.headers)
      ? request.headers
      : Object.entries(request.headers).map(([name, value]) => ({ name, value }));
    
    headers.forEach(h => {
      const name  = h.name  || h[0];
      const value = h.value || h[1];
      const skip  = ['host', 'connection', 'content-length', 'accept-encoding'];
      if (String(value) === 'undefined' || String(value) === 'null' || !value) return;
      if (skip.includes(name.toLowerCase())) return;
      
      cmd += ` -H "${escCmd(name)}: ${escCmd(value)}"`;
    });
  }

  const body = compactBody(request);
  if (body) {
    cmd += ` --data-raw "${escCmd(body)}"`;
  }
  
  cmd += ` --compressed`;
  return cmd;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function countForCurrentSite(requests) {
  if (!activeTabDomain) return 0;
  return requests.filter(req => {
    if (req.initiator) {
      try { if (new URL(req.initiator).hostname === activeTabDomain) return true; } catch {}
    }
    if (req.url) {
      try { if (new URL(req.url).hostname === activeTabDomain) return true; } catch {}
    }
    return false;
  }).length;
}

function updateStats(requests) {
  const siteNameEl = document.getElementById('currentSiteName');
  if (siteNameEl) siteNameEl.textContent = activeTabDomain || '—';
  document.getElementById('currentSiteCount').textContent = countForCurrentSite(requests);
  document.getElementById('totalCount').textContent = requests.length;
}

function getResponseBodySearchString(req) {
  const v = req.responseBody;
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function tokenMatchesText(token, text) {
  if (!token || text == null) return !token;
  const t = String(text);
  if (!token.includes('*')) return t.toLowerCase().includes(token.toLowerCase());
  const parts = token.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = parts.join('.*');
  try {
    return new RegExp(pattern, 'i').test(t);
  } catch (_) {
    return t.toLowerCase().includes(token.toLowerCase());
  }
}

function matchRequestSearch(req, query) {
  if (!query || !String(query).trim()) return true;
  const tokens = String(query).trim().split(/\s+/).filter(Boolean);
  const urlStr = String(req.url || '');
  const bodyStr = getResponseBodySearchString(req);
  return tokens.every(t => tokenMatchesText(t, urlStr) || tokenMatchesText(t, bodyStr));
}

function renderRequests(requests) {
  const container = document.getElementById('requestsContainer');
  updateStats(requests);

  if (requests.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-text">Waiting for API requests...<br>Navigate any website to capture traffic</div></div>';
    return;
  }

  if (currentView === 'current') {
    renderCurrentTab(requests);
  } else if (currentView === 'twitter') {
    renderTwitterTab(requests);
  } else if (currentView === 'tiktok') {
    renderTikTokTab(requests);
  } else if (currentView === 'soundcloud') {
    renderSoundCloudTab(requests);
  } else if (currentView === 'discord') {
    renderDiscordTab(requests);
  } else if (currentView === 'facebook') {
    renderFacebookTab(requests);
  } else if (currentView === 'instagram') {
    renderInstagramTab(requests);
  } else if (currentView === 'github') {
    renderGitHubTab(requests);
  } else if (currentView === 'pinterest') {
    renderPinterestTab(requests);
  } else {
    renderHistoryTab(requests);
  }
}

function escapeHtml(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderCurrentTab(requests) {
  const container = document.getElementById('requestsContainer');

  let filteredRequests = requests.filter(req => {
    if (!activeTabDomain) return false;
    if (req.initiator) {
      try { if (new URL(req.initiator).hostname === activeTabDomain) return true; } catch {}
    }
    if (req.url) {
      try { if (new URL(req.url).hostname === activeTabDomain) return true; } catch {}
    }
    return false;
  });
  if (requestUrlSearchQuery.trim()) {
    filteredRequests = filteredRequests.filter(req => matchRequestSearch(req, requestUrlSearchQuery));
  }
  if (requestFilterMethods.size > 0) {
    filteredRequests = filteredRequests.filter(req => requestFilterMethods.has((req.method || '').toUpperCase()));
  }
  if (requestFilterTypes.size > 0) {
    filteredRequests = filteredRequests.filter(req => {
      const t = (req.type || 'fetch').toLowerCase();
      return requestFilterTypes.has(t);
    });
  }

  if (filteredRequests.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-text">
          No requests captured for<br>
          <span style="color:var(--blue);font-weight:600">${activeTabDomain || 'this tab'}</span>
        </div>
      </div>`;
    return;
  }

  let html = '';

  const groups = groupGraphQLRequests(filteredRequests);
  combinedRequestsCache = [];
  groups.forEach(group => {
    const combined = buildCombinedRequest(group);
    if (!combined) return;
    combinedRequestsCache.push(combined);
    let domain = '', pathname = '';
    try { const u = new URL(combined.url); domain = u.hostname; pathname = u.pathname; } catch { domain = combined.url; }
    const idx = combinedRequestsCache.length - 1;
    html += `
      <div class="request-card combined-card" data-combined-index="${idx}">
        <div class="combined-badge" style="margin-bottom: 0; padding: 1px 6px; font-size: 8px; flex-shrink: 0;">COMBINED</div>
        <div class="request-method method-post" style="margin-bottom: 0; min-width: 38px; padding: 1px 4px; font-size: 8px;">POST</div>
        <div class="request-url" style="font-size: 10px;">${domain}${pathname}</div>
        <div class="combined-info" style="margin-top: 0; font-size: 8px; flex-shrink: 0;">(${combined._combinedCount} queries)</div>
      </div>`;
  });

  html += filteredRequests.map((req) => {
    const mc = `method-${req.method.toLowerCase()}`;
    let displayUrl;
    try {
      const u = new URL(req.url);
      displayUrl = u.origin + u.pathname;
    } catch {
      displayUrl = req.url;
    }
    const originalIndex = currentRequests.findIndex(r => r.id === req.id);
    const typeLabel = (req.type || 'fetch').toLowerCase() === 'document' ? 'Document' : 'Fetch';
    const typeClass = typeLabel === 'Document' ? 'request-type-document' : 'request-type-fetch';
    return `
      <div class="request-card" data-index="${originalIndex}">
        <div class="request-method ${mc}">${req.method}</div>
        <div class="request-type ${typeClass}">${typeLabel}</div>
        <div class="request-url" title="${escapeHtml(req.url)}">${escapeHtml(displayUrl)}</div>
        <div class="request-time">${formatTime(req.timestamp)}</div>
      </div>`;
  }).join('');

  container.innerHTML = html;
  attachCardHandlers();
}

function renderHistoryTab(requests) {
  const container = document.getElementById('requestsContainer');

  let filteredRequests = requests;
  if (requestFilterMethods.size > 0) {
    filteredRequests = filteredRequests.filter(req => requestFilterMethods.has((req.method || '').toUpperCase()));
  }
  if (requestFilterTypes.size > 0) {
    filteredRequests = filteredRequests.filter(req => {
      const t = (req.type || 'fetch').toLowerCase();
      return requestFilterTypes.has(t);
    });
  }

  const groups = {};
  filteredRequests.forEach(req => {
    let domain;
    if (req.initiator) {
      try { domain = new URL(req.initiator).hostname; } catch { domain = req.initiator; }
    } else {
      try { domain = new URL(req.url).hostname; } catch { domain = 'Unknown'; }
    }
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(req);
  });

  const domains = Object.keys(groups).sort();
  
  if (domains.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-text">No history available</div></div>';
    return;
  }

  let html = domains.map(domain => {
    const domainRequests = groups[domain];
    const reqHtml = domainRequests.map(req => {
      const mc = `method-${req.method.toLowerCase()}`;
      const originalIndex = currentRequests.findIndex(r => r.id === req.id);
      let displayUrl;
      try {
        const u = new URL(req.url);
        displayUrl = u.origin + u.pathname;
      } catch {
        displayUrl = req.url;
      }
      const typeLabel = (req.type || 'fetch').toLowerCase() === 'document' ? 'Document' : 'Fetch';
      const typeClass = typeLabel === 'Document' ? 'request-type-document' : 'request-type-fetch';
      return `
        <div class="request-card" data-index="${originalIndex}" style="margin-bottom: 4px; padding: 4px 8px;">
          <div class="request-method ${mc}" style="min-width: 38px; padding: 1px 4px; font-size: 8px;">${req.method}</div>
          <div class="request-type ${typeClass}" style="font-size: 8px;">${typeLabel}</div>
          <div class="request-url" style="font-size: 10px;" title="${escapeHtml(req.url)}">${escapeHtml(displayUrl)}</div>
          <div class="request-time" style="font-size: 8px;">${formatTime(req.timestamp)}</div>
        </div>`;
    }).join('');

    return `
      <div class="history-domain-group">
        <div class="history-domain-header">
          <span class="history-domain-name">${domain}</span>
          <span class="history-domain-count">${domainRequests.length}</span>
        </div>
        <div class="history-requests">
          ${reqHtml}
        </div>
      </div>`;
  }).join('');

  container.innerHTML = html;
  attachHistoryHandlers();
}

function attachCardHandlers() {
  document.querySelectorAll('.combined-card').forEach(c => {
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(c.dataset.combinedIndex);
      modalList = combinedRequestsCache;
      modalIndex = index;
      showRequestDetails(modalList[modalIndex]);
    });
  });
  document.querySelectorAll('.request-card:not(.combined-card)').forEach(c => {
    if (c.dataset.index === undefined) return;
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(c.dataset.index);
      if (currentView === 'current') {
        const filtered = currentRequests.filter(req => {
          if (!activeTabDomain) return false;
          if (req.initiator) {
            try { if (new URL(req.initiator).hostname === activeTabDomain) return true; } catch {}
          }
          if (req.url) {
            try { if (new URL(req.url).hostname === activeTabDomain) return true; } catch {}
          }
          return false;
        });
        modalList = filtered;
        modalIndex = modalList.findIndex(r => r.id === currentRequests[index].id);
      } else {
        modalList = currentRequests;
        modalIndex = index;
      }
      showRequestDetails(modalList[modalIndex]);
    });
  });
}

function attachHistoryHandlers() {
  document.querySelectorAll('.history-domain-header').forEach(header => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('open');
    });
  });
  
  attachCardHandlers();
}

function showRequestDetails(request) {
  if (!request) return;
  
  const modal = document.getElementById('detailModal');
  const isCombined = request.type === 'combined';
  const suffix = isCombined ? ` (${request._combinedCount} queries → 1 request)` : '';

  const prevBtn = document.getElementById('prevRequest');
  const nextBtn = document.getElementById('nextRequest');
  const navInfo = document.getElementById('navInfo');

  if (prevBtn && nextBtn && navInfo) {
    prevBtn.disabled = modalIndex <= 0;
    nextBtn.disabled = modalIndex >= modalList.length - 1;
    navInfo.textContent = `${modalIndex + 1} / ${modalList.length}`;
  }

  document.getElementById('curlLabel').textContent = 'cURL Command' + suffix;
  document.getElementById('curlCommand').textContent = generateCurl(request);

  const infoSection = document.getElementById('combinedInfoSection');
  if (isCombined && request._descriptions) {
    infoSection.style.display = 'block';
    infoSection.querySelector('.info-content').innerHTML =
      `<strong>${request._combinedCount} queries merged using GraphQL aliases:</strong><br>` +
      request._descriptions.map(d => `&nbsp;&nbsp;• ${d}`).join('<br>') +
      '<br><br><em>Response data will be under keys q0, q1, q2, etc.</em>';
  } else {
    infoSection.style.display = 'none';
  }

  document.getElementById('detailUrl').textContent = request.url;
  document.getElementById('detailMethod').innerHTML =
    `<strong>Method:</strong> ${request.method}<br>` +
    `<strong>Time:</strong> ${new Date(request.timestamp).toLocaleString()}<br>` +
    `<strong>Type:</strong> ${request.type}`;

  const dh = document.getElementById('detailHeaders');
  if (request.headers) {
    const hdrs = Array.isArray(request.headers) ? request.headers : Object.entries(request.headers);
    const filtered = hdrs.filter(h => { const v = h.value||h[1]; return v && String(v)!=='undefined' && String(v)!=='null'; });
    dh.innerHTML = filtered.length
      ? filtered.map(h => `<strong>${h.name||h[0]}:</strong> ${h.value||h[1]}`).join('<br>')
      : 'No headers captured';
  } else { dh.textContent = 'No headers captured'; }

  const bs = document.getElementById('bodySection');
  const db = document.getElementById('detailBody');
  if (request.body && request.body !== 'null') {
    bs.style.display = 'block';
    if (typeof request.body === 'string') {
      try { db.textContent = JSON.stringify(JSON.parse(request.body), null, 2); }
      catch { db.textContent = request.body; }
    } else if (typeof request.body === 'object') {
      db.textContent = JSON.stringify(request.body, null, 2);
    } else { db.textContent = String(request.body); }
  } else { bs.style.display = 'none'; }

  const rs = document.getElementById('responseSection');
  const dr = document.getElementById('detailResponse');
  const responseTitleEl = document.getElementById('responseSectionTitle');
  const isDocument = (request.type || '').toLowerCase() === 'document';
  const hasResponseBody = request.responseBody && request.responseBody !== 'null';

  if (isDocument || hasResponseBody) {
    rs.style.display = 'block';
    responseTitleEl.textContent = isDocument ? 'Document Contents' : 'Response Body';
    if (hasResponseBody) {
      if (typeof request.responseBody === 'string') {
        try { dr.textContent = JSON.stringify(JSON.parse(request.responseBody), null, 2); }
        catch { dr.textContent = request.responseBody; }
      } else {
        dr.textContent = String(request.responseBody);
      }
    } else {
      dr.textContent = isDocument ? '(No document content captured. Main frame responses are not intercepted by the extension.)' : '(No response body)';
    }
  } else {
    rs.style.display = 'none';
    if (responseTitleEl) responseTitleEl.textContent = 'Response Body';
  }

  document.getElementById('detailModal').classList.add('active');
}

function copyElement(textId, btnId) {
  const el  = document.getElementById(textId);
  const btn = document.getElementById(btnId);
  navigator.clipboard.writeText(el.textContent).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
  });
}

function closeModal() { document.getElementById('detailModal').classList.remove('active'); }

function navigateModal(direction) {
  const newIndex = modalIndex + direction;
  if (newIndex >= 0 && newIndex < modalList.length) {
    modalIndex = newIndex;
    showRequestDetails(modalList[modalIndex]);
  }
}

function getActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      activeTabId = tabs[0].id;
      try { activeTabDomain = new URL(tabs[0].url).hostname; } catch { activeTabDomain = ''; }
      loadRequests();
    }
  });
}

function loadRequests() {
  chrome.runtime.sendMessage({ action: 'getRequests' }, r => {
    if (r && r.requests) { currentRequests = r.requests; renderRequests(currentRequests); }
  });
}

function stopTwitterRefresh() {
  if (twitterRefreshInterval) {
    clearInterval(twitterRefreshInterval);
    twitterRefreshInterval = null;
  }
}

function startTwitterRefresh() {
  stopTwitterRefresh();
  twitterRefreshInterval = setInterval(loadRequests, TWITTER_REFRESH_MS);
}

function stopTikTokRefresh() {
  if (tiktokRefreshInterval) {
    clearInterval(tiktokRefreshInterval);
    tiktokRefreshInterval = null;
  }
}

function startTikTokRefresh() {
  stopTikTokRefresh();
  tiktokRefreshInterval = setInterval(loadRequests, TIKTOK_REFRESH_MS);
}

function stopSoundCloudRefresh() {
  if (soundcloudRefreshInterval) {
    clearInterval(soundcloudRefreshInterval);
    soundcloudRefreshInterval = null;
  }
}

function startSoundCloudRefresh() {
  stopSoundCloudRefresh();
  soundcloudRefreshInterval = setInterval(loadRequests, SOUNDCLOUD_REFRESH_MS);
}

function stopDiscordRefresh() {
  if (discordRefreshInterval) {
    clearInterval(discordRefreshInterval);
    discordRefreshInterval = null;
  }
}

function startDiscordRefresh() {
  stopDiscordRefresh();
  discordRefreshInterval = setInterval(loadRequests, DISCORD_REFRESH_MS);
}

function stopFacebookRefresh() {
  if (facebookRefreshInterval) {
    clearInterval(facebookRefreshInterval);
    facebookRefreshInterval = null;
  }
}

function startFacebookRefresh() {
  stopFacebookRefresh();
  facebookRefreshInterval = setInterval(loadRequests, FACEBOOK_REFRESH_MS);
}

function stopInstagramRefresh() {
  if (instagramRefreshInterval) {
    clearInterval(instagramRefreshInterval);
    instagramRefreshInterval = null;
  }
}

function startInstagramRefresh() {
  stopInstagramRefresh();
  instagramRefreshInterval = setInterval(loadRequests, INSTAGRAM_REFRESH_MS);
}

function stopGitHubRefresh() {
  if (githubRefreshInterval) {
    clearInterval(githubRefreshInterval);
    githubRefreshInterval = null;
  }
}

function startGitHubRefresh() {
  stopGitHubRefresh();
  githubRefreshInterval = setInterval(loadRequests, GITHUB_REFRESH_MS);
}

function stopPinterestRefresh() {
  if (pinterestRefreshInterval) {
    clearInterval(pinterestRefreshInterval);
    pinterestRefreshInterval = null;
  }
}

function startPinterestRefresh() {
  stopPinterestRefresh();
  pinterestRefreshInterval = setInterval(loadRequests, PINTEREST_REFRESH_MS);
}

function clearRequests() {
  chrome.runtime.sendMessage({ action: 'clearRequests' }, r => {
    if (r && r.success) { currentRequests = []; combinedRequestsCache = []; renderRequests(currentRequests); }
  });
}

function exportHistoryToFile() {
  chrome.runtime.sendMessage({ action: 'getRequestsForExport' }, (r) => {
    if (!r || !Array.isArray(r.requests)) return;
    const payload = { version: 1, exportedAt: new Date().toISOString(), requests: r.requests };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    if (typeof showSaveFilePicker !== 'undefined') {
      showSaveFilePicker({ suggestedName: 'requeststealer_history.json', types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] })
        .then((handle) => handle.createWritable())
        .then((writable) => writable.write(blob).then(() => writable.close()))
        .catch(() => {});
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'requeststealer_history.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  });
}

function importHistoryFromFile() {
  if (typeof showOpenFilePicker !== 'undefined') {
    showOpenFilePicker({ types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }], multiple: false })
      .then(([fileHandle]) => fileHandle.getFile())
      .then((file) => file.text())
      .then((text) => {
        let list = [];
        try {
          const data = JSON.parse(text);
          list = Array.isArray(data) ? data : (data && Array.isArray(data.requests) ? data.requests : []);
        } catch (_) {}
        if (list.length === 0) return;
        chrome.runtime.sendMessage({ action: 'importHistory', requests: list }, (r) => {
          if (r && r.success) { loadRequests(); }
        });
      })
      .catch(() => {});
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let list = [];
        try {
          const data = JSON.parse(reader.result);
          list = Array.isArray(data) ? data : (data && Array.isArray(data.requests) ? data.requests : []);
        } catch (_) {}
        if (list.length === 0) return;
        chrome.runtime.sendMessage({ action: 'importHistory', requests: list }, (r) => {
          if (r && r.success) { loadRequests(); }
        });
      };
      reader.readAsText(file);
    };
    input.click();
  }
}

function loadShellMode() {
  const saved = localStorage.getItem('shellMode');
  if (saved === 'cmd' || saved === 'ps') shellMode = saved;
  updateShellToggle();
}

function updateShellToggle() {
  const psBtn = document.getElementById('shellPS');
  const cmdBtn = document.getElementById('shellCMD');
  if (!psBtn || !cmdBtn) return;
  psBtn.classList.toggle('active', shellMode === 'ps');
  cmdBtn.classList.toggle('active', shellMode === 'cmd');
}

function switchShellMode(mode) {
  shellMode = mode;
  localStorage.setItem('shellMode', mode);
  chrome.storage.local.set({ shellMode: mode });
  updateShellToggle();
  if (modalList.length > 0 && modalIndex >= 0 && modalList[modalIndex]) {
    document.getElementById('curlCommand').textContent = generateCurl(modalList[modalIndex]);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateThemeIcon();
  loadShellMode();
  
  document.getElementById('requestsContainer').addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (img && img.src) {
      e.preventDefault();
      const url = img.src;
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create)
          chrome.tabs.create({ url });
        else
          window.open(url, '_blank', 'noopener');
      } catch (_) {
        window.open(url, '_blank', 'noopener');
      }
      return;
    }
    const el = e.target.closest('.tiktok-download-captions');
    if (!el) return;
    e.preventDefault();
    const url = el.getAttribute('data-caption-url');
    const videoId = el.getAttribute('data-video-id');
    if (url) downloadTikTokCaptionsAsTxt(url, videoId);
  });

  document.getElementById('refreshBtn').addEventListener('click', () => {
    const container = document.getElementById('requestsContainer');
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-text">
            Refreshing...<br>
            Fetching latest network traffic
          </div>
        </div>`;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0] && tabs[0].url) {
        try { activeTabDomain = new URL(tabs[0].url).hostname; } catch {}
      }

      lastTwitterDataSignature = '';
      lastTikTokDataSignature = '';
      lastSoundCloudDataSignature = '';
      lastDiscordDataSignature = '';
      lastFacebookDataSignature = '';
      lastInstagramDataSignature = '';
      lastGitHubDataSignature = '';
      lastPinterestDataSignature = '';

      loadRequests();
    });
  });
  document.getElementById('clearBtn').addEventListener('click', clearRequests);
  document.getElementById('exportHistoryBtn').addEventListener('click', () => exportHistoryToFile());

  (function initRequestSearch() {
    const popup = document.getElementById('requestSearchPopup');
    const input = document.getElementById('requestSearchInput');
    const searchBtn = document.getElementById('searchRequestsBtn');
    if (!popup || !input || !searchBtn) return;
    searchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const visible = popup.classList.toggle('visible');
      if (visible) {
        input.value = requestUrlSearchQuery;
        input.focus();
      }
    });
    input.addEventListener('input', () => {
      requestUrlSearchQuery = input.value;
      renderRequests(currentRequests);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        popup.classList.remove('visible');
        searchBtn.focus();
      }
    });
    document.addEventListener('click', (e) => {
      if (popup.classList.contains('visible') && !popup.contains(e.target) && !searchBtn.contains(e.target)) {
        popup.classList.remove('visible');
      }
    });
  })();

  (function initRequestFilter() {
    const filterPopup = document.getElementById('requestFilterPopup');
    const filterBtn = document.getElementById('filterRequestsBtn');
    const methodsEl = document.getElementById('filterMethodsOptions');
    const typesEl = document.getElementById('filterTypesOptions');
    if (!filterPopup || !filterBtn || !methodsEl || !typesEl) return;

    methodsEl.innerHTML = FILTER_METHODS.map(m => {
      const id = 'filter-method-' + m;
      const checked = requestFilterMethods.has(m) ? ' checked' : '';
      return `<label><input type="checkbox" id="${id}" data-method="${m}"${checked}>${m}</label>`;
    }).join('');
    typesEl.innerHTML = FILTER_TYPES.map(t => {
      const id = 'filter-type-' + t;
      const label = t === 'document' ? 'Document' : 'Fetch';
      const checked = requestFilterTypes.has(t) ? ' checked' : '';
      return `<label><input type="checkbox" id="${id}" data-type="${t}"${checked}>${label}</label>`;
    }).join('');

    filterPopup.querySelectorAll('input[data-method]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) requestFilterMethods.add(cb.dataset.method);
        else requestFilterMethods.delete(cb.dataset.method);
        renderRequests(currentRequests);
      });
    });
    filterPopup.querySelectorAll('input[data-type]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) requestFilterTypes.add(cb.dataset.type);
        else requestFilterTypes.delete(cb.dataset.type);
        renderRequests(currentRequests);
      });
    });

    filterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('requestSearchPopup').classList.remove('visible');
      filterPopup.classList.toggle('visible');
    });
    document.addEventListener('click', (e) => {
      if (filterPopup.classList.contains('visible') && !filterPopup.contains(e.target) && !filterBtn.contains(e.target)) {
        filterPopup.classList.remove('visible');
      }
    });
  })();

  document.getElementById('closeModal').addEventListener('click', closeModal);
  document.getElementById('copyCurlBtn').addEventListener('click', () => copyElement('curlCommand', 'copyCurlBtn'));
  document.getElementById('copyResponseBtn').addEventListener('click', () => copyElement('detailResponse', 'copyResponseBtn'));

  document.getElementById('prevRequest').addEventListener('click', () => navigateModal(-1));
  document.getElementById('nextRequest').addEventListener('click', () => navigateModal(1));

  document.getElementById('shellPS').addEventListener('click', () => switchShellMode('ps'));
  document.getElementById('shellCMD').addEventListener('click', () => switchShellMode('cmd'));

  document.getElementById('currentTabBtn').addEventListener('click', () => {
    currentView = 'current';
    document.getElementById('currentTabBtn').classList.add('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    document.getElementById('pinterestTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    stopGitHubRefresh();
    stopPinterestRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    lastGitHubDataSignature = '';
    lastPinterestDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('historyTabBtn').addEventListener('click', () => {
    currentView = 'history';
    document.getElementById('historyTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    document.getElementById('pinterestTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    stopGitHubRefresh();
    stopPinterestRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    lastGitHubDataSignature = '';
    lastPinterestDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('twitterTabBtn').addEventListener('click', () => {
    currentView = 'twitter';
    document.getElementById('twitterTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    startTwitterRefresh();
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('tiktokTabBtn').addEventListener('click', () => {
    currentView = 'tiktok';
    document.getElementById('tiktokTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    document.getElementById('pinterestTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    startTikTokRefresh();
    lastTwitterDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('soundcloudTabBtn').addEventListener('click', () => {
    currentView = 'soundcloud';
    document.getElementById('soundcloudTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    document.getElementById('pinterestTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    startSoundCloudRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('discordTabBtn').addEventListener('click', () => {
    currentView = 'discord';
    document.getElementById('discordTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    document.getElementById('pinterestTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    startDiscordRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('facebookTabBtn').addEventListener('click', () => {
    currentView = 'facebook';
    document.getElementById('facebookTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    document.getElementById('pinterestTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopInstagramRefresh();
    stopPinterestRefresh();
    startFacebookRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastInstagramDataSignature = '';
    lastGitHubDataSignature = '';
    lastPinterestDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('instagramTabBtn').addEventListener('click', () => {
    currentView = 'instagram';
    document.getElementById('instagramTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    document.getElementById('pinterestTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopGitHubRefresh();
    stopPinterestRefresh();
    startInstagramRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastGitHubDataSignature = '';
    lastPinterestDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('githubTabBtn').addEventListener('click', () => {
    currentView = 'github';
    document.getElementById('githubTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    startGitHubRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    lastPinterestDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('pinterestTabBtn').addEventListener('click', () => {
    currentView = 'pinterest';
    document.getElementById('pinterestTabBtn').classList.add('active');
    document.getElementById('currentTabBtn').classList.remove('active');
    document.getElementById('historyTabBtn').classList.remove('active');
    document.getElementById('twitterTabBtn').classList.remove('active');
    document.getElementById('tiktokTabBtn').classList.remove('active');
    document.getElementById('soundcloudTabBtn').classList.remove('active');
    document.getElementById('discordTabBtn').classList.remove('active');
    document.getElementById('facebookTabBtn').classList.remove('active');
    document.getElementById('instagramTabBtn').classList.remove('active');
    document.getElementById('githubTabBtn').classList.remove('active');
    stopTwitterRefresh();
    stopTikTokRefresh();
    stopSoundCloudRefresh();
    stopDiscordRefresh();
    stopFacebookRefresh();
    stopInstagramRefresh();
    stopGitHubRefresh();
    startPinterestRefresh();
    lastTwitterDataSignature = '';
    lastTikTokDataSignature = '';
    lastSoundCloudDataSignature = '';
    lastDiscordDataSignature = '';
    lastFacebookDataSignature = '';
    lastInstagramDataSignature = '';
    lastGitHubDataSignature = '';
    lastPinterestDataSignature = '';
    renderRequests(currentRequests);
  });

  document.getElementById('detailModal').addEventListener('click', e => {
    if (e.target.id === 'detailModal') closeModal();
  });

  document.getElementById('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    chrome.storage.local.set({ theme: next });
    updateThemeIcon();
  });

  getActiveTab();
});

chrome.tabs.onActivated.addListener(getActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.url) {
    getActiveTab();
  }
});

window.addEventListener('pagehide', () => {
  stopTwitterRefresh();
  stopTikTokRefresh();
  stopSoundCloudRefresh();
  stopDiscordRefresh();
  stopFacebookRefresh();
  stopInstagramRefresh();
  stopGitHubRefresh();
  stopPinterestRefresh();
});
