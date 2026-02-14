
function isDiscordDomain(host) {
  if (!host) return false;
  return host === 'discord.com' || host === 'www.discord.com' || host.endsWith('.discord.com');
}

const DISCORD_CDN_AVATAR = 'https://cdn.discordapp.com/avatars';

function discordAvatarUrl(userId, avatarHash, animated) {
  if (!userId || !avatarHash) return '';
  const ext = animated && String(avatarHash).startsWith('a_') ? 'gif' : 'png';
  return `${DISCORD_CDN_AVATAR}/${userId}/${avatarHash}.${ext}`;
}

function normalizeDiscordUser(obj) {
  if (!obj || !obj.id) return null;
  const id = String(obj.id);
  const avatar = obj.avatar || '';
  return {
    id,
    username: obj.username || '',
    global_name: obj.global_name || '',
    discriminator: obj.discriminator || '0',
    avatar,
    avatar_url: discordAvatarUrl(id, avatar, true),
    bot: !!obj.bot,
    clan: obj.clan || null,
    primary_guild: obj.primary_guild || null,
  };
}

function parseDiscordMessagesResponse(responseBody, requestUrl) {
  let channelId = '';
  try {
    const m = (requestUrl || '').match(/\/channels\/\d+\/(\d+)\/messages/);
    if (m) channelId = m[1];
  } catch (_) {}
  const messages = [];
  try {
    const raw = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : [];
    for (const msg of list) {
      if (!msg || msg.id == null) continue;
      const author = normalizeDiscordUser(msg.author);
      const att = (msg.attachments || []).map(a => ({
        id: a.id,
        filename: a.filename || '',
        size: a.size,
        url: a.url || '',
        proxy_url: a.proxy_url || a.url || '',
        width: a.width,
        height: a.height,
        content_type: a.content_type || '',
      }));
      const emb = (msg.embeds || []).map(e => ({
        type: e.type || 'rich',
        url: e.url || '',
        title: e.title || '',
        description: e.description || '',
        color: e.color,
        thumbnail: e.thumbnail ? { url: e.thumbnail.url || '', proxy_url: e.thumbnail.proxy_url || '' } : null,
      }));
      let refMsg = null;
      if (msg.referenced_message && msg.referenced_message.id) {
        const r = msg.referenced_message;
        refMsg = {
          id: r.id,
          content: (r.content || '').slice(0, 200),
          author: normalizeDiscordUser(r.author),
          timestamp: r.timestamp,
        };
      }
      const reactions = (msg.reactions || []).map(re => ({
        emoji: (re.emoji && (re.emoji.name || re.emoji.id)) ? (re.emoji.name || re.emoji.id) : '?',
        count: re.count != null ? re.count : 0,
      }));
      messages.push({
        id: String(msg.id),
        channel_id: msg.channel_id ? String(msg.channel_id) : channelId,
        type: msg.type,
        content: msg.content || '',
        timestamp: msg.timestamp || '',
        edited_timestamp: msg.edited_timestamp || null,
        author,
        mentions: (msg.mentions || []).map(normalizeDiscordUser).filter(Boolean),
        attachments: att,
        embeds: emb,
        referenced_message: refMsg,
        reactions,
        pinned: !!msg.pinned,
      });
    }
  } catch (_) {}
  return { channelId, messages };
}

function aggregateDiscordDataFromRequests(requests) {
  const usersById = new Map();
  const messagesById = new Map();
  for (const req of requests) {
    if (!req.responseBody) continue;
    const { messages } = parseDiscordMessagesResponse(req.responseBody, req.url);
    for (const msg of messages) {
      if (msg.author) {
        usersById.set(msg.author.id, msg.author);
        if (msg.referenced_message && msg.referenced_message.author) {
          usersById.set(msg.referenced_message.author.id, msg.referenced_message.author);
        }
        for (const u of msg.mentions) {
          if (u) usersById.set(u.id, u);
        }
      }
      messagesById.set(msg.id, msg);
    }
  }
  const allUsers = Array.from(usersById.values());
  const allMessages = Array.from(messagesById.values());
  const users = allUsers.filter(u => (u.global_name || u.username));
  const messages = allMessages
    .filter(msg => {
      const hasContent = !!(msg.content && msg.content.trim());
      const hasAttachments = msg.attachments && msg.attachments.length > 0;
      const hasEmbeds = msg.embeds && msg.embeds.length > 0;
      return hasContent || hasAttachments || hasEmbeds;
    })
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return { users, messages };
}

