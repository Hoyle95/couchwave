// ---------- Setup ----------
const $ = id => document.getElementById(id);
const footerHome = $('footer').parentNode;
const v = $('v'), seek = $('seek'), vol = $('vol');
let joined = false, playingId = null, serverPaused = false, seeking = false, actionAt = 0;
let logRev = '', chatRev = '', logList = [], chatList = [], chatDrawn = false;
let historyRev = '', historyList = [], lastHistory = '';
let lastQueue = '', lastUsers = '', lastColorsKey = '';

const getCookie = k => { try { return decodeURIComponent((document.cookie.match('(?:^|; )' + k + '=([^;]*)') || [])[1] || ''); } catch { return ''; } };
const setCookie = (k, val, age = 31536000) => { document.cookie = `${k}=${encodeURIComponent(val)}; max-age=${age}; path=/; SameSite=Lax`; };
const post = (url, data) => { actionAt = Date.now(); return fetch(url, { method: 'POST', body: JSON.stringify(data || {}) }).catch(() => null); };
const icon = name => `<svg><use href="#i-${name}"/></svg>`;

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
function autoHue(name) {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h;
}
const picked = name => (typeof colors[name] === 'string' ? colors[name] : null);
const avatarBg = name => picked(name) || `hsl(${autoHue(name)} 65% 50%)`;
const nameColor = name => picked(name) || `hsl(${autoHue(name)} 70% var(--name-l))`;

const FACES = ('🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🦆 🦉 🦄 🐝 🦋 🐢 🐙 🦈 🐳 🐬 🦖 🐲 🦩 ' +
               '👽 🤖 👻 🎃 😎 🤠 🥳 🤓 🤡 💀 🌵 🍄 🌻 🍕 🍩 🍉 🍓 🥑 🍒 🔥 ⚡ 🌈 ⭐ 🌙 🎧 🎸 🎮 🚀 💎 👑').split(' ');
let faces = {};
function autoFace(name) { let h = 7; for (const c of String(name)) h = (h * 33 + c.codePointAt(0)) % 1000003; return FACES[h % FACES.length]; }
const face = name => faces[name] || autoFace(name);
const avatar = name => `<span class="avatar" style="background:${avatarBg(name)}">${esc(face(name))}</span>`;

let myPick = {};
try { myPick = JSON.parse(localStorage.getItem('myPick') || '{}') || {}; } catch {}
const savePick = () => { try { localStorage.setItem('myPick', JSON.stringify(myPick)); } catch {} };

// ---------- Join and leave ----------
(async () => {
  setCookie('pw', '', 0);
  if ((await fetch('/state').catch(() => null))?.ok) return enter();
  const room = await fetch('/room').then(r => r.json()).catch(() => ({}));
  if (room.public) { $('roomGroup').style.display = 'none'; $('pw').required = false; }
  $('name').value = getCookie('name');
  $('joinAvWrap').appendChild($('colorPop'));
  $('join').appendChild($('footer'));
  previewMe();
  $('name').oninput = previewMe;
  $('join').hidden = false;
})();

function previewMe() {
  myName = $('name').value.trim();
  colors = myPick.color ? { [myName]: myPick.color } : {};
  faces = myPick.face ? { [myName]: myPick.face } : {};
  paintMe();
}

function togglePw(b) {
  const input = b.previousElementSibling, show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  b.setAttribute('aria-pressed', show);
  b.title = show ? 'Hide password' : 'Show password';
  b.setAttribute('aria-label', b.title);
  b.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
}

async function join(e) {
  e.preventDefault();
  if (!$('joinForm').reportValidity() || !$('pw').reportValidity()) return;
  const r = await fetch('/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value, name: $('name').value.trim(), own: $('ownPw').value }) }).catch(() => null);
  if (!r || !r.ok) {
    $('err').textContent = !r ? "Can't reach the server" : r.status === 429 ? 'Too many wrong tries, wait a few minutes'
      : (await r.text().catch(() => '')) || 'Wrong password';
    return;
  }
  await Promise.all([
    myPick.face && post('/face', { face: myPick.face, quiet: true }),
    myPick.color && post('/color', { color: myPick.color, quiet: true }),
  ]);
  $('join').hidden = true;
  enter();
}

function enter() {
  joined = true;
  listen();
  myName = getCookie('name') || 'someone';
  $('me').textContent = myName;
  $('me').after($('colorPop'));
  $('colorPop').hidden = true;
  footerHome.appendChild($('footer'));
  paintMe();
  poll();
}

addEventListener('pagehide', () => { if (joined) navigator.sendBeacon('/bye'); });
async function logout() { await fetch('/logout', { method: 'POST' }).catch(() => {}); location.reload(); }

// ---------- Theme ----------
const isDark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
function showThemeIcon() {
  $('theme').innerHTML = icon(isDark() ? 'sun' : 'moon');
  $('themeColor').content = isDark() ? '#0c0c11' : '#f3f3f7';
}
function toggleTheme() {
  const t = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch {}
  showThemeIcon();
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', showThemeIcon);
showThemeIcon();

// ---------- Colour picker ----------
const SWATCHES = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
                  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899'];
$('swatches').innerHTML = SWATCHES.map(c =>
  `<button type="button" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');

function paintMe() {
  const f = face(myName);
  for (const el of [$('meAvatar'), $('popAvatar'), $('joinAvatar')]) { el.style.background = avatarBg(myName); el.textContent = f; }
  for (const el of [$('me'), $('popName')]) el.style.color = nameColor(myName);
  $('popName').textContent = myName || 'You';
  for (const b of $('facePick').querySelectorAll('button')) b.classList.toggle('on', b.dataset.e === f);
}

let cur = { h: 0, s: 0, v: 1 };

function drawPicker(hex, skip) {
  const R = 100, a = cur.h * Math.PI / 180;
  $('wheelDot').style.left = R + Math.sin(a) * cur.s * R + 'px';
  $('wheelDot').style.top = R - Math.cos(a) * cur.s * R + 'px';
  $('wheelDot').style.background = hex;
  $('wheelDark').style.opacity = 1 - cur.v;
  $('valSlider').value = Math.round(cur.v * 100);
  $('valSlider').style.background = `linear-gradient(90deg, #000, ${toHex(hsvToRgb(cur.h, cur.s, 1))})`;
  const [r, g, b] = hexToRgb(hex);
  if (skip !== 'hex') { $('hexIn').value = hex; $('hexIn').classList.remove('bad'); }
  if (skip !== 'rgb') { $('rIn').value = r; $('gIn').value = g; $('bIn').value = b; }
  for (const btn of $('swatches').children) btn.classList.toggle('on', btn.dataset.c === hex);
}

function apply(hsv, { hex, skip, save } = {}) {
  cur = hsv;
  hex = hex || toHex(hsvToRgb(cur.h, cur.s, cur.v));
  drawPicker(hex, skip);
  colors[myName] = hex; paintMe(); lastColorsKey = '';
  if (save) {
    myPick.color = hex; savePick();
    if (joined) post('/color', { color: hex }).then(poll);
  }
}

function setFace(em) {
  faces[myName] = myPick.face = em; savePick();
  paintMe(); lastColorsKey = '';
  if (joined) post('/face', { face: em }).then(poll);
}
$('facePick').onclick = e => { const b = e.target.closest('button[data-e]'); if (b) setFace(b.dataset.e); };
$('colorPop').onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.blur(); } };
const myHex = () => colors[myName] && typeof colors[myName] === 'string' ? colors[myName]
  : toHex(getComputedStyle($('meAvatar')).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));

