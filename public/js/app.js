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
      ${q.held ? '<span class="badge failed" title="Downloads are paused: the computer running Couchwave is nearly out of disk space">Disk full</span>'
        : q.status === 'failed' && q.retrying ? '<span class="badge downloading" title="Trying again in a moment">Retrying</span>'
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
  gifs = s.gifs || null;
  $('gifBtn').hidden = !gifs;
  if (s.version && $('version').textContent !== `v${s.version}`) $('version').textContent = `v${s.version}`;
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
  const by = s.current.by, mySong = by === myName, alone = s.users.length === 1 && s.users[0] === myName;
  const ownerAway = by !== DJ_NAME && !s.users.includes(by), canSeek = mySong || ownerAway || alone;
  const seekTitle = mySong ? 'Move through your song (for everyone)'
    : ownerAway ? `${by} isn't here, so anyone can move through their song`
    : alone ? 'Move through the song (you\'re the only one here)'
    : by === DJ_NAME ? 'The DJ\'s songs can only be moved when you\'re the only one here'
    : `Only ${by} can move through their song while they're here`;
  if (seek.disabled === canSeek || seek.title !== seekTitle) {
    seek.disabled = !canSeek;
    seek.title = seekTitle;
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

// ---------- Buttons and forms ----------
const ACTIONS = {
  add, join, logout, sendChat, skip, toggleAudioOnly, toggleChat, toggleChatMute, toggleColorPop, toggleEmoji, toggleGifs,
  toggleFs, toggleMute, togglePause, toggleReactPop, toggleTheme, unmute,
  togglePw: (e, el) => togglePw(el),
  copyNow: (e, el) => copyLink(nowUrl, el),
};
for (const [attr, type] of [['click', 'click'], ['submit', 'submit'], ['dblclick', 'dblclick']]) {
  for (const el of document.querySelectorAll(`[data-${attr}]`)) el.addEventListener(type, e => ACTIONS[el.dataset[attr]](e, el));
}
for (const el of document.querySelectorAll('[data-enter]')) el.addEventListener('keydown', e => { if (e.key === 'Enter') ACTIONS[el.dataset.enter](e, el); });
for (const el of document.querySelectorAll('[data-keep-focus]')) el.addEventListener('mousedown', e => e.preventDefault());

// ---------- Starting: logged in already, or the join screen ----------
(async () => {
  if ((await fetch('/state').catch(() => null))?.ok) return enter();
  const room = await fetch('/room').then(r => r.json()).catch(() => ({}));
  if (room.public) { $('roomGroup').style.display = 'none'; $('pw').required = false; }
  showHostTip(room.home);
  $('name').value = getCookie('name');
  $('joinAvWrap').appendChild($('colorPop'));
  $('join').appendChild($('footer'));
  previewMe();
  $('name').oninput = previewMe;
  $('join').hidden = false;
})();
