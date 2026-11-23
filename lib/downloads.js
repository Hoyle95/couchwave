// ---------- Reading YouTube ----------
const fs = require('fs');
const path = require('path');
const { DL, secs } = require('./common');
const { logOut } = require('./log');
const { PREFETCH, MAX_DOWNLOADS, MAX_SECONDS, tooLong, COOKIES } = require('./settings');
const { TOOL_LIMIT, run, killTree } = require('./tools');
const room = require('./room');
const songs = require('./songs');

function listSongs(target, max, cb) {
  const p = run('yt-dlp', [
    '--encoding', 'utf-8',
    '--flat-playlist', '--yes-playlist', '--playlist-end', String(max),
    '--print', '%(id)s\t%(duration)s\t%(title)s\t%(playlist_title)s', ...COOKIES, '--', target,
  ], secs(120), `yt-dlp reading ${target}`);
  let stdout = '', finished = false;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => (stdout += d));
  p.stderr.on('data', d => logOut(d));
  const finish = () => {
    if (finished) return;
    finished = true;
    const found = [];
    for (const line of stdout.split('\n')) {
      const [id, duration, title, playlist] = line.trim().split('\t');
      if (!/^[\w-]{11}$/.test(id || '') || /^\[(Private|Deleted|Unavailable) video\]$/.test(title)) continue;
      found.push({ id, duration: parseFloat(duration) || 0, title: title || id, playlist: playlist && playlist !== 'NA' ? playlist : '' });
    }
    cb(found);
  };
  p.on('error', finish);
  p.on('close', finish);
}

// ---------- Disk space ----------
function cleanup() {
  const keep = [room.current, ...room.queue, ...room.trashed()].filter(Boolean)
    .map(q => (q.status === 'downloading' ? q.out : q.file))
    .filter(Boolean).map(f => path.basename(f, '.mp4'));
  for (const f of fs.readdirSync(DL)) {
    if (!keep.some(k => f.startsWith(k))) fs.rm(path.join(DL, f), { force: true }, () => {});
  }
}
const MIN_FREE = 2 * 1024 ** 3;
let diskFull = false;
function freeSpace() {
  if (process.env.COUCHWAVE_FAKE_FREE_DISK) return Number(process.env.COUCHWAVE_FAKE_FREE_DISK);
  try { const s = fs.statfsSync(DL); return s.bavail * s.bsize; } catch { return Infinity; }
}
function roomOnDisk() {
  const full = freeSpace() < MIN_FREE;
  if (full !== diskFull) {
    diskFull = full;
    const text = full ? 'paused downloads: this computer has less than 2 GB of disk space left' : 'downloads are back on: there is enough disk space again';
    room.addLog('server', text);
    logOut(text);
    room.dirty = true;
  }
  return !full;
}

// ---------- Downloads ----------
const running = new Map();
function pump() {
  if (!roomOnDisk()) return;
  const queue = room.queue;
  for (const [i, q] of queue.slice(0, PREFETCH).entries()) {
    if (q.status !== 'waiting') continue;
    if (running.size >= MAX_DOWNLOADS) {
      const lowest = [...running.keys()].map(id => queue.find(x => x.id === id)).filter(Boolean)
        .sort((a, b) => queue.indexOf(b) - queue.indexOf(a))[0];
      if (!lowest || queue.indexOf(lowest) < i) break;
      stopDownload(lowest);
    }
    download(q);
  }
}
function stopDownload(item) {
  const proc = running.get(item.id);
  if (proc) killTree(proc);
  running.delete(item.id);
  item.out = null;
  item.status = 'waiting';
  room.dirty = true;
}

function failReason(err) {
  const msg = ((err.match(/ERROR: .*/g) || []).pop() || '').replace(/^ERROR: (\[\w+\] [\w-]+: )?/, '');
  if (/confirm your age|age.restricted|inappropriate/i.test(msg)) return ['Age-restricted', true];
  if (/private video/i.test(msg)) return ['Private video', true];
  if (/unavailable|has been removed|not available|does not exist|terminated/i.test(msg)) return ['Unavailable', true];
  if (/members.only|join this channel/i.test(msg)) return ['Members only', true];
  if (/HTTP Error 403/i.test(msg)) return ['Blocked by YouTube (403)', false];
  if (/HTTP Error 429|too many requests/i.test(msg)) return ['YouTube rate limit', false];
  if (/not a bot|please sign in|protect our community/i.test(msg)) return ['YouTube bot check', false];
  return [msg.slice(0, 80) || 'Download error', false];
}
function failed(item, reason, permanent) {
  item.status = 'failed';
  item.error = reason;
  item.tries = (item.tries || 0) + 1;
  const patient = /bot check|rate limit/.test(reason);
  if (!permanent && item.tries <= 2) { item.retryAt = Date.now() + (patient ? secs(item.tries === 1 ? 60 : 300) : 10000 * item.tries); return; }
  item.retryAt = null;
  if (songs.isDjSong(item) && room.queue.includes(item)) return songs.removeFromQueue(item, songs.DJ_NAME, `dropped "${item.title}": it couldn't be downloaded (${reason})`);
  room.addLog(item.by, `couldn't download "${item.title}" (${reason})`);
}

function probeDuration(file, cb) {
  const p = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], TOOL_LIMIT);
  let out = '', fin = false;
  const end = () => { if (fin) return; fin = true; cb(parseFloat(out) || 0); };
  p.stdout.on('data', d => (out += d));
  p.on('error', end);
  p.on('close', end);
}

