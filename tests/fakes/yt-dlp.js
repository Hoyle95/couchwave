// Stand-in for yt-dlp in the tests: acts like it in a split second, without YouTube. What it does depends
// on the video id in the link (an id is 11 characters):
//   fail_perm.. -> "Video unavailable" (a permanent failure)    fail_temp.. -> "HTTP Error 403" (temporary)
//   live_...... -> a livestream (filtered out: exits 0, prints nothing)
//   slow_...... -> takes 5 seconds                               shrt_...... -> a 3-second song
//   nolen...... -> YouTube doesn't say how long it is (the server asks ffprobe)
//   anything else -> a 200-second song called "Song <id>"
// Search ("ytsearch3:<words>"): a livestream first, then two songs; "nothing" finds nothing.
// Playlists (a link with list=): four entries, one of them private.
const fs = require('fs');
const args = process.argv.slice(2);
const target = args[args.length - 1];
const idOf = url => (/[?&]v=([\w-]{11})/.exec(url) || /youtu\.be\/([\w-]{11})/.exec(url) || [])[1] || 'unknownid00';

if (args.includes('-U')) {
  console.log('yt-dlp is up to date (stable@2026.10.26 from yt-dlp/yt-dlp)');
  process.exit(0);
}

if (args.includes('--flat-playlist')) {
  const row = (id, duration, title, playlist = 'NA') => console.log([id, duration, title, playlist].join('\t'));
  if (target.startsWith('ytsearch')) {
    const q = target.replace(/^ytsearch\d*:/, '');
    if (q !== 'nothing') {
      row('live_search', 'NA', `${q} (live)`);
      row('found_00001', '180', `${q} - top result`);
      row('found_00002', '200', `${q} - second result`);
    }
  } else {
    row('plist_00001', '100', 'Playlist song 1', 'Test Playlist');
    row('plist_00002', '110', '[Private video]', 'Test Playlist');
    row('plist_00003', '120', 'Playlist song 3', 'Test Playlist');
    row('plist_00004', '130', 'Playlist song 4', 'Test Playlist');
  }
  process.exit(0);
}

// A download: -o <file> ... -- <url>
const out = args[args.indexOf('-o') + 1];
const id = idOf(target);
const finish = () => {
  if (id.startsWith('fail_perm')) { console.error(`ERROR: [youtube] ${id}: Video unavailable`); process.exit(1); }
  if (id.startsWith('fail_temp')) { console.error('ERROR: unable to download video data: HTTP Error 403: Forbidden'); process.exit(1); }
  if (id.startsWith('live_')) process.exit(0);
  fs.writeFileSync(out, Buffer.alloc(64 * 1024, 7)); // a pretend mp4
  const duration = id.startsWith('shrt_') ? 3 : id.startsWith('nolen') ? 'NA' : 200;
  console.log(`${duration}|Song ${id}`);
  process.exit(0);
};
setTimeout(finish, id.startsWith('slow_') ? 5000 : 50);