function toggleColorPop(e) {
  e.stopPropagation();
  const pop = $('colorPop');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) { const hex = myHex(); cur = rgbToHsv(...hexToRgb(hex)); drawPicker(hex); }
}
$('colorPop').onclick = e => e.stopPropagation();
document.addEventListener('click', () => { $('colorPop').hidden = true; $('emojiPop').hidden = true; $('reactPop').hidden = true; });

let dragging = false;
function wheelAt(e) {
  const r = $('wheel').getBoundingClientRect(), R = r.width / 2;
  const dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
  const h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  return { h, s: Math.min(1, Math.hypot(dx, dy) / R), v: cur.v < 0.05 ? 1 : cur.v };
}
$('wheel').onpointerdown = e => { dragging = true; $('wheel').setPointerCapture(e.pointerId); apply(wheelAt(e)); };
$('wheel').onpointermove = e => { if (dragging) apply(wheelAt(e)); };
$('wheel').onpointerup = e => { if (dragging) { dragging = false; apply(wheelAt(e), { save: true }); } };

$('valSlider').oninput = e => apply({ ...cur, v: e.target.value / 100 });
$('valSlider').onchange = e => apply({ ...cur, v: e.target.value / 100 }, { save: true });

$('hexIn').oninput = e => {
  const hex = parseHex(e.target.value);
  e.target.classList.toggle('bad', !hex && e.target.value.trim() !== '');
  if (hex) apply(rgbToHsv(...hexToRgb(hex)), { hex, skip: 'hex' });
};
$('hexIn').onchange = e => {
  const hex = parseHex(e.target.value);
  if (hex) apply(rgbToHsv(...hexToRgb(hex)), { hex, save: true }); else drawPicker(myHex());
};

const readRgb = () => {
  const vals = ['rIn', 'gIn', 'bIn'].map(id => $(id).value.trim());
  if (vals.some(x => x === '' || isNaN(x))) return null;
  return vals.map(x => Math.max(0, Math.min(255, Math.round(+x))));
};
for (const id of ['rIn', 'gIn', 'bIn']) {
  $(id).oninput = () => { const rgb = readRgb(); if (rgb) apply(rgbToHsv(...rgb), { hex: toHex(rgb), skip: 'rgb' }); };
  $(id).onchange = () => { const rgb = readRgb(); if (rgb) apply(rgbToHsv(...rgb), { hex: toHex(rgb), save: true }); else drawPicker(myHex()); };
}

$('swatches').onclick = e => {
  const b = e.target.closest('button');
  if (b) apply(rgbToHsv(...hexToRgb(b.dataset.c)), { hex: b.dataset.c, save: true });
};

// ---------- Emoji picker ----------
const EMOJI = {
  'Smileys': '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😛 😜 🤪 😎 🤩 🥳 😏 😒 😔 😢 😭 😤 😡 🤯 😳 🥺 😱 🤔 🤫 🙄 😴 🤤 😬 🤮 🤡 💀 👻 👽 🤖 💩',
  'Gestures': '👍 👎 👏 🙌 👐 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤌 👈 👉 👆 👇 ✋ 👋 💪 🫶 👀 🧠',
  'Hearts': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 💯 💥 ✨ 🔥 ⭐ 🌟 💫',
  'Music & party': '🎵 🎶 🎧 🎤 🎸 🎹 🥁 🎷 🎺 🎻 📻 💿 🔊 🕺 💃 🪩 🎉 🎊 🍾 🥂 🍻 🍺 🍷 🍸',
  'Food': '🍕 🍔 🍟 🌭 🌮 🍿 🍩 🍪 🍫 🍦 🍓 🍉 🍌 🍑 🍆 🥑 🌶️ ☕ 🧃',
  'Animals': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🦄 🐝 🦋 🐢 🐍 🦖 🐙 🦈 🐳',
  'Other': '🚀 🏆 🎮 🎲 💸 💰 ⏰ 📸 🌈 ☀️ 🌙 ⚡ ❄️ 🌊 🍀 🚗 ✅ ❌ ❓ ❗ 🆗 🆒',
};
let recentEmoji = [];
try { recentEmoji = JSON.parse(localStorage.getItem('recentEmoji') || '[]'); } catch {}
const emojiGridHtml = groups => Object.entries(groups).map(([name, list]) =>
  `<div class="pop-title">${name}</div><div class="emoji-grid">${
    list.split(' ').map(e => `<button type="button" data-e="${e}">${e}</button>`).join('')}</div>`).join('');
