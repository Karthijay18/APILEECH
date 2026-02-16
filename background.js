const pendingRequests = {};
const bodyBuffer = [];
const responseBuffer = [];
let capturedRequests = [];
let currentTabId = null;
let currentTabHostname = null;
const MAX_REQUESTS = 2000;
const MAX_BODY_BUFFER = 200;
const FALLBACK_WAIT_MS = 1500;
const MAX_CAPTURED_BODY_CHARS = 120000;
const MAX_CAPTURED_RESPONSE_CHARS = 1200000;
const MAX_POPUP_MESSAGE_BYTES = 56 * 1024 * 1024;
const STATIC_FILTER_STORAGE_KEY = 'hideStaticResources';
let hideStaticResourcesEnabled = true;
const ACTIVE_INTERCEPTION_MAX_ENDPOINTS_PER_TAB = 2000;
const ACTIVE_INTERCEPTION_MAX_SCRIPT_SOURCE_CHARS = 800000;
const ACTIVE_INTERCEPTION_MAX_ENDPOINT_SNIPPET_CHARS = 240;
const ACTIVE_INTERCEPTION_MAX_SOURCES_PER_ENDPOINT = 8;
const ACTIVE_INTERCEPTION_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ACTIVE_INTERCEPTION_NON_ENDPOINT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.less',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2',
  '.ttf', '.eot', '.otf', '.map', '.mp4', '.webm', '.mp3', '.wav', '.pdf', '.zip'
]);
const activeInterceptionByTab = Object.create(null);

const STATIC_FILE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.less',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.map', '.bmp', '.tiff'
]);
const FRAMEWORK_FILE_PATTERNS = [
  'jquery', 'react', 'vue', 'angular', 'bootstrap', 'lodash', 'moment',
  'webpack', 'chunk', 'bundle', 'vendor', 'polyfill', 'runtime'
];
const STATIC_CDN_DOMAINS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'stackpath.bootstrapcdn.com'
];

function hostnameMatchesStaticCdn(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host) return false;
  return STATIC_CDN_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function hasStaticExtension(pathname) {
  const path = (pathname || '').toLowerCase();
  if (!path) return false;
  const lastSegment = path.split('/').pop() || path;
  const dot = lastSegment.lastIndexOf('.');
  if (dot === -1) return false;
  return STATIC_FILE_EXTENSIONS.has(lastSegment.slice(dot));
}

function hasFrameworkPattern(pathname) {
  const path = (pathname || '').toLowerCase();
  if (!path) return false;
  const fileName = path.split('/').pop() || path;
  const value = fileName;
  return FRAMEWORK_FILE_PATTERNS.some(pattern => value.includes(pattern));
}

function isStaticOrFrameworkResource(urlValue) {
  if (!urlValue || typeof urlValue !== 'string') return false;
  const lower = urlValue.trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith('data:image/')) return true;

  let parsed;
  try { parsed = new URL(urlValue); } catch { return false; }
  const protocol = (parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  if (hostnameMatchesStaticCdn(parsed.hostname)) return true;
  if (hasStaticExtension(parsed.pathname)) return true;
  return hasFrameworkPattern(parsed.pathname);
}

function isRequestStaticResource(req) {
  if (!req || typeof req !== 'object') return false;
  if (typeof req.isStaticResource === 'boolean') return req.isStaticResource;
  return isStaticOrFrameworkResource(req.url);
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch (_) {}
  try { return String(value); } catch (_) {}
  return '';
}

function normalizePayloadText(value, maxChars) {
  if (value === undefined || value === null || value === '') return null;
  let out = typeof value === 'string' ? value : safeStringify(value);
  if (!out) return null;
  if (out.length > maxChars) {
    const omitted = out.length - maxChars;
    out = out.slice(0, maxChars) + `\n\n/* truncated ${omitted} chars */`;
  }
  return out;
}

