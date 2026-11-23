// ---------- Setup ----------
const $ = id => document.getElementById(id);
const footerHome = $('footer').parentNode;
const v = $('v'), seek = $('seek'), vol = $('vol');
let joined = false, playingId = null, serverPaused = false, seeking = false, actionAt = 0;
let logRev = '', chatRev = '', logList = [], chatList = [], chatDrawn = false;
let historyRev = '', historyList = [], lastHistory = '';
let lastQueue = '', lastUsers = '', lastColorsKey = '';

const getCookie = k => { try { return decodeURIComponent((document.cookie.match('(?:^|; )' + k + '=([^;]*)') || [])[1] || ''); } catch { return ''; } };
const post = (url, data) => { actionAt = Date.now(); return fetch(url, { method: 'POST', body: JSON.stringify(data || {}) }).catch(() => null); };
const icon = name => `<svg><use href="#i-${name}"/></svg>`;

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
const avatar = name => `<span class="avatar" style="background:${avatarBg(name)}">${esc(face(name))}</span>`;

let myPick = {};
try { myPick = JSON.parse(localStorage.getItem('myPick') || '{}') || {}; } catch {}
const savePick = () => { try { localStorage.setItem('myPick', JSON.stringify(myPick)); } catch {} };
