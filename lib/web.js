// ---------- Sending songs ----------
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WEB } = require('./common');

const PACE_BURST = 20, PACE_SPEEDUP = 3, PACE_MIN = 256 * 1024;
async function paced(stream, res, rate, burst) {
  let credit = burst, last = Date.now();
  res.on('close', () => stream.destroy());
  const drained = () => new Promise(r => {
    const go = () => { res.off('drain', go); res.off('close', go); r(); };
    res.on('drain', go); res.on('close', go);
  });
  try {
    for await (const chunk of stream) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await drained();
      const now = Date.now();
      credit = Math.min(credit + (now - last) / 1000 * rate, Math.max(credit, rate)) - chunk.length;
      last = now;
      if (credit < 0) await new Promise(r => setTimeout(r, -credit / rate * 1000));
    }
    res.end();
  } catch { res.destroy(); }
}

function sendFile(req, res, file, type, duration) {
  if (!file) { res.writeHead(404); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    const size = st.size;
    const bitrate = duration > 0 ? size / duration : 0;
    const send = (opts) => {
      const stream = fs.createReadStream(file, opts);
      if (!bitrate) return stream.on('error', () => res.destroy()).pipe(res);
      paced(stream, res, Math.max(PACE_MIN, bitrate * PACE_SPEEDUP), bitrate * PACE_BURST);
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      return send();
    }
    let start, end;
    if (!m[1]) { start = Math.max(0, size - +m[2]); end = size - 1; }
    else { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    send({ start, end });
  });
}

// ---------- Sending the page ----------
const STATIC_TYPES = {
  '.html': ['text/html; charset=utf-8', 'no-cache'], '.css': ['text/css; charset=utf-8', 'no-cache'],
  '.js': ['text/javascript; charset=utf-8', 'no-cache'],
  '.png': ['image/png', 'max-age=86400'], '.woff2': ['font/woff2', 'max-age=2592000'],
};
const packed = new Map();
const encodingFor = req => { const a = String(req.headers['accept-encoding'] || ''); return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : null; };
function sendStatic(req, res, name, headers = {}) {
  const [type, cache] = STATIC_TYPES[path.extname(name)];
  const file = path.join(WEB, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const base = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding', ...headers };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end(); }
    if (!type.startsWith('text/')) {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    const send = p => {
      const enc = encodingFor(req), body = enc ? p[enc] : p.raw;
      res.writeHead(200, { ...base, 'Content-Length': body.length, ...(enc ? { 'Content-Encoding': enc } : {}) });
      res.end(body);
    };
    const p = packed.get(name);
    if (p && p.etag === etag) return send(p);
    fs.readFile(file, (err, raw) => {
      if (err) { res.writeHead(404); return res.end(); }
      const fresh = { etag, raw, gzip: zlib.gzipSync(raw, { level: 9 }), br: zlib.brotliCompressSync(raw) };
      packed.set(name, fresh);
      send(fresh);
    });
  });
}

const MANIFEST = JSON.stringify({
  name: 'Couchwave', short_name: 'Couchwave', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#0c0c11', theme_color: '#0c0c11',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

// ---------- Security headers ----------
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'", "img-src 'self' data: https://i.ytimg.com", "media-src 'self' blob:",
  "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
};

// ---------- JSON ----------
function sendJson(req, res, obj) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  let body = Buffer.from(JSON.stringify(obj));
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}
function readJson(req, max, cb) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', d => { body += d; if (body.length > max) req.destroy(); });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch {}
    try { cb(data && typeof data === 'object' && !Array.isArray(data) ? data : {}); } catch (err) { req.failed(err); }
  });
}

Object.assign(exports, { sendFile, sendStatic, MANIFEST, SECURITY_HEADERS, sendJson, readJson });