function sanitizeRequestForMemory(req) {
  if (!req || typeof req !== 'object') return null;
  const isStaticResource = isRequestStaticResource(req);
  return {
    id: req.id != null ? req.id : (Date.now() + Math.random()),
    url: req.url || '',
    method: req.method || 'GET',
    headers: Array.isArray(req.headers) ? req.headers : [],
    body: normalizePayloadText(req.body, MAX_CAPTURED_BODY_CHARS),
    responseBody: normalizePayloadText(req.responseBody, MAX_CAPTURED_RESPONSE_CHARS),
    timestamp: req.timestamp || new Date().toISOString(),
    type: req.type || 'fetch',
    tabId: req.tabId != null ? req.tabId : -1,
    initiator: req.initiator || '',
    isStaticResource,
  };
}

function getActiveInterceptionState(tabId) {
  const key = Number(tabId);
  if (!Number.isFinite(key) || key < 0) return null;
  if (!activeInterceptionByTab[key]) {
    activeInterceptionByTab[key] = {
      tabId: key,
      scannedScriptKeys: Object.create(null),
      endpointsByKey: Object.create(null),
      scriptsScanned: 0,
      endpointHits: 0,
      updatedAt: null,
    };
  }
  return activeInterceptionByTab[key];
}

function clearActiveInterceptionState(tabId) {
  const key = Number(tabId);
  if (!Number.isFinite(key) || key < 0) return;
  delete activeInterceptionByTab[key];
}

function pushUniqueLimited(list, value, maxSize) {
  if (!Array.isArray(list) || value == null || value === '') return;
  if (!list.includes(value)) list.push(value);
  if (typeof maxSize === 'number' && maxSize > 0 && list.length > maxSize) {
    list.splice(0, list.length - maxSize);
  }
}

function hasLikelyStaticExtension(pathOrUrl) {
  if (!pathOrUrl) return false;
  let pathname = String(pathOrUrl);
  try {
    pathname = new URL(pathOrUrl, 'https://example.invalid/').pathname || pathname;
  } catch (_) {}
  const normalized = pathname.split('?')[0].split('#')[0].toLowerCase();
  const dotIdx = normalized.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return ACTIVE_INTERCEPTION_NON_ENDPOINT_EXTENSIONS.has(normalized.slice(dotIdx));
}

function looksLikeEndpointCandidate(rawValue, forceInclude) {
  if (rawValue === undefined || rawValue === null) return false;
  const value = String(rawValue).trim();
  if (!value || value.length < 2 || value.length > 500) return false;
  if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return false;
  if (hasLikelyStaticExtension(value)) return false;
  if (forceInclude) return true;

  const lower = value.toLowerCase();
  if (/^https?:\/\//.test(lower)) return true;
  if (value.startsWith('/')) return true;
  if (lower.includes('/api') || lower.includes('graphql') || lower.includes('/rest')) return true;
  if (/\/v[1-9](\/|$|\?)/i.test(lower)) return true;
  if (lower.includes('/auth') || lower.includes('/oauth') || lower.includes('/session') || lower.includes('/token')) return true;
  if (lower.includes('?') && lower.includes('=')) return true;
  return false;
}

function resolveEndpointUrl(rawUrl, scriptUrl, pageUrl) {
  if (!rawUrl) return null;
  const value = String(rawUrl).trim();
  if (!value || value.includes('${')) return null;

  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).href;
  } catch (_) {}

  if (value.startsWith('//')) {
    try {
      const base = new URL(pageUrl || scriptUrl || 'https://example.invalid/');
      return `${base.protocol}${value}`;
    } catch (_) {
      return null;
    }
  }

  try {
    const base = pageUrl || scriptUrl;
    if (!base) return null;
    return new URL(value, base).href;
  } catch (_) {
    return null;
  }
}

function normalizeEndpointKey(urlLike) {
  if (!urlLike) return '';
  const value = String(urlLike).trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return value;
  }
}

function extractSnippetAt(source, index) {
  if (!source || typeof source !== 'string') return '';
  const at = Number(index);
  if (!Number.isFinite(at) || at < 0) return '';
  const lineStart = Math.max(0, source.lastIndexOf('\n', at - 1) + 1);
  let lineEnd = source.indexOf('\n', at);
  if (lineEnd === -1) lineEnd = source.length;
  let snippet = source.slice(lineStart, lineEnd).trim();
  if (snippet.length > ACTIVE_INTERCEPTION_MAX_ENDPOINT_SNIPPET_CHARS) {
    snippet = snippet.slice(0, ACTIVE_INTERCEPTION_MAX_ENDPOINT_SNIPPET_CHARS) + '...';
  }
  return snippet;
}

