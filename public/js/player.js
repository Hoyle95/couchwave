// ---------- Reactions: emoji floating over the video ----------
const myCid = Math.random().toString(36).slice(2, 12);
let recentReact = ['🔥', '😂', '❤️', '👍', '🎉'];
try { const r = JSON.parse(localStorage.getItem('recentReact') || 'null'); if (Array.isArray(r) && r.length && r.every(e => typeof e === 'string')) recentReact = r.slice(0, 5); } catch {}
let lastReactId = null, liveParticles = 0, pendingReacts = {}, reactTimer = null;

function drawReacts() {
  $('reactRecent').innerHTML = recentReact.map(e => `<button type="button" class="ghost react" data-e="${esc(e)}">${esc(e)}</button>`).join('');
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
  try { localStorage.setItem('muted', '0'); } catch {}
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

let videoRetries = 0, audioRetries = 0;
function startTrack(item, at, play) {
  if (item.id !== playingId) { videoRetries = 0; audioRetries = 0; }
  playingId = item.id; silent = false;
  markOurPause();
  a.loop = false;
  a.src = '/audio/' + item.id;
  loadVideo(document.hidden ? null : item.id);
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
  if (!v.getAttribute('src')) loadVideo(playingId);
  v.currentTime = a.currentTime;
  if (!a.paused) playVideo();
});

// ---------- Controls ----------
const paint = el => el.style.setProperty('--p', ((+el.value / (+el.max || 1)) * 100) + '%');
let songGain = 1;
const applyVolume = () => { a.volume = Math.min(1, Math.max(0, +vol.value * songGain)); };
let preMute = null;
try { vol.value = localStorage.getItem('vol') ?? 1; } catch { vol.value = 1; }
try { if (localStorage.getItem('muted') === '1') { preMute = +vol.value || 1; a.muted = true; vol.value = 0; } } catch {}
applyVolume(); paint(vol);
vol.oninput = () => {
  preMute = null;
  applyVolume(); paint(vol);
  if (a.muted) unmute();
  try { localStorage.setItem('vol', vol.value); } catch {}
};

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
    try { localStorage.setItem('muted', '1'); } catch {}
  }
}
a.onvolumechange = () => ($('muteBtn').innerHTML = icon(a.muted || a.volume === 0 ? 'mute' : 'vol'));

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

let pausedBy = '';
function updatePP() {
  $('pp').innerHTML = icon(serverPaused ? 'play' : 'pause');
  $('pausedCard').hidden = !(serverPaused && $('idle').hidden);
  $('pausedBy').innerHTML = pausedBy ? `Paused by ${avatar(pausedBy)} ${nameTag(pausedBy)}` : 'Paused';
}
function togglePause() {
  serverPaused = !serverPaused;
  heldLocally = false;
  if (serverPaused) { pausedBy = myName; pauseBoth(); post('/pause'); } else { tryPlay(); post('/play'); }
  updatePP();
}
updatePP();

// ---------- Click the video to pause or play ----------
let clickTimer = null, controlsWereAway = false;
$('player').addEventListener('pointerdown', () => { controlsWereAway = document.body.classList.contains('uiAway'); });
$('player').addEventListener('click', e => {
  if (e.target.closest('button') || !$('idle').hidden || controlsWereAway) return;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(togglePause, 250);
});
$('player').addEventListener('dblclick', () => clearTimeout(clickTimer));

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
    if (!isFs()) return;
    const keep = serverPaused || !playingId || document.querySelector('.now:hover, .controls:hover, #reactPop:not([hidden])');
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
      title: cur.title, artist: (cur.channel ? cur.channel + ' · ' : '') + 'added by ' + cur.by, album: 'Couchwave',
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