function drawEmoji() {
  $('emojiPop').innerHTML = emojiGridHtml(recentEmoji.length ? { 'Recent': recentEmoji.join(' '), ...EMOJI } : EMOJI);
}
$('facePick').innerHTML = emojiGridHtml({ 'Popular': FACES.join(' '), ...EMOJI });
paintMe();

function toggleEmoji(e) {
  e.stopPropagation();
  const pop = $('emojiPop');
  if (pop.hidden) drawEmoji();
  pop.hidden = !pop.hidden;
}
$('emojiPop').onclick = e => {
  e.stopPropagation();
  const b = e.target.closest('button[data-e]');
  if (!b) return;
  const em = b.dataset.e, input = $('chatText');
  const s = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? s;
  input.value = input.value.slice(0, s) + em + input.value.slice(end);
  input.selectionStart = input.selectionEnd = s + em.length;
  recentEmoji = [em, ...recentEmoji.filter(x => x !== em)].slice(0, 16);
  try { localStorage.setItem('recentEmoji', JSON.stringify(recentEmoji)); } catch {}
  if (!matchMedia('(pointer: coarse)').matches) input.focus();
};

// ---------- Reactions: emoji floating over the video ----------
const myCid = Math.random().toString(36).slice(2, 12);
let recentReact = ['🔥', '😂', '❤️', '👍', '🎉'];
try { const r = JSON.parse(localStorage.getItem('recentReact') || 'null'); if (Array.isArray(r) && r.length) recentReact = r.slice(0, 5); } catch {}
let lastReactId = null, liveParticles = 0, pendingReacts = {}, reactTimer = null;

function drawReacts() {
  $('reactRecent').innerHTML = recentReact.map(e => `<button type="button" class="ghost react" data-e="${e}">${e}</button>`).join('');
}
function burst(e) {
  if (liveParticles >= 160 || document.hidden) return;
  const player = $('player'), s = document.createElement('span');
  s.className = 'particle'; s.textContent = e;
  s.style.left = (45 + Math.random() * 48) + '%';
  player.appendChild(s); liveParticles++;
  const size = 0.7 + Math.random() * 0.8, drift = (Math.random() - 0.5) * 140;
  const rise = player.clientHeight * (0.55 + Math.random() * 0.4), spin = (Math.random() - 0.5) * 70;
  s.animate([
    { transform: `translate(-50%, 0) scale(${size * 0.4})`, opacity: 0 },
    { transform: `translate(-50%, -${rise * 0.12}px) scale(${size})`, opacity: 1, offset: 0.12 },
    { transform: `translate(calc(-50% + ${drift}px), -${rise}px) scale(${size}) rotate(${spin}deg)`, opacity: 0 },
  ], { duration: 1700 + Math.random() * 1000, easing: 'cubic-bezier(.2,.7,.4,1)' })
    .onfinish = () => { s.remove(); liveParticles--; };
}
function react(e) {
  burst(e);
  pendingReacts[e] = (pendingReacts[e] || 0) + 1;
  if (!reactTimer) reactTimer = setTimeout(() => {
    reactTimer = null;
    for (const [em, n] of Object.entries(pendingReacts)) fetch('/react', { method: 'POST', body: JSON.stringify({ e: em, n, cid: myCid }) }).catch(() => {});
    pendingReacts = {};
  }, 250);
}
function showReactions(list) {
  if (!list) return;
  const newest = list.reduce((m, r) => Math.max(m, r.id), lastReactId || 0);
  if (lastReactId !== null) {
    for (const r of list) {
      if (r.id <= lastReactId || r.cid === myCid) continue;
      for (let i = 0; i < Math.min(r.n, 40); i++) setTimeout(() => burst(r.e), Math.random() * 1600);
    }
  }
  lastReactId = newest;
}
$('reactRecent').onclick = e => { const b = e.target.closest('[data-e]'); if (b) react(b.dataset.e); };
function toggleReactPop(e) {
  e.stopPropagation();
  const pop = $('reactPop');
  if (pop.hidden) pop.innerHTML = emojiGridHtml(EMOJI);
  pop.hidden = !pop.hidden;
}
$('reactPop').onclick = e => {
  e.stopPropagation();
  const b = e.target.closest('[data-e]');
  if (!b) return;
  react(b.dataset.e);
  recentReact = [b.dataset.e, ...recentReact.filter(x => x !== b.dataset.e)].slice(0, 5);
  try { localStorage.setItem('recentReact', JSON.stringify(recentReact)); } catch {}
  drawReacts();
};
drawReacts();

