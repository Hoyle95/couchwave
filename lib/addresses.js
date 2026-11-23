// ---------- Visitors' addresses ----------
const net = require('net');
const os = require('os');
const { IN_CONTAINER } = require('./common');
const { config } = require('./settings');
const { logOut } = require('./log');

const subnets = list => { const b = new net.BlockList(); for (const [ip, bits] of list) b.addSubnet(ip, bits, net.isIPv6(ip) ? 'ipv6' : 'ipv4'); return b; };
const PRIVATE = [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10],
  ['::1', 128], ['fc00::', 7], ['fe80::', 10]];
const CLOUDFLARE = subnets([
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22], ['141.101.64.0', 18], ['108.162.192.0', 18],
  ['190.93.240.0', 20], ['188.114.96.0', 20], ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
  ['2400:cb00::', 32], ['2606:4700::', 32], ['2803:f800::', 32], ['2405:b500::', 32], ['2405:8100::', 32], ['2a06:98c0::', 29], ['2c0f:f248::', 32],
]);
const plainIp = ip => String(ip || '').trim().replace(/^\[([^\]]*)\](:\d+)?$/, '$1').replace(/%.*$/, '')
  .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
const inside = (list, ip) => net.isIP(ip) > 0 && list.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');

function trustedProxies() {
  const v = config.trustProxy;
  if (v == null || v === true) return PRIVATE;
  if (v === false) return [];
  const extra = (Array.isArray(v) ? v : [null]).map(e => {
    const [ip, bits, more] = String(e ?? '').split('/').map((x, i) => (i ? x : plainIp(x)));
    const max = net.isIPv6(ip) ? 128 : 32;
    if (!net.isIP(ip) || more !== undefined || (bits !== undefined && !/^\d+$/.test(bits)) || +(bits ?? max) > max) return null;
    return [ip, +(bits ?? max)];
  });
  if (extra.every(Boolean)) return [...PRIVATE, ...extra];
  console.log(`config.json: trustProxy should be true, false, or a list of addresses like ["203.0.113.5", "10.8.0.0/24"], not ${JSON.stringify(v)}; using true`);
  return PRIVATE;
}
const PROXIES = subnets(trustedProxies());
const viaProxy = req => inside(PROXIES, plainIp(req.socket.remoteAddress));
const viaHttps = req => viaProxy(req) && (
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https' ||
  /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || '')));

function visitor(req) {
  let ip = plainIp(req.socket.remoteAddress);
  if (inside(PROXIES, ip)) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(plainIp).filter(Boolean);
    while (hops.length) { ip = hops.pop(); if (!inside(PROXIES, ip)) break; }
  }
  if (inside(CLOUDFLARE, ip)) { const cf = plainIp(req.headers['cf-connecting-ip']); if (net.isIP(cf)) ip = cf; }
  if (!net.isIPv6(ip) || ip === '::1') return ip.slice(0, 64);
  const [head, tail] = ip.split('::'), a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

// ---------- This computer on the home network ----------
const NOT_HOME = /vpn|tun|tap|wg|wireguard|tailscale|zerotier|vethernet|wsl|docker|br-|veth|virbr|vmware|virtualbox|vbox|hyper-v|utun|ppp/i;
function homeAddresses() {
  if (IN_CONTAINER) return [];
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (NOT_HOME.test(name)) continue;
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address)) found.push(a.address);
    }
  }
  return [...new Set(found)];
}
const loopback = ip => ip === '::1' || /^127\./.test(ip);
const onThisComputer = req => loopback(plainIp(req.socket.remoteAddress)) && loopback(visitor(req));

// ---------- Plain http from the internet ----------
const PRIVATE_NETS = subnets(PRIVATE);
let warnedPlainAt = 0;
function plainFromInternet(req) {
  const peer = plainIp(req.socket.remoteAddress);
  if (!net.isIP(peer) || inside(PRIVATE_NETS, peer) || inside(PROXIES, peer) || inside(CLOUDFLARE, peer)) return;
  if (Date.now() - warnedPlainAt < 24 * 3600 * 1000) return;
  warnedPlainAt = Date.now();
  logOut(`someone (${peer}) reached Couchwave straight from the internet over plain http, so passwords and logins travel unencrypted. Put it behind Cloudflare Tunnel or Caddy for https: see docs/INSTALL.md#letting-friends-in`);
}

Object.assign(exports, { visitor, viaHttps, plainFromInternet, homeAddresses, onThisComputer });
