// ---------- Stand-in for yt-dlp ----------
const fs = require('fs');
const args = process.argv.slice(2);
const target = args[args.length - 1];
const idOf = url => (/[?&]v=([\w-]{11})/.exec(url) || /youtu\.be\/([\w-]{11})/.exec(url) || [])[1] || 'unknownid00';
const utf8 = args[args.indexOf('--encoding') + 1] === 'utf-8' && args.includes('--encoding');
const text = t => (utf8 ? t : t.replace(/[^\x00-\x7e]/gu, '�'));

if (args.includes('-U')) {
  console.log('yt-dlp is up to date (stable@2026.10.26 from yt-dlp/yt-dlp)');
  process.exit(0);
}

if (args.includes('--flat-playlist')) {
  const max = Number(args[args.indexOf('--playlist-end') + 1]) || Infinity;
  let rows = 0;
  const row = (id, duration, title, playlist = 'NA') => { if (rows++ < max) console.log(text([id, duration, title, playlist].join('\t'))); };
  const q = target.replace(/^ytsearch\d*:/, '');
  setTimeout(() => {
    const mix = /[?&]list=RD([\w-]{11})/.exec(target);
    if (mix) fs.appendFileSync('mix-requests.log', mix[1] + '\n');
    if (mix && mix[1].startsWith('nomx')) {
      console.error(`WARNING: [youtube:tab] Unable to recognize playlist. Downloading just video ${mix[1]}`);
      row(mix[1], '30', `Not music ${mix[1]}`);
    } else if (mix) {
      const seed = mix[1], hash = require('crypto').createHash('md5').update(seed).digest('hex'), id = n => (n + hash).slice(0, 11);
      row(seed, '200', `Song ${seed}`);
      row(id('a'), '210', `Song ${seed} - B side`);
      row(id('b'), '190', `Other Band - Fresh Pick ${seed}`);
      row(id('c'), '3600', `Other Band - Full Album ${seed}`);
      row(id('d'), '30', `Jingle - Too Short ${seed}`);
      row(id('e'), '220', `Third Act - Another One ${seed}`);
    } else if (/[?&]list=PLbig/.test(target)) {
      for (let i = 1; i <= 150; i++) row(`bigp_${String(i).padStart(6, '0')}`, '200', `Big song ${i}`, 'Big Playlist');
    } else if (!target.startsWith('ytsearch')) {
      row('plist_00001', '100', 'Playlist song 1', 'Test Playlist');
      row('plist_00002', '110', '[Private video]', 'Test Playlist');
      row('plist_00003', '120', 'Playlist song 3', 'Test Playlist');
      row('plist_00004', '130', 'Playlist song 4', 'Test Playlist');
      row('plist_long1', '14400', 'Playlist song 5 (4 hours)', 'Test Playlist');
    } else if (q === 'a-ha Take On Me') {
      row('aha_sun0001', '254', 'a-ha - The Sun Always Shines on T.V. (Official Video)');
      row('aha_take001', '244', 'a-ha - Take On Me (Official Video) [4K]');
      row('aha_live001', '325', 'A-ha Take On Me live 2017');
    } else if (q !== 'nothing') {
      const id = first => (first + q.replace(/\W/g, '') + '0000000000').slice(0, 11);
      row(id('L'), 'NA', `${q} (live)`);
      row(id('1'), /long/.test(q) ? '14400' : '180', `${q} - top result`);
      row(id('2'), '200', `${q} - second result`);
    }
    process.exit(0);
  }, /slow/.test(q) ? 1500 : 0);
} else {
  const out = args[args.indexOf('-o') + 1];
  const id = idOf(target);
  const part = out + '.part';
  try { fs.writeFileSync(part, ''); } catch {}
  const finish = () => {
    fs.rmSync(part, { force: true });
    if (id.startsWith('fail_perm')) { console.error(`ERROR: [youtube] ${id}: Video unavailable`); process.exit(1); }
    if (id.startsWith('fail_sign')) { console.error(`ERROR: [youtube] ${id}: Please sign in. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.`); process.exit(1); }
    if (id.startsWith('fail_temp')) { console.error('ERROR: unable to download video data: HTTP Error 403: Forbidden'); process.exit(1); }
    if (id.startsWith('live_')) process.exit(0);
    const duration = id.startsWith('shrt_') ? 3 : id.startsWith('nolen') ? 'NA' : id.startsWith('long_') ? 14400 : 200;
    const max = /^duration <=? (d+)$/.exec(args[args.indexOf('--break-match-filters') + 1] || '');
    if (args.includes('--break-match-filters') && max && typeof duration === 'number' && duration > +max[1]) process.exit(101);
    fs.writeFileSync(out, Buffer.alloc(64 * 1024, 7));
    console.log(text(`${duration}|${id.startsWith('uni_') ? 'Café – Déjà Vu 🎵' : `Song ${id}`}`));
    process.exit(0);
  };
  setTimeout(finish, id.startsWith('slow_') ? 1500 : 50);
}