// ---------- Playback: sound from the hidden <audio>, the <video> follows it ----------
const a = $('a');
let heldLocally = false;
let ourPauseAt = 0;
const markOurPause = () => (ourPauseAt = Date.now());
let audioOnly = false;
try { audioOnly = localStorage.getItem('audioOnly') === '1'; } catch {}
function loadVideo(id) { if (audioOnly || !id) { v.removeAttribute('src'); v.load(); } else v.src = '/video/' + id; }
let vBuffering = false;
function drawSpin() {
  const loading = !!v.getAttribute('src') && !v.error && (v.readyState < 2 || v.seeking || vBuffering);
  $('vSpin').hidden = audioOnly || !loading;
}
v.addEventListener('waiting', () => { vBuffering = true; drawSpin(); });
v.addEventListener('playing', () => { vBuffering = false; drawSpin(); });
for (const e of ['loadstart', 'loadeddata', 'canplay', 'seeking', 'seeked', 'emptied', 'error', 'pause']) v.addEventListener(e, () => { if (e !== 'seeking') vBuffering = vBuffering && e !== 'emptied' && e !== 'pause'; drawSpin(); });
function playVideo() { if (!audioOnly && !document.hidden) v.play().catch(() => {}); }
function drawAudioOnly() {
  $('player').classList.toggle('audioMode', audioOnly);
  const b = $('audioBtn');
  b.classList.toggle('on', audioOnly);
  b.innerHTML = icon(audioOnly ? 'video-off' : 'video');
  b.setAttribute('aria-pressed', audioOnly);
  b.title = audioOnly ? 'Audio only is on: click to show the video again (just you)' : 'Audio only: turn the video off for you (saves data)';
}
function toggleAudioOnly() {
  audioOnly = !audioOnly;
  try { localStorage.setItem('audioOnly', audioOnly ? '1' : '0'); } catch {}
  drawAudioOnly(); drawSpin();
  if (audioOnly) { v.pause(); loadVideo(null); }
  else if (playingId) { loadVideo(playingId); v.currentTime = a.currentTime; if (!a.paused) playVideo(); }
}
drawAudioOnly();
function pauseBoth() { markOurPause(); a.pause(); v.pause(); }
function syncVideo() { if (!audioOnly && Math.abs(v.currentTime - a.currentTime) > 0.5) v.currentTime = a.currentTime; }

function tryPlay() {
  playVideo();
  a.play().catch(err => { if (err.name === 'NotAllowedError') $('unmute').hidden = false; });
}
function unmute() {
  a.muted = false; heldLocally = false;
  $('unmute').hidden = true;
  if (!serverPaused) tryPlay();
}

a.onpause = () => { if (Date.now() - ourPauseAt > 1000 && !a.ended && !serverPaused) { heldLocally = true; v.pause(); } };
a.onplay = () => { heldLocally = false; };

// ---------- Song changes that survive a locked phone ----------
let upNext = null;
let endedId = null;
let silent = false;

const SILENCE = (() => {
  const n = 8000, b = new Uint8Array(44 + n), d = new DataView(b.buffer);
  const w = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); d.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 8000, true); d.setUint32(28, 8000, true); d.setUint16(32, 1, true); d.setUint16(34, 8, true);
  w(36, 'data'); d.setUint32(40, n, true); b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})();

let videoRetries = 0;
function startTrack(item, at, play) {
  playingId = item.id; silent = false; videoRetries = 0;
  markOurPause();
  a.loop = false;
  a.src = '/audio/' + item.id;
  loadVideo(item.id);
  a.currentTime = v.currentTime = at;
  songGain = item.gain ?? 1; applyVolume();
  setMediaSession(item);
  if (play) tryPlay();
}
function playSilence() {
  playingId = null;
  markOurPause();
  v.removeAttribute('src'); v.load();
  if (!silent) { silent = true; a.loop = true; a.src = SILENCE; a.play().catch(() => {}); }
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Waiting for the next song…', album: 'Couchwave' }); } catch {}
}
function clearPlayer() {
  playingId = null; silent = false;
  markOurPause();
  for (const m of [v, a]) { m.removeAttribute('src'); m.load(); }
}
a.onended = () => {
  endedId = playingId;
  if (upNext && upNext.id !== playingId) startTrack(upNext, 0, true);
  else playSilence();
  poll();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !playingId || audioOnly) return;
  v.currentTime = a.currentTime;
  if (!a.paused) playVideo();
});

// ---------- Controls ----------
const paint = el => el.style.setProperty('--p', ((+el.value / (+el.max || 1)) * 100) + '%');
let songGain = 1;
const applyVolume = () => { a.volume = Math.min(1, Math.max(0, +vol.value * songGain)); };
try { vol.value = localStorage.getItem('vol') ?? 1; } catch { vol.value = 1; }
applyVolume(); paint(vol);
vol.oninput = () => {
  preMute = null;
  applyVolume(); paint(vol);
  if (a.muted) unmute();
  try { localStorage.setItem('vol', vol.value); } catch {}
};

let preMute = null;
function toggleMute() {
  if (a.muted || +vol.value === 0) {
    let level = preMute ?? +vol.value;
    if (!level) level = 1;
    preMute = null;
    vol.value = level; applyVolume(); paint(vol);
    try { localStorage.setItem('vol', level); } catch {}
    unmute();
  } else {
    preMute = +vol.value;
    a.muted = true; vol.value = 0; paint(vol);
  }
}
a.onvolumechange = () => ($('muteBtn').innerHTML = icon(a.muted || a.volume === 0 ? 'mute' : 'vol'));

