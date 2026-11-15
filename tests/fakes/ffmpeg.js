// Stand-in for ffmpeg in the tests: "copies the audio track" (-i <video> ... <audio file>) as a small file.
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(args[args.length - 1], Buffer.alloc(8 * 1024, 3));
