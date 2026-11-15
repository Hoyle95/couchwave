// Stand-in for yt-dlp in the tests: acts like it in a split second, without YouTube. What it does depends
// on the video id in the link (an id is 11 characters):
//   fail_perm.. -> "Video unavailable" (a permanent failure)    fail_temp.. -> "HTTP Error 403" (temporary)
//   live_...... -> a livestream (filtered out: exits 0, prints nothing)
//   slow_...... -> takes 5 seconds                               shrt_...... -> a 3-second song
//   nolen...... -> YouTube doesn't say how long it is (the server asks ffprobe)
//   uni_....... -> a title with characters from outside English ("Café – Déjà Vu 🎵")
//   anything else -> a 200-second song called "Song <id>"
// Search ("ytsearch3:<words>"): a livestream first, then two songs (ids from the words: "daft punk" ->
// L/1/2 + "daftpunk00", e.g. "1daftpunk00" for the top song); "nothing" finds nothing; anything with
// "slow" in it takes 1.5 seconds; "a-ha Take On Me" comes back with a different a-ha song first (as YouTube
// once did).
// Playlists (a link with list=): four entries, one of them private.
// Like the real one on Windows, titles only come out right with --encoding utf-8: without it, anything
// outside plain English letters comes out as "�".
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
  const row = (id, duration, title, playlist = 'NA') => console.log(text([id, duration, title, playlist].join('\t')));
  const q = target.replace(/^ytsearch\d*:/, '');
  setTimeout(() => {
    if (!target.startsWith('ytsearch')) {
      row('plist_00001', '100', 'Playlist song 1', 'Test Playlist');
      row('plist_00002', '110', '[Private video]', 'Test Playlist');
      row('plist_00003', '120', 'Playlist song 3', 'Test Playlist');
      row('plist_00004', '130', 'Playlist song 4', 'Test Playlist');
    } else if (q === 'a-ha Take On Me') {
      row('aha_sun0001', '254', 'a-ha - The Sun Always Shines on T.V. (Official Video)');
      row('aha_take001', '244', 'a-ha - Take On Me (Official Video) [4K]');
      row('aha_live001', '325', 'A-ha Take On Me live 2017');
    } else if (q !== 'nothing') {
      const id = first => (first + q.replace(/\W/g, '') + '0000000000').slice(0, 11); // e.g. "1daftpunk00"
      row(id('L'), 'NA', `${q} (live)`);
      row(id('1'), '180', `${q} - top result`);
      row(id('2'), '200', `${q} - second result`);
    }
    process.exit(0);
  }, /slow/.test(q) ? 1500 : 0);
} else {
  // A download: -o <file> ... -- <url>
  const out = args[args.indexOf('-o') + 1];
  const id = idOf(target);
  const finish = () => {
    if (id.startsWith('fail_perm')) { console.error(`ERROR: [youtube] ${id}: Video unavailable`); process.exit(1); }
    if (id.startsWith('fail_temp')) { console.error('ERROR: unable to download video data: HTTP Error 403: Forbidden'); process.exit(1); }
    if (id.startsWith('live_')) process.exit(0);
    fs.writeFileSync(out, Buffer.alloc(64 * 1024, 7)); // a pretend mp4
    const duration = id.startsWith('shrt_') ? 3 : id.startsWith('nolen') ? 'NA' : 200;
    console.log(text(`${duration}|${id.startsWith('uni_') ? 'Café – Déjà Vu 🎵' : `Song ${id}`}`));
    process.exit(0);
  };
  setTimeout(finish, id.startsWith('slow_') ? 5000 : 50);
}