const fmt = t => { t = Math.floor(t || 0); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const showTime = t => ($('time').textContent = fmt(t) + ' / ' + fmt(seek.max));

seek.oninput = () => { seeking = true; showTime(seek.value); paint(seek); };
seek.onchange = () => { seeking = false; a.currentTime = v.currentTime = +seek.value; post('/seek', { t: +seek.value }); };
const clock = () => (a.paused && !v.paused ? v : a);
function onTime() {
  if (!a.paused && !document.hidden) syncVideo();
  if (!seeking) { const t = clock().currentTime; seek.value = t; showTime(t); paint(seek); }
}
a.ontimeupdate = onTime;
v.ontimeupdate = onTime;

function updatePP() { $('pp').innerHTML = icon(serverPaused ? 'play' : 'pause'); }
function togglePause() {
  serverPaused = !serverPaused;
  heldLocally = false;
  if (serverPaused) { pauseBoth(); post('/pause'); } else { tryPlay(); post('/play'); }
  updatePP();
}
updatePP();

// ---------- Vote to skip ----------
let votedSkip = false, skipSongId = null;
function skip() { voteSkip(!votedSkip); }
function voteSkip(vote, id = skipSongId) {
  if (id == null) return;
  if (id === skipSongId) { votedSkip = vote; $('skipBtn').setAttribute('aria-pressed', vote); }
  post('/skip', { id, vote }).then(poll);
}
function drawSkip(s) {
  const voters = s.current ? s.skip.voters : [], people = s.users.length;
  skipSongId = s.current ? s.current.id : null;
  votedSkip = voters.includes(myName);
  const b = $('skipBtn');
  $('skipText').textContent = voters.length ? `${voters.length} out of ${people} voted to skip` : 'Skip';
  b.setAttribute('aria-pressed', votedSkip);
  const mySong = s.current && s.current.by === myName;
  b.title = mySong ? 'Your song: skip it straight away (no vote needed)'
    : votedSkip ? 'You voted to skip. Click to take your vote back'
    : people > 1 ? `Vote to skip this song (skips at ${s.skip.need} out of ${people})` : 'Skip this song';
  if (voters.length) b.title += '\nVoted: ' + voters.join(', ');
}

// ---------- Full screen (player + chat side by side) ----------
const isFs = () => document.body.classList.contains('fs');
function drawFs() {
  $('fsBtn').innerHTML = icon(isFs() ? 'shrink' : 'expand');
  $('fsBtn').title = isFs() ? 'Exit full screen' : 'Full screen (double-click the video too)';
  const c = $('chat'); c.scrollTop = c.scrollHeight;
}
function toggleFs() {
  if (!isFs()) {
    document.body.classList.add('fs');
    const el = document.documentElement;
    try { (el.requestFullscreen || el.webkitRequestFullscreen).call(el).catch?.(() => {}); } catch {}
  } else {
    document.body.classList.remove('fs');
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch {}
  }
  drawFs();
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.body.classList.remove('fs'); drawFs(); showUi(); });
v.ondblclick = toggleFs;
drawFs();

let chatHidden = false;
try { chatHidden = localStorage.getItem('fsChatHidden') === '1'; } catch {}
function drawChatHidden() {
  document.body.classList.toggle('chatHidden', chatHidden);
  const b = $('chatBtn');
  b.setAttribute('aria-pressed', !chatHidden);
  b.title = chatHidden ? 'Show chat' : 'Hide chat';
  b.setAttribute('aria-label', b.title);
  if (!chatHidden) b.classList.remove('unread');
}
function toggleChat() {
  chatHidden = !chatHidden;
  try { localStorage.setItem('fsChatHidden', chatHidden ? '1' : '0'); } catch {}
  drawChatHidden();
  const c = $('chat'); c.scrollTop = c.scrollHeight;
  showUi();
}
drawChatHidden();

let uiTimer = null;
function showUi() {
  document.body.classList.remove('uiAway');
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const keep = !isFs() || serverPaused || !playingId || document.querySelector('.now:hover, .controls:hover, #reactPop:not([hidden])');
    if (keep) showUi(); else document.body.classList.add('uiAway');
  }, 3000);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown']) document.addEventListener(ev, () => { if (isFs()) showUi(); }, { passive: true });

// ---------- Lock screen / notification controls (Media Session) ----------
function ytThumb(url) { const m = /(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(url || ''); return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : ''; }
function setMediaSession(cur) {
  if (!('mediaSession' in navigator)) return;
  const art = ytThumb(cur.url);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.title, artist: 'added by ' + cur.by, album: 'Couchwave',
      artwork: art ? [{ src: art, sizes: '480x360', type: 'image/jpeg' }] : [],
    });
  } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => { heldLocally = false; if (!serverPaused) tryPlay(); },
    pause: () => { heldLocally = true; pauseBoth(); },
    nexttrack: () => voteSkip(true, playingId),
  };
  for (const [action, fn] of Object.entries(handlers)) { try { ms.setActionHandler(action, fn); } catch {} }
}

