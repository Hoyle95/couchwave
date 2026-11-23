// ---------- Preloaded into a test server: writing to files fails like a full disk while a file called disk-full exists ----------
const fs = require('fs');
const write = fs.WriteStream.prototype.write;
fs.WriteStream.prototype.write = function (...args) {
  if (!fs.existsSync('disk-full')) return write.apply(this, args);
  process.nextTick(() => this.emit('error', Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })));
  return false;
};