function buildDiscordUserListHtml(users) {
  const listHtml = users.map(u => {
    const name = u.global_name || u.username || 'Unknown';
    const handle = u.username ? `@${u.username}` : '';
    const tag = (u.clan && u.clan.tag) ? ` [${u.clan.tag}]` : (u.primary_guild && u.primary_guild.tag) ? ` [${u.primary_guild.tag}]` : '';
    const avatarHtml = u.avatar_url
      ? `<img class="discord-user-avatar" src="${escapeHtml(u.avatar_url)}" alt="" loading="lazy">`
      : `<div class="discord-user-avatar-placeholder">?</div>`;
    return `<li class="discord-user-item">
      ${avatarHtml}
      <div class="discord-user-info">
        <div class="discord-user-name">${escapeHtml(name)}${tag}</div>
        <div class="discord-user-meta">${escapeHtml(handle)} · ID: ${escapeHtml(u.id)}${u.bot ? ' · Bot' : ''}</div>
      </div>
    </li>`;
  }).join('');
  return `<ul class="discord-user-list">${listHtml}</ul>`;
}

function buildDiscordMessageListHtml(messages) {
  const listHtml = messages.map(msg => {
    const author = msg.author;
    const authorName = author ? (author.global_name || author.username || 'Unknown') : 'Unknown';
    const avatarHtml = author && author.avatar_url
      ? `<img class="discord-user-avatar discord-message-avatar" src="${escapeHtml(author.avatar_url)}" alt="" loading="lazy">`
      : `<div class="discord-user-avatar-placeholder discord-message-avatar">?</div>`;
    const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
    const contentHtml = msg.content ? `<div class="discord-message-content">${escapeHtml(msg.content)}</div>` : '';
    let replyHtml = '';
    if (msg.referenced_message) {
      const r = msg.referenced_message;
      const rAuthor = r.author ? (r.author.global_name || r.author.username || 'Unknown') : 'Unknown';
      replyHtml = `<div class="discord-message-reply">
        <span class="discord-message-reply-author">${escapeHtml(rAuthor)}</span>: ${escapeHtml((r.content || '').slice(0, 150))}${(r.content || '').length > 150 ? '…' : ''}
      </div>`;
    }
    let attachmentsHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
      attachmentsHtml = `<div class="discord-attachments">${msg.attachments.map(a => {
        const url = a.url || a.proxy_url || '';
        const isImage = (a.content_type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename || '');
        const thumb = isImage && url
          ? `<img class="discord-attachment-thumb" src="${escapeHtml(url)}" alt="" loading="lazy">`
          : '';
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="discord-attachment" title="${escapeHtml(a.filename || '')}">
          ${thumb}
          <span class="discord-attachment-link">${escapeHtml(a.filename || 'Download')}</span>
        </a>`;
      }).join('')}</div>`;
    }
    let embedsHtml = '';
    if (msg.embeds && msg.embeds.length > 0) {
      embedsHtml = `<div class="discord-embeds">${msg.embeds.map(e => {
        const titlePart = e.title
          ? (e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener" class="discord-embed-title">${escapeHtml(e.title)}</a>` : `<span class="discord-embed-title">${escapeHtml(e.title)}</span>`)
          : '';
        const descPart = e.description ? `<div class="discord-embed-desc">${escapeHtml(e.description)}</div>` : '';
        const thumbPart = e.thumbnail && (e.thumbnail.url || e.thumbnail.proxy_url)
          ? `<img class="discord-embed-thumb" src="${escapeHtml(e.thumbnail.url || e.thumbnail.proxy_url)}" alt="" loading="lazy">`
          : '';
        return `<div class="discord-embed">${titlePart}${descPart}${thumbPart}</div>`;
      }).join('')}</div>`;
    }
    let reactionsHtml = '';
    if (msg.reactions && msg.reactions.length > 0) {
      reactionsHtml = `<div class="discord-reactions">${msg.reactions.map(r =>
        `<span class="discord-reaction">${escapeHtml(String(r.emoji))} × ${r.count}</span>`
      ).join('')}</div>`;
    }
    return `<li class="discord-message-item">
      <div class="discord-message-avatar-wrap">${avatarHtml}</div>
      <div class="discord-message-body">
        <div class="discord-message-header">
          <span class="discord-message-author">${escapeHtml(authorName)}</span>
          <span class="discord-message-time">${escapeHtml(timeStr)}</span>
          ${msg.channel_id ? `<span class="discord-message-channel">Channel: ${escapeHtml(msg.channel_id)}</span>` : ''}
        </div>
        ${contentHtml}
        ${replyHtml}
        ${attachmentsHtml}
        ${embedsHtml}
        ${reactionsHtml}
      </div>
    </li>`;
  }).join('');
  return `<ul class="discord-message-list">${listHtml}</ul>`;
}

function buildDiscordDropdownSection(title, contentHtml, openByDefault = true) {
  const openClass = openByDefault ? ' open' : '';
  return `<div class="discord-panel-dropdown${openClass}">
    <div class="discord-panel-dropdown-header">${escapeHtml(title)}<span class="discord-panel-dropdown-chevron">▼</span></div>
    <div class="discord-panel-dropdown-content">${contentHtml}</div>
  </div>`;
}

function getDiscordExportCss() {
  return `
:root {
  --blue: #8EA4D8;
  --link-color: #B8C8EC;
  --bg: #FAFBFD;
  --card: #FFFFFF;
  --card-alt: #F7F8FC;
  --border: #E8ECF2;
  --text: #2D3748;
  --text-secondary: #718096;
  --text-muted: #A0AEC0;
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
  --radius: 10px;
  --radius-sm: 6px;
}
[data-theme="dark"] {
  --blue: #9BB0E0;
  --link-color: #A8BDED;
  --bg: #14172A;
  --card: #1E2240;
  --card-alt: #252A48;
  --border: #2E3458;
  --text: #E2E8F0;
  --text-secondary: #A0AEC0;
  --text-muted: #64708A;
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.2);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
a { color: var(--link-color); }
html { min-height: 100%; }
body {
  min-height: 100%;
  background: var(--bg);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: var(--text);
  padding: 18px;
}
.discord-panel { padding: 4px 0; }
.discord-panel-dropdown {
  margin-bottom: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}
.discord-panel-dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  background: var(--card-alt);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}
.discord-panel-dropdown-header:hover { background: rgba(88, 101, 242, 0.1); }
.discord-panel-dropdown-chevron { font-size: 9px; margin-left: 8px; }
.discord-panel-dropdown.open .discord-panel-dropdown-chevron { transform: rotate(180deg); }
.discord-panel-dropdown-content { display: none; }
.discord-panel-dropdown.open .discord-panel-dropdown-content { display: block; }
.discord-empty-section {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
.discord-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}
.discord-user-list, .discord-message-list { list-style: none; margin: 0; padding: 0; }
.discord-user-item, .discord-message-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.4;
}
.discord-user-item:last-child, .discord-message-item:last-child { border-bottom: none; }
.discord-user-item:hover, .discord-message-item:hover { background: rgba(88, 101, 242, 0.08); }
.discord-user-item { display: flex; align-items: center; gap: 10px; }
.discord-user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.discord-user-avatar-placeholder {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--text-muted);
}
.discord-user-info { flex: 1; min-width: 0; }
.discord-user-name { font-weight: 600; color: var(--text); }
.discord-user-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.discord-message-item { display: flex; align-items: flex-start; gap: 10px; }
.discord-message-avatar-wrap { flex-shrink: 0; }
.discord-message-avatar { width: 32px; height: 32px; }
.discord-message-body { flex: 1; min-width: 0; }
.discord-message-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.discord-message-author { font-weight: 600; color: var(--text); }
.discord-message-time { font-size: 10px; color: var(--text-muted); }
.discord-message-channel { font-size: 10px; color: var(--text-muted); }
.discord-message-content { color: var(--text-secondary); word-break: break-word; white-space: pre-wrap; }
.discord-message-reply {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--card-alt);
  border-left: 3px solid #5865F2;
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.discord-message-reply-author { font-weight: 600; color: var(--text); }
.discord-attachments { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
.discord-attachment {
  display: block;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--card-alt);
  max-width: 200px;
}
.discord-attachment-thumb {
  display: block;
  max-width: 200px;
  max-height: 120px;
  object-fit: cover;
  width: 100%;
}
.discord-attachment-link {
  display: block;
  padding: 4px 8px;
  font-size: 10px;
  color: var(--link-color);
  text-decoration: none;
  word-break: break-all;
}
.discord-attachment-link:hover { text-decoration: underline; }
.discord-embeds { margin-top: 8px; }
.discord-embed {
  margin-top: 6px;
  padding: 8px 10px;
  border-left: 4px solid #5865F2;
  border-radius: 4px;
  background: var(--card-alt);
  font-size: 11px;
}
.discord-embed-title { font-weight: 600; color: var(--text); margin-bottom: 4px; }
.discord-embed-title a { color: var(--link-color); text-decoration: none; }
.discord-embed-title a:hover { text-decoration: underline; }
.discord-embed-desc { color: var(--text-secondary); line-height: 1.4; margin-bottom: 6px; }
.discord-embed-thumb { max-width: 80px; max-height: 80px; border-radius: 4px; margin-top: 4px; display: block; }
.discord-reactions { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
.discord-reaction {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--card-alt);
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.discord-export-search-wrap {
  margin-bottom: 12px;
  flex-shrink: 0;
}
.discord-export-search {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--text);
  outline: none;
}
.discord-export-search::placeholder { color: var(--text-muted); }
.discord-export-search:focus { border-color: var(--link-color); }
.discord-search-hidden { display: none !important; }
`;
}

function getDiscordExportScript() {
  return (
    '(function(){' +
    'document.querySelectorAll(".discord-panel-dropdown-header").forEach(function(h){' +
    'h.addEventListener("click",function(){ this.closest(".discord-panel-dropdown").classList.toggle("open"); });' +
    '});' +
    'var searchEl=document.getElementById("discord-export-search");' +
    'if(searchEl){' +
    'function wildcardToRegex(s){' +
    'var r=s.replace(/[\\\\^$+?.()|[\\]{}]/g,"\\\\$&").replace(/\\*/g,".*").replace(/\\?/g,".");' +
    'return new RegExp(r,"i");' +
    '}' +
    'function filterItems(){' +
    'var q=(searchEl.value||"").trim();' +
    'var re=q?wildcardToRegex(q):null;' +
    'document.querySelectorAll(".discord-user-item,.discord-message-item").forEach(function(el){' +
    'var text=(el.textContent||"");' +
    'el.classList.toggle("discord-search-hidden",!!re&&!re.test(text));' +
    '});' +
    '}' +
    'searchEl.addEventListener("input",filterItems);' +
    'searchEl.addEventListener("keyup",filterItems);' +
    '}' +
    '})();'
  );
}

function downloadDiscordAsHtml() {
  const container = document.getElementById('requestsContainer');
  if (!container) return;
  const panel = container.querySelector('.discord-panel');
  if (!panel) return;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const clone = panel.cloneNode(true);
  const css = getDiscordExportCss();
  const script = getDiscordExportScript();
  const searchHtml = '<div class="discord-export-search-wrap">' +
    '<input type="text" id="discord-export-search" class="discord-export-search" placeholder="Search (use * for any characters, ? for one character)" autocomplete="off">' +
    '</div>';
  const html = '<!DOCTYPE html><html lang="en" data-theme="' + escapeHtml(theme) + '">' +
    '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Discord export – APILEECH</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<style>' + css + '</style></head>' +
    '<body>' + searchHtml + '<div class="discord-panel">' + clone.innerHTML + '</div>' +
    '<script>' + script + '<' + '/script></body></html>';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'discord-export-' + new Date().toISOString().slice(0, 19).replace(/T/g, '-').replace(/:/g, '-') + '.html';
  a.click();
  URL.revokeObjectURL(url);
}

function renderDiscordTab(requests) {
  const container = document.getElementById('requestsContainer');

  const discordRequests = requests.filter(req => {
    if (!activeTabDomain || !isDiscordDomain(activeTabDomain)) return false;
    if (req.initiator) {
      try { if (isDiscordDomain(new URL(req.initiator).hostname)) return true; } catch {}
    }
    try {
      const u = new URL(req.url);
      if (u.hostname === 'discord.com' && (u.pathname.includes('/api/') || u.pathname.includes('/channels/'))) return true;
    } catch {}
    return false;
  });

  const { users, messages } = aggregateDiscordDataFromRequests(discordRequests);
  const signature = users.length + ':' + messages.map(m => m.id).join(',');
  if (signature === lastDiscordDataSignature) return;
  lastDiscordDataSignature = signature;

  const onDiscord = isDiscordDomain(activeTabDomain);
  if (users.length === 0 && messages.length === 0) {
    container.innerHTML = `
      <div class="discord-panel">
        <div class="discord-empty">
          ${onDiscord
            ? 'No Discord data captured yet.<br>Open a channel and scroll to load messages (discord.com/api/.../messages).'
            : 'Open Discord (discord.com) in this tab, then open a channel to capture messages and users.'}
        </div>
      </div>`;
    return;
  }

  const emptySection = (msg) => `<div class="discord-empty-section">${escapeHtml(msg)}</div>`;
  let sectionsHtml =
    buildDiscordDropdownSection('Users', users.length ? buildDiscordUserListHtml(users) : emptySection('No users captured.')) +
    buildDiscordDropdownSection('Channel messages', messages.length ? buildDiscordMessageListHtml(messages) : emptySection('No messages captured.'));
  container.innerHTML = `<div class="discord-panel">${sectionsHtml}</div>`;

  container.querySelectorAll('.discord-panel-dropdown').forEach(el => {
    const header = el.querySelector('.discord-panel-dropdown-header');
    if (header) {
      header.addEventListener('click', () => {
        el.classList.toggle('open');
      });
    }
  });
}