// ---------- Loudness ----------
const TARGET_LUFS = -14;
const MEASURE = ['-map', '0:a:0', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'];
function gainFrom(ffmpegOutput) {
  const lufs = parseFloat((/I:\s+(-?[\d.]+) LUFS/.exec(ffmpegOutput) || [])[1]);
  return Number.isFinite(lufs) ? Math.max(0.1, Math.min(1, Math.round(10 ** ((TARGET_LUFS - lufs) / 20) * 1000) / 1000)) : 1;
}
function measureLoudness(item) {
  const file = item.audio || item.file;
  if (!file || item.gain != null) return;
  const p = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, ...MEASURE], TOOL_LIMIT);
  let err = '', fin = false;
  p.stderr.on('data', d => (err = (err + d).slice(-8000)));
  const end = () => { if (fin) return; fin = true; item.gain = gainFrom(err); room.dirty = true; };
  p.on('error', end);
  p.on('close', end);
}

// ---------- Downloading one song ----------
const STALL_AFTER = secs(300);
function download(item) {
  const out = path.join(DL, `${item.id}-${Date.now()}.mp4`);
  item.out = out;
  item.status = 'downloading';
  room.dirty = true;
  const p = run('yt-dlp', [
    '--encoding', 'utf-8',
    '--no-playlist', '--playlist-items', '1',
    '--no-progress', '--match-filter', '!is_live',
    '--break-match-filters', `duration <=? ${MAX_SECONDS}`,
    '-S', 'res:720,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4',
    '-o', out, '--print', 'after_move:%(duration)s|%(title)s', ...COOKIES, '--', item.url,
  ]);
  running.set(item.id, p);
  const prefix = path.basename(out, '.mp4');
  let stdout = '', stderr = '', done = false, size = -1, grewAt = Date.now(), stalled = false;
  const watch = setInterval(() => {
    let now = 0;
    try { for (const f of fs.readdirSync(DL)) if (f.startsWith(prefix)) now += fs.statSync(path.join(DL, f)).size; } catch {}
    if (now !== size) { size = now; grewAt = Date.now(); return; }
    if (Date.now() - grewAt < STALL_AFTER) return;
    stalled = true;
    clearInterval(watch);
    logOut(`downloading ${item.url} stalled (nothing new for ${Math.round(STALL_AFTER / secs(60))} minutes): stopped`);
    killTree(p);
  }, secs(15));
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => (stdout += d));
  p.stderr.on('data', d => { logOut(d); stderr = (stderr + d).slice(-4000); });
  const finish = code => {
    clearInterval(watch);
    if (done) return;
    done = true;
    if (item.removed || item.out !== out) return pump();
    running.delete(item.id);
    room.dirty = true;
    const line = stdout.trim().split('\n').pop() || '';
    const i = line.indexOf('|');
    if (code !== 0 || i < 0) {
      if (stalled) failed(item, 'Download stalled', false);
      else if (code === 0) failed(item, "Livestreams aren't supported", true);
      else if (code === 101) songs.dropTooLong(item);
      else failed(item, ...failReason(stderr));
      return pump();
    }
    item.error = null; item.tries = 0;
    item.duration = parseFloat(line.slice(0, i)) || 0;
    item.title = line.slice(i + 1);
    const entry = room.log.find(e => e.id === item.id);
    if (entry) { entry.text = `added "${item.title}"`; room.logRev++; }
    item.file = out;
    const audio = out.replace(/\.mp4$/, '.m4a');
    const ffmpeg = (args, then) => {
      const f = run('ffmpeg', args, TOOL_LIMIT);
      let err = '', fin = false;
      f.stderr.on('data', d => (err = (err + d).slice(-8000)));
      const end = code => { if (fin) return; fin = true; if (code !== 0) logOut(err); then(code === 0, err, f.timedOut); };
      f.on('error', () => end(-1));
      f.on('close', end);
    };
    let fDone = false;
    const ready = ok => {
      if (fDone) return;
      fDone = true;
      if (item.out !== out) return;
      if (ok) item.audio = audio;
      const isReady = () => {
        if (item.out !== out) return;
        if (!item.duration) { failed(item, "Couldn't read the video length", true); return pump(); }
        if (tooLong(item)) {
          fs.rm(out, () => {}); if (item.audio) fs.rm(item.audio, () => {});
          delete item.file; delete item.audio;
          songs.dropTooLong(item); return pump();
        }
        item.status = 'ready';
        room.dirty = true;
        measureLoudness(item);
        pump();
      };
      if (item.duration) isReady();
      else probeDuration(out, d => { item.duration = d; isReady(); });
    };
    ffmpeg(['-y', '-hide_banner', '-nostats', '-i', out, '-map', '0:a:0', '-c:a', 'copy', audio, ...MEASURE], (ok, err, timedOut) => {
      if (ok) { item.gain = gainFrom(err); return ready(true); }
      if (timedOut) { item.gain = 1; return ready(false); }
      ffmpeg(['-y', '-loglevel', 'error', '-i', out, '-vn', '-c:a', 'copy', audio], ready);
    });
    pump();
  };
  p.on('error', () => finish(-1));
  p.on('close', finish);
}

Object.assign(exports, { running, listSongs, cleanup, isDiskFull: () => diskFull, pump, stopDownload, measureLoudness });
