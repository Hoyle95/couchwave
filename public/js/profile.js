// ---------- Join and leave ----------

function previewMe() {
  myName = $('name').value.trim();
  colors = myPick.color ? { [myName]: myPick.color } : {};
  faces = myPick.face ? { [myName]: myPick.face } : {};
  paintMe();
}

function showHostTip(home) {
  if (!Array.isArray(home) || !home.length) return;
  $('hostTip').innerHTML = `<b>You're on the computer running Couchwave.</b> Friends at home can join at ${home.map(u => `<span class="addr">${esc(u)}</span>`).join(' or ')}`
    + ($('pw').required ? ', with the room password (it\'s in config.json).' : '.');
  $('hostTip').hidden = false;
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
    $('err').textContent = !r ? "Can't reach the server"
      : (await r.text().catch(() => '')) || (r.status === 429 ? 'Too many wrong tries, wait a few minutes' : 'Wrong password');
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

addEventListener('pagehide', () => {
  if (!joined) return;
  if (!$('colorPop').hidden) { savePick(); for (const [url, body] of lookChanges()) navigator.sendBeacon(url, JSON.stringify(body)); }
  navigator.sendBeacon('/bye');
});
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

function apply(hsv, { hex, skip } = {}) {
  cur = hsv;
  hex = hex || toHex(hsvToRgb(cur.h, cur.s, cur.v));
  drawPicker(hex, skip);
  colors[myName] = myPick.color = hex;
  showLook();
}
function setFace(em) {
  faces[myName] = myPick.face = em;
  showLook();
}
function showLook() {
  paintMe();
  repaintPerson(myName);
  lastColorsKey = '';
}

// ---------- Saving the look once the picker closes ----------
let lookSent = {};
const lookChanges = () => {
  const color = own(colors, myName), em = own(faces, myName), changes = [];
  if (color && color !== lookSent.color) changes.push(['/color', { color }]);
  if (em && em !== lookSent.face) changes.push(['/face', { face: em }]);
  return changes;
};
function closeColorPop() {
  if ($('colorPop').hidden) return;
  $('colorPop').hidden = true;
  savePick();
  if (!joined) return;
  const changes = lookChanges();
  lookSent = { color: own(colors, myName), face: own(faces, myName) };
  if (changes.length) Promise.all(changes.map(([url, body]) => post(url, body))).then(() => poll());
}
$('facePick').onclick = e => { const b = e.target.closest('button[data-e]'); if (b) setFace(b.dataset.e); };
$('colorPop').onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.blur(); } };
const myHex = () => own(colors, myName)
  || toHex(getComputedStyle($('meAvatar')).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));

function toggleColorPop(e) {
  e.stopPropagation();
  const pop = $('colorPop');
  if (!pop.hidden) return closeColorPop();
  pop.hidden = false;
  lookSent = { color: own(colors, myName), face: own(faces, myName) };
  const hex = myHex(); cur = rgbToHsv(...hexToRgb(hex)); drawPicker(hex);
}
$('colorPop').onclick = e => e.stopPropagation();
document.addEventListener('click', () => { closeColorPop(); $('emojiPop').hidden = true; $('reactPop').hidden = true; $('gifPop').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeColorPop(); });

let dragging = false;
function wheelAt(e) {
  const r = $('wheel').getBoundingClientRect(), R = r.width / 2;
  const dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
  const h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  return { h, s: Math.min(1, Math.hypot(dx, dy) / R), v: cur.v < 0.05 ? 1 : cur.v };
}
$('wheel').onpointerdown = e => { dragging = true; $('wheel').setPointerCapture(e.pointerId); apply(wheelAt(e)); };
$('wheel').onpointermove = e => { if (dragging) apply(wheelAt(e)); };
$('wheel').onpointerup = e => { if (dragging) { dragging = false; apply(wheelAt(e)); } };

$('valSlider').oninput = e => apply({ ...cur, v: e.target.value / 100 });

$('hexIn').oninput = e => {
  const hex = parseHex(e.target.value);
  e.target.classList.toggle('bad', !hex && e.target.value.trim() !== '');
  if (hex) apply(rgbToHsv(...hexToRgb(hex)), { hex, skip: 'hex' });
};
$('hexIn').onchange = e => {
  const hex = parseHex(e.target.value);
  if (hex) apply(rgbToHsv(...hexToRgb(hex)), { hex }); else drawPicker(myHex());
};

const readRgb = () => {
  const vals = ['rIn', 'gIn', 'bIn'].map(id => $(id).value.trim());
  if (vals.some(x => x === '' || isNaN(x))) return null;
  return vals.map(x => Math.max(0, Math.min(255, Math.round(+x))));
};
for (const id of ['rIn', 'gIn', 'bIn']) {
  $(id).oninput = () => { const rgb = readRgb(); if (rgb) apply(rgbToHsv(...rgb), { hex: toHex(rgb), skip: 'rgb' }); };
  $(id).onchange = () => { const rgb = readRgb(); if (rgb) apply(rgbToHsv(...rgb), { hex: toHex(rgb) }); else drawPicker(myHex()); };
}

$('swatches').onclick = e => {
  const b = e.target.closest('button');
  if (b) apply(rgbToHsv(...hexToRgb(b.dataset.c)), { hex: b.dataset.c });
};
