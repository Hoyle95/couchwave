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
    if (!r || !r.ok) {
      const why = await failText(r);
      if (/^(That link looks cut off|Not a YouTube link)/.test(why) && input.value.trim() === link) { input.value = ''; input.focus(); }
      return notice(why);
    }
    if (input.value.trim() === link) input.value = '';
    poll();
  } finally { adding = false; }
}

// ---------- Queue, Activity and History ----------
let nowUrl = '';
function copyBox(url) {
  const modal = $('copyModal'), input = $('copyText'), back = document.activeElement;
  input.value = url;
  modal.hidden = false;
  input.focus();
  input.select();
  const close = () => {
    modal.hidden = true;
    document.removeEventListener('keydown', onKey);
    if (back && back.focus) back.focus();
  };
  const onKey = e => { if (e.key === 'Escape' || (e.key === 'Enter' && e.target === input)) close(); };
  document.addEventListener('keydown', onKey);
  input.onclick = () => input.select();
  input.oncopy = () => setTimeout(close, 300);
  $('copyDone').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
}
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
  if (!ok) return copyBox(url);
  b.classList.add('done'); b.innerHTML = icon('check'); b.title = 'Copied!';
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.classList.remove('done'); b.innerHTML = icon('copy'); b.title = 'Copy the YouTube link'; }, 1500);
}
const undoSeen = {};
$('log').onclick = e => {
  const b = e.target.closest('.undo');
  if (b && Date.now() - (undoSeen[b.dataset.undo] || 0) < 1500) return;
  if (b) { b.disabled = true; b.textContent = '…'; post('/undo', { id: +b.dataset.undo }).then(r => { if (!r || !r.ok) { b.disabled = false; b.textContent = 'Undo'; } return poll(); }); }
};
$('history').onclick = e => {
  const copy = e.target.closest('.copy'), again = e.target.closest('.requeue'), like = e.target.closest('.like');
  if (copy) copyLink(copy.dataset.url, copy);
  if (again) requeue(again);
  if (like && !like.disabled) {
    like.disabled = true;
    post('/like', { url: like.dataset.url, t: +like.dataset.t, like: !like.classList.contains('on') }).then(poll).finally(() => { like.disabled = false; });
  }
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
  if (!r || !r.ok) { reset(); return notice(await failText(r)); }
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
const redrawQueue = r => { if (!r || !r.ok) lastQueue = ''; return poll(); };
$('queue').onclick = e => {
  const copy = e.target.closest('.copy');
  if (copy) return copyLink(copy.dataset.url, copy);
  const again = e.target.closest('.retry');
  if (again) { again.disabled = true; return post('/retry', { id: +again.closest('li').dataset.id }).then(redrawQueue); }
  const del = e.target.closest('.del');
  if (!del) return;
  if (!del.dataset.mine) {
    const vote = !del.dataset.voted;
    del.dataset.voted = vote ? '1' : ''; del.classList.toggle('voted', vote);
    return post('/remove', { id: +del.closest('li').dataset.id, vote }).then(redrawQueue);
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

function queueTimes(s) {
  const now = Date.now(), starts = [];
  let at = s.current ? Math.max(0, (s.current.duration || 0) - s.elapsed) : 0, sure = !s.paused, total = 0, unknown = false;
  for (const q of s.queue) {
    if (q.status === 'failed') { starts.push(null); continue; }
    starts.push(sure ? now + at * 1000 : null);
    if (q.duration > 0) { total += q.duration; at += q.duration; } else { unknown = true; sure = false; }
  }
  return { starts, total, unknown, ends: sure && total ? now + at * 1000 : null };
}

function whenPlayed(t) {
  const d = new Date(t), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  return days === 0 ? hhmm(t) : days === 1 ? 'Yesterday ' + hhmm(t)
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hhmm(t);
}
const ytThumbSmall = url => ytThumb(url).replace('/hqdefault.', '/mqdefault.');
function likeButton(h) {
  const mine = h.liked === true;
  const tip = mine ? 'You liked it, so the DJ finds more like it. Click to take it back' : 'Like it, and the DJ finds more like it';
  return `<button class="ghost like${mine ? ' on' : ''}" data-url="${esc(h.url)}" data-t="${h.t}" aria-pressed="${mine}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon('thumb')}</button>`;
}
function drawHistory() {
  $('historyCount').textContent = historyList.length;
  const html = historyList.map(h => `
    <li>
      <a href="${esc(h.url)}" target="_blank" rel="noopener" title="Open on YouTube"><img class="hthumb" src="${esc(ytThumbSmall(h.url))}" alt="" loading="lazy" referrerpolicy="no-referrer">${h.duration > 0 ? `<span class="hlen" title="How long it is">${fmt(h.duration)}</span>` : ''}</a>
      <span class="htitle" title="${esc(h.title)}${h.channel ? ` by ${esc(h.channel)}` : ''}">${esc(h.title)}${byChannel(h)}</span>
      <span class="hmeta">${avatar(h.by)} ${nameTag(h.by)}<span class="hbtns">${h.by === DJ_NAME ? likeButton(h) : ''}<button class="ghost copy" data-url="${esc(h.url)}" title="Copy the YouTube link" aria-label="Copy the YouTube link">${icon('copy')}</button><button class="ghost requeue" data-url="${esc(h.url)}" title="Add it to the queue again" aria-label="Add it to the queue again">${icon('plus')}</button></span></span>
      <span class="hmeta htime"><span class="hwhen" title="When it played">${icon('clock')}${whenPlayed(h.t)}</span></span>
    </li>`).join('') || '<li class="empty">Nothing played yet</li>';
  if (html !== lastHistory) { $('history').innerHTML = html; lastHistory = html; }
}

function drawLog() {
  const lines = logList.map(e =>
    `<li><span class="time">${hhmm(e.t)}</span><span>${e.by ? `${nameTag(e.by, 'b')} ` : ''}${esc(e.text)}</span>${e.undo && e.by === myName ? (undoSeen[e.undo] = undoSeen[e.undo] || Date.now(), `<button class="ghost undo" data-undo="${+e.undo}" title="Put it back in the queue">Undo</button>`) : ''}</li>`);
  drawList($('log'), lines.length ? lines : ['<li class="empty">Nothing yet</li>']);
  stickLog();
}
const QUEUE_BADGE = { ready: 'Ready', downloading: 'Downloading', waiting: 'Waiting', failed: 'Failed', searching: 'Searching' };
