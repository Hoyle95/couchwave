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
try { const r = JSON.parse(localStorage.getItem('recentEmoji') || '[]'); if (Array.isArray(r)) recentEmoji = r.filter(e => typeof e === 'string').slice(0, 16); } catch {}
const emojiGridHtml = groups => Object.entries(groups).map(([name, list]) =>
  `<div class="pop-title">${name}</div><div class="emoji-grid">${
    list.split(' ').map(e => `<button type="button" data-e="${esc(e)}">${esc(e)}</button>`).join('')}</div>`).join('');
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
  $('gifPop').hidden = true;
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
  const input = $('chatText'), btn = $('sendBtn'), gifBtn = $('gifBtn'), until = Date.now() + seconds * 1000;
  const typed = input.value, placeholder = input.placeholder;
  if (cooldownTimer) return;
  input.value = '';
  input.disabled = btn.disabled = gifBtn.disabled = true;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left > 0) { input.placeholder = `Chat again in ${left}s`; return; }
    clearInterval(cooldownTimer); cooldownTimer = null;
    input.disabled = btn.disabled = gifBtn.disabled = false;
    input.placeholder = placeholder;
    if (!input.value) input.value = typed;
  };
  tick();
  cooldownTimer = setInterval(tick, 1000);
}

// ---------- GIFs (KLIPY) ----------
let gifs = null, gifItems = [], gifCols = [0, 0], gifShown = null, gifPage = 1, gifMore = false, gifBusy = false, gifSeq = 0, gifTimer = null;
const GIF_PAGES = 10;
const gifImg = (g, lazy = true) => `<img class="gif" src="${esc(g.url)}" width="${+g.width}" height="${+g.height}" alt="${esc(g.title || 'GIF')}" title="${esc(g.title || '')}"${lazy ? ' loading="lazy"' : ''} referrerpolicy="no-referrer">`;
const gifFile = item => { const f = item && item.file && (item.file.sm || item.file.md); return f && (f.webp || f.gif); };
const gifApi = (g, path) => `${g.api}/api/v1/${encodeURIComponent(g.key)}/gifs/${path}`;
async function loadGifs(more) {
  if (!gifs || (more && (gifBusy || !gifMore || gifPage >= GIF_PAGES))) return;
  const q = $('gifSearch').value.trim(), seq = ++gifSeq;
  gifPage = more ? gifPage + 1 : 1;
  gifBusy = true;
  const params = new URLSearchParams({ page: gifPage, per_page: 24, customer_id: gifs.customer, content_filter: gifs.filter, format_filter: 'webp,gif' });
  if (q) params.set('q', q);
  let list = null;
  try {
    const r = await fetch(`${gifApi(gifs, q ? 'search' : 'trending')}?${params}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    const j = await r.json();
    if (r.ok && j && j.data) { list = (j.data.data || []).filter(gifFile); gifMore = !!j.data.has_next; }
  } catch {}
  if (seq !== gifSeq) return;
  gifBusy = false;
  const grid = $('gifGrid');
  if (!more) { gifItems = []; gifCols = [0, 0]; grid.innerHTML = '<div class="gifCol"></div><div class="gifCol"></div>'; grid.scrollTop = 0; gifShown = q; }
  if (!list) { if (!more) gifShown = null; if (!gifItems.length) grid.innerHTML = '<div class="empty">Couldn\'t reach KLIPY. Try again in a moment.</div>'; gifMore = false; return; }
  if (!more && !list.length) { grid.innerHTML = `<div class="empty">No GIFs found for “${esc(q)}”.</div>`; return; }
  for (const item of list) {
    const f = gifFile(item), c = gifCols[0] <= gifCols[1] ? 0 : 1;
    gifCols[c] += f.height / f.width;
    grid.children[c].insertAdjacentHTML('beforeend', `<button type="button" class="gifItem" data-g="${gifItems.length}" title="${esc(item.title || '')}">${gifImg({ ...f, title: item.title })}</button>`);
    gifItems.push({ item, q });
  }
  if (gifMore && !$('gifPop').hidden && grid.clientHeight > 0 && grid.scrollHeight - grid.clientHeight < 200) loadGifs(true);
}
function toggleGifs(e) {
  e.stopPropagation();
  const pop = $('gifPop');
  pop.hidden = !pop.hidden;
  $('emojiPop').hidden = true;
  if (pop.hidden) return;
  const grid = $('gifGrid');
  if (gifShown !== $('gifSearch').value.trim()) loadGifs(false);
  else if (gifMore && grid.scrollHeight - grid.clientHeight < 200) loadGifs(true);
  if (!matchMedia('(pointer: coarse)').matches) $('gifSearch').focus();
}
$('gifPop').onclick = e => {
  e.stopPropagation();
  const b = e.target.closest('button[data-g]');
  if (b && gifItems[+b.dataset.g]) sendGif(gifItems[+b.dataset.g]);
};
$('gifSearch').oninput = () => { clearTimeout(gifTimer); gifTimer = setTimeout(() => loadGifs(false), 450); };
$('gifSearch').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(gifTimer); loadGifs(false); } };
$('gifGrid').onscroll = () => { const g = $('gifGrid'); if (g.scrollHeight - g.scrollTop - g.clientHeight < 200) loadGifs(true); };
async function sendGif({ item, q }) {
  $('gifPop').hidden = true;
  const shared = gifs;
  if (!shared) return;
  const f = gifFile(item), gif = { url: f.url, width: f.width, height: f.height, title: item.title || '' };
  const mine = { t: Date.now(), by: myName, text: '', gif, pending: true };
  pendingChat.push(mine); drawChat();
  const r = await fetch('/chat', { method: 'POST', body: JSON.stringify({ gif }) }).catch(() => null);
  if (r && r.ok) await poll();
  pendingChat = pendingChat.filter(m => m !== mine); drawChat();
  if (r && r.ok) {
    fetch(gifApi(shared, `share/${encodeURIComponent(item.slug)}`), { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: shared.customer, q }) }).catch(() => {});
  } else if (r && r.status === 429) chatCooldown(+r.headers.get('Retry-After') || 30);
  else alert(r ? await r.text() : "Couldn't reach the server, try again in a moment");
}

const bigEmoji = t => /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s)+$/u.test(t)
  && [...t.replace(/\s|\uFE0F|\u200D/g, "")].filter(c => /\p{Extended_Pictographic}/u.test(c)).length <= 3;
let chatStuck = true;
const stickChat = () => { const c = $('chat'); if (chatStuck) c.scrollTop = c.scrollHeight; };
$('chat').addEventListener('scroll', () => { const c = $('chat'); chatStuck = c.scrollHeight - c.scrollTop - c.clientHeight < 40; });
$('chat').addEventListener('load', stickChat, true);
new ResizeObserver(stickChat).observe($('chat'));
function drawChat() {
  const c = $('chat');
  const atBottom = !chatDrawn || chatStuck;
  c.innerHTML = [...chatList, ...pendingChat].map(m => `
    <div class="msg${m.pending ? ' pending' : ''}">
      ${avatar(m.by)}
      <div class="body">
        <div class="head"><b class="nm" style="color:${nameColor(m.by)}">${esc(m.by)}</b><span class="time">${hhmm(m.t)}</span></div>
        ${m.gif ? `<div class="text">${gifImg(m.gif)}</div>` : `<div class="text${bigEmoji(m.text) ? ' big' : ''}">${esc(m.text)}</div>`}
      </div>
    </div>`).join('') || '<div class="empty">No messages yet — say hi!</div>';
  chatDrawn = true;
  if (atBottom) c.scrollTop = c.scrollHeight;
}

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
