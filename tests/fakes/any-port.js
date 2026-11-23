// ---------- Any free port ----------
const http = require('http');
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, ...rest) { return listen.call(this, 0, ...rest); };
