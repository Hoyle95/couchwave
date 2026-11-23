// ---------- Setup ----------
const $ = id => document.getElementById(id);
const footerHome = $('footer').parentNode;
const v = $('v'), seek = $('seek'), vol = $('vol');
let joined = false, playingId = null, serverPaused = false, seeking = false, actionAt = 0;
let logRev = '', chatRev = '', logList = [], chatList = [];
let historyRev = '', historyList = [], lastHistory = '';
let lastQueue = '', lastUsers = '', lastColorsKey = '';

const getCookie = k => { try { return decodeURIComponent((document.cookie.match('(?:^|; )' + k + '=([^;]*)') || [])[1] || ''); } catch { return ''; } };
const post = (url, data) => { actionAt = Date.now(); return fetch(url, { method: 'POST', body: JSON.stringify(data || {}) }).catch(() => null).finally(() => { actionAt = Date.now(); }); };
function stickToBottom(el) {
  let stuck = true, putAt = 0;
  const stick = () => { if (stuck) { el.scrollTop = el.scrollHeight; putAt = el.scrollTop; } };
  el.addEventListener('scroll', () => { stuck = (stuck && el.scrollTop >= putAt - 1) || el.scrollHeight - el.scrollTop - el.clientHeight < 40; });
  el.addEventListener('load', stick, true);
  new ResizeObserver(stick).observe(el);
  return stick;
}
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
const byChannel = song => (song.channel ? ` <span class="chan">by ${esc(song.channel)}</span>` : '');

// ---------- Notices ----------
const NOTICES_AT_ONCE = 3;
function notice(text) {
  const box = $('notices'), el = document.createElement('div'), words = document.createElement('span');
  el.className = 'notice';
  el.title = 'Click to close';
  words.textContent = text;
  el.innerHTML = icon('alert');
  el.appendChild(words);
  const close = () => { if (el.classList.contains('going')) return; el.classList.add('going'); setTimeout(() => el.remove(), 200); };
  el.onclick = close;
  setTimeout(close, Math.max(5000, text.length * 80));
  while (box.children.length >= NOTICES_AT_ONCE) box.firstElementChild.remove();
  box.appendChild(el);
}
const failText = async r => (r ? (await r.text().catch(() => '')) || 'Something went wrong. Try again in a moment' : "Couldn't reach the server, try again in a moment");

// ---------- Lists that keep what hasn't changed ----------
const drawnLists = new WeakMap();
function drawList(box, items) {
  const before = drawnLists.get(box) || new Map(), now = new Map(), nodes = [], tpl = document.createElement('template');
  for (const html of items) {
    let node = (before.get(html) || []).shift();
    if (!node) { tpl.innerHTML = html.trim(); node = tpl.content.firstElementChild; }
    if (!now.has(html)) now.set(html, []);
    now.get(html).push(node);
    nodes.push(node);
  }
  const keep = new Set(nodes);
  for (const child of [...box.childNodes]) if (!keep.has(child)) child.remove();
  let at = box.firstChild;
  for (const node of nodes) { if (node === at) at = at.nextSibling; else box.insertBefore(node, at); }
  drawnLists.set(box, now);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmt = t => {
  t = Math.floor(t || 0);
  const ss = String(t % 60).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${ss}` : `${Math.floor(t / 60)}:${ss}`;
};

// ---------- Colour helpers ----------
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = rgb => '#' + rgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
function parseHex(s) {
  s = String(s).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, c => c + c);
  return /^[0-9a-f]{6}$/i.test(s) ? '#' + s.toLowerCase() : null;
}
function hsvToRgb(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))); };
  return [f(5), f(3), f(1)].map(Math.round);
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = 60 * (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
}

// ---------- Names and profile pictures ----------
let colors = {}, myName = '';
const DJ_NAME = 'DJ';
const own = (list, name) => (Object.prototype.hasOwnProperty.call(list, name) ? list[name] : null);
function autoHue(name) {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h;
}
const picked = name => own(colors, name) || null;
const avatarBg = name => picked(name) || `hsl(${autoHue(name)} 65% 50%)`;
const nameColor = name => picked(name) || `hsl(${autoHue(name)} 70% var(--name-l))`;

const FACES = ('🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🦆 🦉 🦄 🐝 🦋 🐢 🐙 🦈 🐳 🐬 🦖 🐲 🦩 ' +
               '👽 🤖 👻 🎃 😎 🤠 🥳 🤓 🤡 💀 🌵 🍄 🌻 🍕 🍩 🍉 🍓 🥑 🍒 🔥 ⚡ 🌈 ⭐ 🌙 🎧 🎸 🎮 🚀 💎 👑').split(' ');
let faces = {};
function autoFace(name) { let h = 7; for (const c of String(name)) h = (h * 33 + c.codePointAt(0)) % 1000003; return FACES[h % FACES.length]; }
const face = name => own(faces, name) || autoFace(name);
const avatar = name => `<span class="avatar" data-who="${esc(name)}" style="background:${avatarBg(name)}">${esc(face(name))}</span>`;
const nameTag = (name, tag = 'span') => `<${tag} class="nm" data-who="${esc(name)}" style="color:${nameColor(name)}">${esc(name)}</${tag}>`;
function repaintPerson(name) {
  const bg = avatarBg(name), f = face(name), color = nameColor(name);
  for (const el of document.querySelectorAll(`[data-who="${CSS.escape(name)}"]`)) {
    if (el.classList.contains('avatar')) { el.style.background = bg; el.textContent = f; } else el.style.color = color;
  }
}

let myPick = {};
try { myPick = JSON.parse(localStorage.getItem('myPick') || '{}') || {}; } catch {}
const savePick = () => { try { localStorage.setItem('myPick', JSON.stringify(myPick)); } catch {} };