// ---------- Adding songs ----------
function askPlaylist(hasVideo) {
  $('plOne').textContent = hasVideo ? 'Just this song' : 'Just the first song';
  $('plText').textContent = hasVideo
    ? 'This song is part of a playlist. Add every song in the playlist to the queue?'
    : 'This is a playlist link. Add every song in it to the queue?';
  $('plModal').hidden = false;
  $('plAll').focus();
  return new Promise(resolve => {
    const close = answer => {
      $('plModal').hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    $('plAll').onclick = () => close('all');
    $('plOne').onclick = () => close('one');
    $('plCancel').onclick = () => close(null);
    $('plModal').onclick = e => { if (e.target === $('plModal')) close(null); };
  });
}

let adding = false;
async function add(e) {
  e.preventDefault();
  const input = $('url'), link = input.value.trim();
  if (adding || !link) return;
  let playlist = false;
  if (/^https?:\/\//i.test(link) && /[?&]list=/.test(link)) {
    const choice = await askPlaylist(/[?&]v=|youtu\.be\/[\w-]{11}/.test(link));
    if (!choice) return;
    playlist = choice === 'all';
  }
  adding = true;
  try {
    const r = await fetch('/add', { method: 'POST', body: JSON.stringify({ url: link, playlist }) }).catch(() => null);
    if (!r) return alert("Couldn't reach the server, try again in a moment");
    if (!r.ok) return alert(await r.text());
    if (input.value.trim() === link) input.value = '';
    poll();
  } finally { adding = false; }
}

// ---------- Chat ----------
let pendingChat = [];
async function sendChat(e) {
  e.preventDefault();
  const input = $('chatText'), text = input.value;
  if (!text.trim()) return;
  input.value = '';
  const mine = { t: Date.now(), by: myName, text: text.trim().slice(0, 500), pending: true };
  pendingChat.push(mine); drawChat();
  const r = await fetch('/chat', { method: 'POST', body: JSON.stringify({ text }) }).catch(() => null);
  if (r && r.ok) await poll();
  pendingChat = pendingChat.filter(m => m !== mine); drawChat();
  if (!r || !r.ok) { if (!input.value) input.value = text; }
  if (r && r.status === 429) chatCooldown(+r.headers.get('Retry-After') || 30);
}

let cooldownTimer = null;
function chatCooldown(seconds) {
  const input = $('chatText'), btn = $('sendBtn'), until = Date.now() + seconds * 1000;
  const typed = input.value, placeholder = input.placeholder;
  if (cooldownTimer) return;
  input.value = '';
  input.disabled = btn.disabled = true;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) { input.placeholder = `Chat again in ${left}s`; return; }
    clearInterval(cooldownTimer); cooldownTimer = null;
    input.disabled = btn.disabled = false;
    input.placeholder = placeholder;
    if (!input.value) input.value = typed;
  };
  tick();
  cooldownTimer = setInterval(tick, 1000);
}

const bigEmoji = t => /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s)+$/u.test(t)
  && [...t.replace(/\s|\uFE0F|\u200D/g, "")].filter(c => /\p{Extended_Pictographic}/u.test(c)).length <= 3;
function drawChat() {
  const c = $('chat');
  const atBottom = !chatDrawn || c.scrollHeight - c.scrollTop - c.clientHeight < 40;
  c.innerHTML = [...chatList, ...pendingChat].map(m => `
    <div class="msg${m.pending ? ' pending' : ''}">
      ${avatar(m.by)}
      <div class="body">
        <div class="head"><b class="nm" style="color:${nameColor(m.by)}">${esc(m.by)}</b><span class="time">${hhmm(m.t)}</span></div>
        <div class="text${bigEmoji(m.text) ? ' big' : ''}">${esc(m.text)}</div>
      </div>
    </div>`).join('') || '<div class="empty">No messages yet — say hi!</div>';
  chatDrawn = true;
  if (atBottom) c.scrollTop = c.scrollHeight;
}

// ---------- Queue, Activity and History ----------
let nowUrl = '';
async function copyLink(url, b) {
  if (!url) return;
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch {}
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  if (!ok) return prompt('Copy this link:', url);
  b.classList.add('done'); b.innerHTML = icon('check'); b.title = 'Copied!';
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.classList.remove('done'); b.innerHTML = icon('copy'); b.title = 'Copy the YouTube link'; }, 1500);
}
const undoSeen = {};
$('log').onclick = e => {
  const b = e.target.closest('.undo');
  if (b && Date.now() - (undoSeen[b.dataset.undo] || 0) < 1500) return;
  if (b) { b.disabled = true; b.textContent = '…'; post('/undo', { id: +b.dataset.undo }).then(poll); }
};
$('history').onclick = e => {
  const copy = e.target.closest('.copy'), again = e.target.closest('.requeue');
  if (copy) copyLink(copy.dataset.url, copy);
  if (again) requeue(again);
};
$('history').addEventListener('wheel', e => {
  const el = e.currentTarget;
  if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientWidth : 1);
  const room = dy > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
  if (room < 1) return;
  e.preventDefault();
  el.scrollLeft += dy;
}, { passive: false });
async function requeue(b) {
  if (b.classList.contains('done')) return;
  const reset = () => { b.classList.remove('done'); b.innerHTML = icon('plus'); b.title = 'Add it to the queue again'; };
  b.classList.add('done'); b.innerHTML = icon('check'); b.title = 'Added to the queue';
  const r = await post('/add', { url: b.dataset.url });
  if (!r || !r.ok) { reset(); return alert(r ? await r.text() : "Couldn't reach the server, try again in a moment"); }
  poll();
  setTimeout(reset, 1500);
}
function delButton(q, s) {
  const voters = q.removeVoters || [], people = s.users.length, mine = q.by === myName, voted = voters.includes(myName);
  const who = voters.length ? `\nVoted to remove it: ${voters.join(', ')}` : '';
  const title = mine ? 'Remove from the queue' + who
    : voted ? 'You voted to remove this. Click to take your vote back' + who
    : (people > 1 ? `Vote to remove this song (removed at ${s.skip.need} out of ${people})` : 'Remove this song') + who;
  const count = voters.length ? `<span class="delCount">${voters.length}/${people}</span>` : '';
  return `<button class="ghost del${voted ? ' voted' : ''}${count ? ' counted' : ''}" data-mine="${mine ? 1 : ''}" data-voted="${voted ? 1 : ''}" aria-pressed="${voted}" title="${esc(title)}" aria-label="${esc(title)}">${icon('trash')}${count}</button>`;
}
$('queue').onclick = e => {
  const copy = e.target.closest('.copy');
  if (copy) return copyLink(copy.dataset.url, copy);
  const again = e.target.closest('.retry');
  if (again) { again.disabled = true; return post('/retry', { id: +again.closest('li').dataset.id }).then(poll); }
  const del = e.target.closest('.del');
  if (!del) return;
  if (!del.dataset.mine) {
    const vote = !del.dataset.voted;
    del.dataset.voted = vote ? '1' : ''; del.classList.toggle('voted', vote);
    return post('/remove', { id: +del.closest('li').dataset.id, vote }).then(poll);
  }
  if (!del.classList.contains('armed')) {
    del.classList.add('armed'); del._armedAt = Date.now(); del.title = 'Click again to remove';
    clearTimeout(del._t);
    del._t = setTimeout(() => { del.classList.remove('armed'); del.title = 'Remove from the queue'; }, 3000);
    return;
  }
  if (Date.now() - del._armedAt < 350) return;
  const li = del.closest('li');
  li.style.opacity = '.4';
  post('/remove', { id: +li.dataset.id }).then(r => { if (!r || !r.ok) li.style.opacity = ''; poll(); });
};

