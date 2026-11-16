// ---------- Stand-in for ffmpeg ----------
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('copy')) fs.writeFileSync(args[args.indexOf('copy') + 1], Buffer.alloc(8 * 1024, 3));
if (args.includes('-af')) console.error('[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:          -8.0 LUFS\n    Threshold: -18.0 LUFS');