function normalizeMethod(value, fallback) {
  const method = String(value || '').toUpperCase().trim();
  if (ACTIVE_INTERCEPTION_METHODS.has(method)) return method;
  return fallback || 'GET';
}

function readMethodFromOptionsBlock(optionsBlock) {
  if (!optionsBlock || typeof optionsBlock !== 'string') return 'GET';
  const methodMatch = /method\s*:\s*['"`]([a-z]+)['"`]/i.exec(optionsBlock);
  if (!methodMatch) return 'GET';
  return normalizeMethod(methodMatch[1], 'GET');
}

function readMethodFromAxiosConfig(configBlock) {
  if (!configBlock || typeof configBlock !== 'string') return 'GET';
  const methodMatch = /method\s*:\s*['"`]([a-z]+)['"`]/i.exec(configBlock);
  if (!methodMatch) return 'GET';
  return normalizeMethod(methodMatch[1], 'GET');
}

function readUrlFromAxiosConfig(configBlock) {
  if (!configBlock || typeof configBlock !== 'string') return null;
  const urlMatch = /url\s*:\s*(['"`])([^'"`\n\r]{2,500})\1/i.exec(configBlock);
  return urlMatch ? urlMatch[2] : null;
}

function buildEndpointCandidatesFromScript(sourceText, meta) {
  if (!sourceText || typeof sourceText !== 'string') return [];
  const source = sourceText.slice(0, ACTIVE_INTERCEPTION_MAX_SCRIPT_SOURCE_CHARS);
  const candidates = [];
  const seen = new Set();

  function pushCandidate(rawUrl, method, matcher, confidence, index, forceInclude) {
    if (!looksLikeEndpointCandidate(rawUrl, forceInclude)) return;
    const normalizedMethod = normalizeMethod(method, 'GET');
    const resolvedUrl = resolveEndpointUrl(rawUrl, meta.scriptUrl, meta.pageUrl);
    const endpointUrl = resolvedUrl || String(rawUrl).trim();
    if (!endpointUrl) return;
    const uniqKey = `${normalizedMethod}||${endpointUrl}||${index}||${matcher}`;
    if (seen.has(uniqKey)) return;
    seen.add(uniqKey);
    candidates.push({
      rawUrl: String(rawUrl).trim(),
      resolvedUrl,
      endpointUrl,
      method: normalizedMethod,
      matcher,
      confidence: confidence || 'medium',
      snippet: extractSnippetAt(source, index),
      dynamic: String(rawUrl).includes('${') || resolvedUrl == null,
    });
  }

  const fetchRegex = /fetch\s*\(\s*(['"`])([^'"`\n\r]{2,500})\1(?:\s*,\s*({[\s\S]{0,1000}?}))?\s*\)/gi;
  let match;
  while ((match = fetchRegex.exec(source)) !== null) {
    pushCandidate(match[2], readMethodFromOptionsBlock(match[3] || ''), 'fetch()', 'high', match.index, true);
  }

  const axiosMethodRegex = /axios\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`\n\r]{2,500})\2/gi;
  while ((match = axiosMethodRegex.exec(source)) !== null) {
    pushCandidate(match[3], match[1], 'axios.method()', 'high', match.index, true);
  }

  const axiosConfigRegex = /axios\s*\(\s*({[\s\S]{0,1200}?})\s*\)/gi;
  while ((match = axiosConfigRegex.exec(source)) !== null) {
    const cfg = match[1];
    const cfgUrl = readUrlFromAxiosConfig(cfg);
    if (cfgUrl) {
      pushCandidate(cfgUrl, readMethodFromAxiosConfig(cfg), 'axios(config)', 'high', match.index, true);
    }
  }

  const xhrRegex = /\.open\s*\(\s*(['"`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*(['"`])([^'"`\n\r]{2,500})\3/gi;
  while ((match = xhrRegex.exec(source)) !== null) {
    pushCandidate(match[4], match[2], 'xhr.open()', 'high', match.index, true);
  }

  const genericUrlRegex = /(['"`])((?:https?:\/\/|\/)[^'"`\s]{3,500})\1/g;
  while ((match = genericUrlRegex.exec(source)) !== null) {
    pushCandidate(match[2], 'GET', 'quoted-url', 'medium', match.index, false);
  }

  return candidates;
}

function trimEndpointStateToLimit(state) {
  const entries = Object.values(state.endpointsByKey);
  if (entries.length <= ACTIVE_INTERCEPTION_MAX_ENDPOINTS_PER_TAB) return;
  entries.sort((a, b) => new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime());
  const dropCount = entries.length - ACTIVE_INTERCEPTION_MAX_ENDPOINTS_PER_TAB;
  for (let i = 0; i < dropCount; i++) {
    delete state.endpointsByKey[entries[i].key];
  }
}

function upsertActiveEndpoint(state, candidate, meta) {
  if (!state || !candidate) return;
  const endpointUrl = candidate.endpointUrl || candidate.rawUrl;
  if (!endpointUrl) return;

  const method = normalizeMethod(candidate.method, 'GET');
  const key = `${method}||${normalizeEndpointKey(endpointUrl)}`;
  const nowIso = new Date().toISOString();
  const sourceScript = candidate.dynamic
    ? `[dynamic] ${meta.scriptUrl || meta.pageUrl || '(inline script)'}`
    : (meta.scriptUrl || meta.pageUrl || '(inline script)');
  const existing = state.endpointsByKey[key];

  if (!existing) {
    state.endpointsByKey[key] = {
      key,
      url: endpointUrl,
      rawUrl: candidate.rawUrl || endpointUrl,
      method,
      methodsSeen: [method],
      confidence: candidate.confidence || 'medium',
      matcher: candidate.matcher || 'unknown',
      matchers: [candidate.matcher || 'unknown'],
      firstSeen: nowIso,
      lastSeen: nowIso,
      occurrences: 1,
      dynamic: candidate.dynamic === true,
      snippet: candidate.snippet || '',
      sourceScripts: sourceScript ? [sourceScript] : [],
    };
    return;
  }

  existing.lastSeen = nowIso;
  existing.occurrences += 1;
  if (existing.dynamic && candidate.dynamic === false) existing.dynamic = false;
  if ((!existing.url || existing.dynamic) && !candidate.dynamic && candidate.resolvedUrl) {
    existing.url = candidate.resolvedUrl;
  }
  if (candidate.snippet && !existing.snippet) existing.snippet = candidate.snippet;
  if (candidate.confidence === 'high') existing.confidence = 'high';
  pushUniqueLimited(existing.methodsSeen, method, 8);
  pushUniqueLimited(existing.matchers, candidate.matcher || 'unknown', 8);
  pushUniqueLimited(existing.sourceScripts, sourceScript, ACTIVE_INTERCEPTION_MAX_SOURCES_PER_ENDPOINT);
}

function processScriptSourceForEndpoints(tabId, sourceText, meta) {
  const state = getActiveInterceptionState(tabId);
  if (!state || !sourceText) return 0;
  const candidates = buildEndpointCandidatesFromScript(sourceText, meta);
  if (!candidates.length) {
    state.scriptsScanned += 1;
    state.updatedAt = new Date().toISOString();
    return 0;
  }

  candidates.forEach(candidate => {
    upsertActiveEndpoint(state, candidate, meta);
    state.endpointHits += 1;
  });
  trimEndpointStateToLimit(state);
  state.scriptsScanned += 1;
  state.updatedAt = new Date().toISOString();
  return candidates.length;
}

async function fetchScriptSourceForScan(scriptUrl) {
  if (!scriptUrl || typeof scriptUrl !== 'string') return null;
  const attempts = ['include', 'omit'];
  for (const credentials of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(scriptUrl, {
        method: 'GET',
        credentials,
        cache: 'force-cache',
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const text = await response.text();
      if (!text) continue;
      return text.slice(0, ACTIVE_INTERCEPTION_MAX_SCRIPT_SOURCE_CHARS);
    } catch (_) {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function getActiveInterceptionDataForTab(tabId) {
  const state = getActiveInterceptionState(tabId);
  if (!state) {
    return {
      entries: [],
      stats: { scriptsScanned: 0, endpointCount: 0, endpointHits: 0, updatedAt: null },
    };
  }
  const entries = Object.values(state.endpointsByKey)
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .map(item => ({
      key: item.key,
      url: item.url,
      rawUrl: item.rawUrl,
      method: item.method,
      methodsSeen: Array.isArray(item.methodsSeen) ? item.methodsSeen.slice(0, 8) : [item.method],
      confidence: item.confidence || 'medium',
      matcher: item.matcher || 'unknown',
      matchers: Array.isArray(item.matchers) ? item.matchers.slice(0, 8) : [item.matcher || 'unknown'],
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen,
      occurrences: item.occurrences || 1,
      dynamic: item.dynamic === true,
      snippet: item.snippet || '',
      sourceScripts: Array.isArray(item.sourceScripts) ? item.sourceScripts.slice(0, ACTIVE_INTERCEPTION_MAX_SOURCES_PER_ENDPOINT) : [],
    }));
  return {
    entries,
    stats: {
      scriptsScanned: state.scriptsScanned || 0,
      endpointCount: entries.length,
      endpointHits: state.endpointHits || 0,
      updatedAt: state.updatedAt || null,
    },
  };
}

function handleActiveInterceptionScanMessage(data, sender) {
  const tabId = Number(data && data.tabId != null ? data.tabId : sender && sender.tab ? sender.tab.id : -1);
  if (!Number.isFinite(tabId) || tabId < 0) return;

  const state = getActiveInterceptionState(tabId);
  if (!state) return;

  const sourceType = data && data.sourceType === 'inline' ? 'inline' : 'external';
  const scriptUrl = data && data.scriptUrl ? String(data.scriptUrl) : '';
  const pageUrl = data && data.pageUrl ? String(data.pageUrl) : '';
  const scriptKeyFromPayload = data && data.scriptKey ? String(data.scriptKey) : '';
  const scriptKey = scriptKeyFromPayload || `${sourceType}:${scriptUrl || pageUrl}`;
  if (!scriptKey) return;
  if (state.scannedScriptKeys[scriptKey]) return;
  state.scannedScriptKeys[scriptKey] = Date.now();

  const meta = { sourceType, scriptUrl, pageUrl, scriptKey };
  const inlineSource = data && typeof data.sourceText === 'string' ? data.sourceText : null;

  if (inlineSource != null) {
    processScriptSourceForEndpoints(tabId, inlineSource, meta);
    return;
  }

  if (!scriptUrl) return;
  fetchScriptSourceForScan(scriptUrl)
    .then((sourceText) => {
      if (!sourceText) return;
      processScriptSourceForEndpoints(tabId, sourceText, meta);
    })
    .catch(() => {});
}

function buildRequestsForPopup() {
  const encoder = new TextEncoder();
  const sizeOf = (arr) => {
    try { return encoder.encode(JSON.stringify({ requests: arr })).length; } catch (_) { return Number.MAX_SAFE_INTEGER; }
  };

  let payload = capturedRequests.map(r => sanitizeRequestForMemory(r)).filter(Boolean);
  if (hideStaticResourcesEnabled) {
    payload = payload.filter(r => !r.isStaticResource);
  }
  if (sizeOf(payload) <= MAX_POPUP_MESSAGE_BYTES) return payload;

  const prioritized = payload.map((r, idx) => {
    const u = (r.url || '').toLowerCase();
    const keepResponse =
      idx < 20 ||
      u.includes('hometimeline') ||
      u.includes('home_timeline_urt') ||
      u.includes('threaded_conversation_with_injections_v2');
    return keepResponse ? r : { ...r, responseBody: null };
  });
  if (sizeOf(prioritized) <= MAX_POPUP_MESSAGE_BYTES) return prioritized;

  payload = payload.map(r => ({ ...r, responseBody: null }));
  if (sizeOf(payload) <= MAX_POPUP_MESSAGE_BYTES) return payload;

  payload = payload.map(r => ({ ...r, body: null, headers: Array.isArray(r.headers) ? r.headers.slice(0, 30) : [] }));
  if (sizeOf(payload) <= MAX_POPUP_MESSAGE_BYTES) return payload;

  let end = payload.length;
  while (end > 1) {
    end = Math.floor(end * 0.75);
    const sliced = payload.slice(0, end);
    if (sizeOf(sliced) <= MAX_POPUP_MESSAGE_BYTES) return sliced;
  }
  return payload.length ? [payload[0]] : [];
}

function countRequestsForCurrentSite() {
  if (!currentTabHostname) return 0;
  return capturedRequests.filter(req => {
    if (hideStaticResourcesEnabled && isRequestStaticResource(req)) return false;
    if (req.initiator) {
      try { if (new URL(req.initiator).hostname === currentTabHostname) return true; } catch {}
    }
    if (req.url) {
      try { if (new URL(req.url).hostname === currentTabHostname) return true; } catch {}
    }
    return false;
  }).length;
}

function updateBadge() {
  const set = (count) => {
    chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#8EA4D8' });
  };
  if (currentTabHostname != null || currentTabId != null) {
    set(countRequestsForCurrentSite());
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      currentTabId = tabs[0].id;
      try { currentTabHostname = new URL(tabs[0].url).hostname; } catch { currentTabHostname = ''; }
    } else { currentTabHostname = ''; currentTabId = null; }
    set(countRequestsForCurrentSite());
  });
}

function debouncedSave() {
  // History is kept in memory only; use Export to file in popup to save. No browser storage.
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearActiveInterceptionState(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    clearActiveInterceptionState(tabId);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  currentTabId = activeInfo.tabId;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) {
      currentTabHostname = '';
      updateBadge();
      return;
    }
    try { currentTabHostname = new URL(tab.url).hostname; } catch { currentTabHostname = ''; }
    updateBadge();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== currentTabId) return;
  if (changeInfo.url) {
    try { currentTabHostname = new URL(changeInfo.url).hostname; } catch { currentTabHostname = ''; }
    updateBadge();
  }
});

function decodeRequestBody(requestBody) {
  if (!requestBody) return null;

  if (requestBody.raw && requestBody.raw.length > 0) {
    try {
      const decoder = new TextDecoder('utf-8');
      return requestBody.raw
        .filter(p => p.bytes)
        .map(p => decoder.decode(new Uint8Array(p.bytes)))
        .join('');
    } catch { return null; }
  }

  if (requestBody.formData) {
    const params = new URLSearchParams();
    for (const [key, values] of Object.entries(requestBody.formData)) {
      for (const value of values) {
        params.append(key, value);
      }
    }
    return params.toString();
  }

  return null;
}

const REQUEST_FILTER = { urls: ["<all_urls>"] };
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
    const isStaticResource = isStaticOrFrameworkResource(details.url);

    pendingRequests[details.requestId] = {
      url: details.url,
      method: details.method,
      tabId: details.tabId,
      resourceType: details.type || 'other',
      timestamp: new Date(details.timeStamp).toISOString(),
      headers: [],
      body: normalizePayloadText(decodeRequestBody(details.requestBody), MAX_CAPTURED_BODY_CHARS),
      responseBody: null,
      initiator: details.initiator || '',
      isStaticResource,
    };
  },
  REQUEST_FILTER,
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const pending = pendingRequests[details.requestId];
    if (pending) {
      pending.headers = details.requestHeaders || [];
    }
  },
  REQUEST_FILTER,
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const pending = pendingRequests[details.requestId];
    if (!pending) return;

    const resBody = findBufferedData(responseBuffer, pending.url, pending.method);
    if (resBody !== null) {
      pending.responseBody = resBody;
    }

    const needsBody = ['POST', 'PUT', 'PATCH'].includes(pending.method);

    if (!needsBody || pending.body !== null) {
      finalizeRequest(details.requestId);
    } else {
      const bufBody = findBufferedData(bodyBuffer, pending.url, pending.method);
      if (bufBody !== null) {
        pending.body = bufBody;
        finalizeRequest(details.requestId);
      } else {
        setTimeout(() => {
          const p = pendingRequests[details.requestId];
          if (p && p.body === null) {
            const late = findBufferedData(bodyBuffer, p.url, p.method);
            if (late !== null) p.body = late;
          }
          finalizeRequest(details.requestId);
        }, FALLBACK_WAIT_MS);
      }
    }
  },
  REQUEST_FILTER
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => { delete pendingRequests[details.requestId]; },
  REQUEST_FILTER
);

function finalizeRequest(requestId) {
  const pending = pendingRequests[requestId];
  if (!pending) return;
  delete pendingRequests[requestId];

  const isDuplicate = capturedRequests.some(r =>
    r.url === pending.url &&
    r.method === pending.method &&
    r.body === pending.body &&
    Math.abs(new Date(r.timestamp).getTime() - new Date(pending.timestamp).getTime()) < 1000
  );
  if (isDuplicate) return;

  const displayType = pending.resourceType === 'main_frame' ? 'document' : 'fetch';
  capturedRequests.unshift({
    id: Date.now() + Math.random(),
    url: pending.url,
    method: pending.method,
    headers: pending.headers,
    body: normalizePayloadText(pending.body, MAX_CAPTURED_BODY_CHARS),
    responseBody: normalizePayloadText(pending.responseBody, MAX_CAPTURED_RESPONSE_CHARS),
    timestamp: pending.timestamp,
    type: displayType,
    tabId: pending.tabId,
    initiator: pending.initiator,
    isStaticResource: pending.isStaticResource === true,
  });

  if (capturedRequests.length > MAX_REQUESTS) {
    capturedRequests = capturedRequests.slice(0, MAX_REQUESTS);
  }

  updateBadge();
  debouncedSave();
}

function findBufferedData(buffer, url, method) {
  const now = Date.now();
  for (let i = buffer.length - 1; i >= 0; i--) {
    const b = buffer[i];
    if (now - b.ts > 15000) continue;
    if (b.method === method && b.url === url) {
      buffer.splice(i, 1);
      return b.data;
    }
  }
  return null;
}

function tryFallbackFetch(url, sendResponse) {
  fetch(url, { method: 'GET', credentials: 'omit', mode: 'cors' })
    .then(res => res.ok ? res.blob() : Promise.reject(new Error('not ok')))
    .then(blob => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    }))
    .then(dataUrl => sendResponse({ dataUrl }))
    .catch(() => sendResponse({ dataUrl: null }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scanScriptForEndpoints') {
    handleActiveInterceptionScanMessage(message.data || {}, sender);
    sendResponse({ success: true, queued: true });

  } else if (message.action === 'getActiveInterceptionData') {
    const tabId = Number(message.tabId != null ? message.tabId : (sender && sender.tab ? sender.tab.id : -1));
    sendResponse(getActiveInterceptionDataForTab(tabId));

  } else if (message.action === 'captureBody') {
    const data = message.data;
    if (data && data.url) {
      const upperMethod = (data.method || '').toUpperCase();
      const matchId = Object.keys(pendingRequests).reverse().find(id => {
        const r = pendingRequests[id];
        return r.body === null && r.method === upperMethod && r.url === data.url;
      });
      if (matchId) {
        pendingRequests[matchId].body = normalizePayloadText(data.body, MAX_CAPTURED_BODY_CHARS);
      } else {
        bodyBuffer.push({ url: data.url, method: upperMethod, data: normalizePayloadText(data.body, MAX_CAPTURED_BODY_CHARS), ts: Date.now() });
        if (bodyBuffer.length > MAX_BODY_BUFFER) bodyBuffer.shift();
      }
    }
    sendResponse({ success: true });

  } else if (message.action === 'captureResponse') {
    const data = message.data;
    if (data && data.url) {
      const upperMethod = (data.method || '').toUpperCase();
      
      const matchId = Object.keys(pendingRequests).reverse().find(id => {
        const r = pendingRequests[id];
        return r.responseBody === null && r.method === upperMethod && r.url === data.url;
      });

      if (matchId) {
        pendingRequests[matchId].responseBody = normalizePayloadText(data.responseBody, MAX_CAPTURED_RESPONSE_CHARS);
      } else {
        const recentRequest = capturedRequests.find(r => 
          r.responseBody === null && r.method === upperMethod && r.url === data.url &&
          (Date.now() - new Date(r.timestamp).getTime()) < 5000
        );
        if (recentRequest) {
          recentRequest.responseBody = normalizePayloadText(data.responseBody, MAX_CAPTURED_RESPONSE_CHARS);
          debouncedSave();
        } else {
          responseBuffer.push({ url: data.url, method: upperMethod, data: normalizePayloadText(data.responseBody, MAX_CAPTURED_RESPONSE_CHARS), ts: Date.now() });
          if (responseBuffer.length > MAX_BODY_BUFFER) responseBuffer.shift();
        }
      }
    }
    sendResponse({ success: true });

  } else if (message.action === 'captureDocumentContent') {
    const data = message.data;
    if (data && data.url && data.responseBody != null) {
      const normalized = normalizePayloadText(data.responseBody, MAX_CAPTURED_RESPONSE_CHARS);
      const docRequest = capturedRequests.find(r =>
        r.type === 'document' && r.url === data.url && r.responseBody == null
      );
      if (docRequest) {
        docRequest.responseBody = normalized;
        debouncedSave();
      }
    }
    sendResponse({ success: true });

  } else if (message.action === 'getRequests') {
    sendResponse({ requests: buildRequestsForPopup() });

  } else if (message.action === 'getHideStaticResources') {
    sendResponse({ enabled: hideStaticResourcesEnabled });

  } else if (message.action === 'setHideStaticResources') {
    hideStaticResourcesEnabled = message.enabled !== false;
    chrome.storage.local.set({ [STATIC_FILTER_STORAGE_KEY]: hideStaticResourcesEnabled });
    updateBadge();
    sendResponse({ success: true, enabled: hideStaticResourcesEnabled });

  } else if (message.action === 'clearRequests') {
    capturedRequests = [];
    Object.keys(activeInterceptionByTab).forEach((tabKey) => {
      delete activeInterceptionByTab[tabKey];
    });
    updateBadge();
    sendResponse({ success: true });

  } else if (message.action === 'getRequestsForExport') {
    sendResponse({ requests: capturedRequests.map(r => sanitizeRequestForMemory(r)).filter(Boolean) });

  } else if (message.action === 'importHistory') {
    const list = message.requests;
    if (Array.isArray(list) && list.length > 0) {
      capturedRequests = list
        .map(r => sanitizeRequestForMemory(r))
        .filter(Boolean)
        .slice(0, MAX_REQUESTS);
    } else {
      capturedRequests = [];
    }
    updateBadge();
    sendResponse({ success: true, count: capturedRequests.length });

  } else if (message.action === 'resolveInstagramProfilePic' && message.url) {
    chrome.tabs.query({ url: '*://www.instagram.com/*' }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'fetchImageInPageContext', url: message.url }, (r) => {
          if (chrome.runtime.lastError || !r) {
            tryFallbackFetch(message.url, sendResponse);
          } else {
            sendResponse(r.dataUrl != null ? { dataUrl: r.dataUrl } : { dataUrl: null });
          }
        });
      } else {
        tryFallbackFetch(message.url, sendResponse);
      }
    });
    return true;
  }

  return true;
});

chrome.storage.local.get([STATIC_FILTER_STORAGE_KEY], (result) => {
  const stored = result ? result[STATIC_FILTER_STORAGE_KEY] : undefined;
  if (typeof stored === 'boolean') {
    hideStaticResourcesEnabled = stored;
  } else {
    hideStaticResourcesEnabled = true;
    chrome.storage.local.set({ [STATIC_FILTER_STORAGE_KEY]: true });
  }
  updateBadge();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[STATIC_FILTER_STORAGE_KEY];
  if (!change) return;
  hideStaticResourcesEnabled = change.newValue !== false;
  updateBadge();
});

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(pendingRequests)) {
    if (now - new Date(pendingRequests[id].timestamp).getTime() > 30000) {
      delete pendingRequests[id];
    }
  }
  while (bodyBuffer.length > 0 && Date.now() - bodyBuffer[0].ts > 30000) bodyBuffer.shift();
  while (responseBuffer.length > 0 && Date.now() - responseBuffer[0].ts > 30000) responseBuffer.shift();
}, 30000);

updateBadge();