function whenPlayed(t) {
  const d = new Date(t), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  return days === 0 ? hhmm(t) : days === 1 ? 'Yesterday ' + hhmm(t)
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hhmm(t);
}
const ytThumbSmall = url => ytThumb(url).replace('/hqdefault.', '/mqdefault.');
function drawHistory() {
  $('historyCount').textContent = historyList.length;
  const html = historyList.map(h => `
    <li>
      <a href="${esc(h.url)}" target="_blank" rel="noopener" title="Open on YouTube"><img class="hthumb" src="${esc(ytThumbSmall(h.url))}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>
      <span class="htitle" title="${esc(h.title)}">${esc(h.title)}</span>
      <span class="hmeta">${avatar(h.by)} <span class="nm" style="color:${nameColor(h.by)}">${esc(h.by)}</span></span>
      <span class="hmeta htime">${whenPlayed(h.t)}<span class="hbtns"><button class="ghost copy" data-url="${esc(h.url)}" title="Copy the YouTube link" aria-label="Copy the YouTube link">${icon('copy')}</button><button class="ghost requeue" data-url="${esc(h.url)}" title="Add it to the queue again" aria-label="Add it to the queue again">${icon('plus')}</button></span></span>
    </li>`).join('') || '<li class="empty">Nothing played yet</li>';
  if (html !== lastHistory) { $('history').innerHTML = html; lastHistory = html; }
}

function drawLog() {
  $('log').innerHTML = logList.slice().reverse().map(e =>
    `<li><span class="time">${hhmm(e.t)}</span><span>${e.by ? `<b class="nm" style="color:${nameColor(e.by)}">${esc(e.by)}</b> ` : ''}${esc(e.text)}</span>${e.undo && e.by === myName ? (undoSeen[e.undo] = undoSeen[e.undo] || Date.now(), `<button class="ghost undo" data-undo="${+e.undo}" title="Put it back in the queue">Undo</button>`) : ''}</li>`
  ).join('') || '<li class="empty">Nothing yet</li>';
}
const QUEUE_BADGE = { ready: 'Ready', downloading: 'Downloading', waiting: 'Waiting', failed: 'Failed', searching: 'Searching' };

// ---------- Sounds: chat ding, joined and left ----------
let audioCtx = null, chatSeen = null, logKeys = null;
document.addEventListener('pointerdown', () => {
  try { audioCtx = audioCtx || new AudioContext(); audioCtx.resume(); } catch {}
}, { once: true });
let chatVol = 1, chatMuted = false;
try { chatVol = +(localStorage.getItem('chatVol') ?? 1); chatMuted = localStorage.getItem('chatMuted') === '1'; } catch {}
function saveChatSound() { try { localStorage.setItem('chatVol', chatVol); localStorage.setItem('chatMuted', chatMuted ? '1' : '0'); } catch {} }
function drawChatSound() {
  $('chatVol').value = chatMuted ? 0 : chatVol; paint($('chatVol'));
  $('chatMute').innerHTML = icon(chatMuted || !chatVol ? 'mute' : 'vol');
}
function toggleChatMute() {
  if (chatMuted || !chatVol) { chatMuted = false; if (!chatVol) chatVol = 1; ding(); }
  else chatMuted = true;
  saveChatSound(); drawChatSound();
}
$('chatVol').oninput = e => { chatVol = +e.target.value; chatMuted = false; saveChatSound(); drawChatSound(); };
$('chatVol').onchange = () => ding();
drawChatSound();

function tones(notes, { type = 'sine', loud = 0.6 } = {}) {
  if (chatMuted || !chatVol) return;
  const peak = loud * chatVol;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    for (const [freq, delay, fade] of notes) {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(peak, t + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + fade);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + fade + 0.05);
    }
  } catch {}
}
const ding = () => tones([[880, 0, 0.6], [1320, 0.09, 0.6]]);
const joinSound = () => tones([[392, 0, 0.25], [523, 0.11, 0.35]], { type: 'triangle', loud: 0.45 });
const leaveSound = () => tones([[523, 0, 0.25], [392, 0.11, 0.35]], { type: 'triangle', loud: 0.45 });

