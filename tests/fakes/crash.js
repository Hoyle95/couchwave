// ---------- Preloaded into a test server: crashes it when a file called crash-now appears ----------
const fs = require('fs');
const path = require('path');

setInterval(() => {
  if (!fs.existsSync('crash-now')) return;
  fs.rmSync('crash-now');
  require(path.join(process.cwd(), 'lib', 'room.js')).addChat('Alice', 'said just before the crash');
  throw new Error('a crash, on purpose');
}, 20).unref();