// ---------- Updates from the server ----------
let pollSeq = 0, appliedSeq = 0, lastPoll = 0;
async function poll() {
  if (!joined) return;
  lastPoll = Date.now();
  const seq = ++pollSeq, asked = Date.now();
  let s;
  try {
    const r = await fetch(`/state?log=${logRev}&chat=${chatRev}&history=${historyRev}`);
    if (r.status === 401) return location.reload();
    if (!r.ok) return;
    s = await r.json();
  } catch { return; }
  if (seq < appliedSeq || asked < actionAt) return;
  appliedSeq = seq;

  if (s.me && s.me !== myName) {
    myName = s.me;
    $('me').textContent = myName;
    paintMe();
    lastQueue = '';
    if (logList.length) drawLog();
  }

  showReactions(s.reactions);

  const mine = colors[myName], myFace = faces[myName];
  colors = s.colors || {};
  faces = s.faces || {};
  if (!$('colorPop').hidden) { if (mine != null) colors[myName] = mine; if (myFace) faces[myName] = myFace; }
  paintMe();
  document.querySelector('.me').classList.remove('loading');
  const colorsKey = JSON.stringify([colors, faces]), recolor = colorsKey !== lastColorsKey;
  lastColorsKey = colorsKey;

  $('idle').hidden = !!s.current;
  $('nowTitle').textContent = s.current ? s.current.title : 'Nothing playing';
  $('nowTitle').className = s.current ? '' : 'muted';
  $('nowBy').innerHTML = s.current ? `added by ${avatar(s.current.by)} ${esc(s.current.by)}` : '';
  nowUrl = s.current ? s.current.url : '';
  $('copyBtn').hidden = !nowUrl;

  $('queueCount').textContent = s.queue.length;
  const queueHtml = s.queue.map((q, i) => `
    <li data-id="${q.id}">
      <span class="num">${i + 1}</span>
      ${q.url ? `<button class="ghost copy" data-url="${esc(q.url)}" title="Copy the YouTube link" aria-label="Copy the YouTube link">${icon('copy')}</button>`
        : '<span class="copygap" aria-hidden="true"></span>'}
      <span class="qtitle">${esc(q.title)}${q.status === 'failed' && q.error ? `<small class="qerr">${esc(q.error)}</small>` : ''}</span>
      <span class="by">${avatar(q.by)} ${esc(q.by)}</span>
      ${q.status === 'failed' && q.retrying ? '<span class="badge downloading" title="Trying again in a moment">Retrying</span>'
        : `<span class="badge ${esc(q.status)}">${QUEUE_BADGE[q.status] || esc(q.status)}</span>`}
      ${q.status === 'failed' && !q.retrying ? `<button class="ghost retry" title="Try downloading again" aria-label="Try downloading again">${icon('retry')}</button>` : ''}
      ${delButton(q, s)}
    </li>`).join('') || '<li class="empty">Queue is empty — add something!</li>';
  if (queueHtml !== lastQueue) { $('queue').innerHTML = queueHtml; lastQueue = queueHtml; }

  if (s.log) {
    const key = l => `${l.t}|${l.by}|${l.text}`, fresh = logKeys ? s.log.filter(l => !logKeys.has(key(l)) && l.by !== myName) : [];
    if (fresh.some(l => l.text === 'joined')) joinSound();
    else if (fresh.some(l => l.text === 'left')) leaveSound();
    logKeys = new Set(s.log.map(key));
    logList = s.log; logRev = s.logRev;
  }
  if (s.log || recolor) drawLog();

  if (s.history) { historyList = s.history; historyRev = s.historyRev; }
  if (s.history || recolor) drawHistory();

  $('userCount').textContent = s.users.length;
  const usersHtml = s.users.map(u => `<li>${avatar(u)} <span class="nm" style="color:${nameColor(u)}">${esc(u)}</span></li>`).join('')
    + (s.dj ? `<li class="djOn" title="The DJ is on: when the queue runs out, it plays something like what you've been asking for. Type !dj off in the chat to stop it.">${avatar(DJ_NAME)} <span class="nm">DJ</span></li>` : '');
  if (usersHtml !== lastUsers) { $('users').innerHTML = usersHtml; lastUsers = usersHtml; }
  drawSkip(s);

  if (s.chat) {
    if (chatSeen !== null && s.chat.some(m => m.t > chatSeen && m.by !== myName)) {
      ding();
      if (isFs() && chatHidden) $('chatBtn').classList.add('unread');
    }
    chatSeen = Math.max(chatSeen || 0, s.chat.length ? s.chat[s.chat.length - 1].t : 0);
    chatList = s.chat; chatRev = s.chatRev;
  }
  if (s.chat || recolor) drawChat();

  serverPaused = s.paused;
  updatePP();

  upNext = s.next;
  if (endedId !== null) {
    if (s.current && s.current.id === endedId) return;
    endedId = null;
  }
  if (!s.current) {
    if (playingId) {
      if (!a.paused && !heldLocally) playSilence(); else clearPlayer();
    }
    seek.max = 0; seek.value = 0; showTime(0); paint(seek);
    seek.disabled = true;
    return;
  }
  seek.max = s.current.duration;
  const mySong = s.current.by === myName;
  if (seek.disabled === mySong) {
    seek.disabled = !mySong;
    seek.title = mySong ? 'Move through your song (for everyone)' : 'Only whoever added the song can move through it';
  }

  if (s.current.id !== playingId || a.error) {
    heldLocally = false;
    startTrack(s.current, s.elapsed, !s.paused);
    return;
  }
  if ((s.current.gain ?? 1) !== songGain) { songGain = s.current.gain ?? 1; applyVolume(); }
  if (!audioOnly && v.error && v.error.code === 2 && videoRetries < 3) {
    videoRetries++;
    v.src = '/video/' + playingId;
    v.currentTime = a.currentTime;
    if (!a.paused) playVideo();
  }
  if (!seeking && Math.abs(clock().currentTime - s.elapsed) > (s.paused ? 0.5 : 3)) a.currentTime = v.currentTime = s.elapsed;
  if (s.paused) { if (!a.paused || !v.paused) pauseBoth(); return; }
  if (heldLocally) return;
  if (a.paused && !a.ended && $('unmute').hidden) tryPlay();
  else if (!audioOnly && v.paused && !v.ended) playVideo();
}
let events = null;
function listen() {
  if (events || !('EventSource' in window)) return;
  events = new EventSource('/events');
  events.onmessage = () => poll();
}
const live = () => events && events.readyState === EventSource.OPEN;
setInterval(() => { if (!live() || Date.now() - lastPoll > 10000) poll(); }, 2000);