// ---------- Wrong passwords: who is guessing, and the limits ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { testServers, PASSWORD, ownPassword } = require('./helpers');

const start = testServers({ after });
const join = (s, body, headers) => s.req('POST', '/login', { body, cookie: '', headers });
const right = name => ({ password: PASSWORD, name, own: ownPassword(name) });
const wrongRoom = (s, headers) => join(s, { password: 'wrong', name: 'Eve', own: 'xxxx' }, headers);
async function lockedAfter20(s, headersFor) {
  for (let i = 0; i < 20; i++) assert.equal((await wrongRoom(s, headersFor(i))).status, 401, `guess ${i + 1}`);
  return (await wrongRoom(s, headersFor(20))).status === 429;
}

describe('wrong passwords', { concurrency: true }, () => {
  test('20 wrong passwords (room or own, even sent all at once): that visitor waits, even with the right ones; others don\'t', async () => {
    const s = await start();
    await join(s, right('Alice'));
    const from = ip => ({ 'X-Forwarded-For': ip });
    for (let i = 0; i < 5; i++) assert.equal((await wrongRoom(s, from('1.2.3.4'))).status, 401);
    await Promise.all(Array.from({ length: 25 }, (_, i) => join(s, { ...right('Alice'), own: 'guess' + i }, from('1.2.3.4'))));
    assert.equal((await join(s, right('Alice'), from('1.2.3.4'))).status, 429, 'locked out, even with the right passwords');
    assert.equal((await join(s, right('Alice'), from('5.6.7.8'))).status, 204, 'Alice herself, elsewhere, can still log in');
    await s.logHas(/logins: 1\.2\.3\.4 got a password wrong 20 times in 15 minutes, so it waits 15 minutes before trying again/);
    assert.equal(fs.readFileSync(s.logFile, 'utf8').match(/logins: 1\.2\.3\.4 got a password wrong/g).length, 1, 'said once');
  });

  test('new nicknames: 10 an hour from any one visitor (the computer running Couchwave isn\'t limited)', async () => {
    const s = await start();
    const from = { 'X-Forwarded-For': '203.0.113.20' };
    for (let i = 0; i < 10; i++) assert.equal((await join(s, right('New' + i), from)).status, 204, `nickname ${i + 1}`);
    const r = await join(s, right('New10'), from);
    assert.equal(r.status, 429);
    assert.match(r.text, /^Lots of new nicknames have been made from here in the last hour/);
    assert.equal((await join(s, right('New0'), from)).status, 204, 'nicknames already made still log in');
    assert.equal((await join(s, right('Other'), { 'X-Forwarded-For': '203.0.113.21' })).status, 204, 'other visitors aren\'t affected');
    for (let i = 0; i < 12; i++) assert.equal((await join(s, right('Local' + i))).status, 204, 'from this computer');
    await s.logHas(/logins: 10 new nicknames from 203\.0\.113\.20 in the last hour/);
  });

  test('headers a visitor can write themselves don\'t make them someone new', async () => {
    const s = await start();
    assert.ok(await lockedAfter20(s, i => ({ 'X-Forwarded-For': '203.0.113.7', 'X-Real-IP': `198.51.100.${i}`, 'CF-Connecting-IP': `198.51.100.${i}` })));
    assert.equal((await join(s, right('Alice'), { 'X-Forwarded-For': '203.0.113.8' })).status, 204, 'someone else still gets in');
  });

  test('behind a proxy that adds to X-Forwarded-For: the address it added counts, not ones the visitor wrote before it', async () => {
    const s = await start();
    assert.ok(await lockedAfter20(s, i => ({ 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.9` })));
  });

  test('several proxies on the home network: the first address outside it counts', async () => {
    const s = await start();
    assert.ok(await lockedAfter20(s, () => ({ 'X-Forwarded-For': '203.0.113.10, 192.168.1.2, 10.0.0.3' })));
    assert.equal((await wrongRoom(s, { 'X-Forwarded-For': '203.0.113.10' })).status, 429, 'the same visitor, through one proxy');
  });

  test('Cloudflare\'s header counts when the visit came through Cloudflare, and nowhere else', async () => {
    const s = await start();
    assert.equal(await lockedAfter20(s, i => ({ 'X-Forwarded-For': '173.245.48.1', 'CF-Connecting-IP': `198.51.100.${i}` })), false, 'each a different visitor');
    assert.ok(await lockedAfter20(s, i => ({ 'X-Forwarded-For': '203.0.113.11', 'CF-Connecting-IP': `198.51.100.${i}` })), 'not from Cloudflare: ignored');
  });

  test('IPv6: one home connection (a /64) is one visitor', async () => {
    const s = await start();
    assert.ok(await lockedAfter20(s, i => ({ 'X-Forwarded-For': `2001:db8:1:2::${(i + 1).toString(16)}` })));
    assert.equal((await wrongRoom(s, { 'X-Forwarded-For': '2001:0db8:0001:0002:0000:0000:0000:0abc' })).status, 429, 'written out in full: the same');
    assert.equal((await wrongRoom(s, { 'X-Forwarded-For': '2001:db8:1:3::1' })).status, 401, 'the next connection along is someone else');
  });

  test('trustProxy false: no proxy headers believed', async () => {
    const s = await start({ config: { trustProxy: false } });
    assert.ok(await lockedAfter20(s, i => ({ 'X-Forwarded-For': `198.51.100.${i}` })));
    const r = await join(s, right('Alice'), { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.12' });
    assert.equal(r.status, 429, 'everyone counts as this machine');
  });

  test('trustProxy with extra proxies: visitors behind them count one by one', async () => {
    const s = await start({ config: { trustProxy: ['203.0.113.0/24', '2001:db8::1'] } });
    assert.equal(await lockedAfter20(s, i => ({ 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.5` })), false);
    assert.ok(await lockedAfter20(s, i => ({ 'X-Forwarded-For': `198.51.100.${i}, 198.51.100.200` })), 'an address not in the list is the visitor');
  });

  test('a nickname: 20 wrong passwords from anywhere and it waits 15 minutes; its logged-in devices keep working', async () => {
    const s = await start();
    await s.state('Alice');
    for (let i = 0; i < 20; i++) assert.equal((await join(s, { ...right('Alice'), own: 'guess' + i }, { 'X-Forwarded-For': `198.51.100.${i}` })).status, 401);
    const r = await join(s, right('Alice'), { 'X-Forwarded-For': '203.0.113.13' });
    assert.equal(r.status, 429, 'not even the right password, from a new address');
    assert.match(r.text, /Too many wrong passwords for "Alice"/);
    await s.logHas(/logins: 20 wrong passwords for "Alice" in 15 minutes, so new logins with it wait 15 minutes \(devices already logged in carry on\)/);
    assert.equal((await s.get('/state')).status, 200, 'Alice\'s logged-in device carries on');
    assert.equal((await join(s, right('Bob'), { 'X-Forwarded-For': '203.0.113.13' })).status, 204, 'other nicknames are fine');
  });

  test('lots of guesses at a nickname at once still stop at 20', async () => {
    const s = await start();
    await s.state('Alice');
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => join(s, { ...right('Alice'), own: 'guess' + i }, { 'X-Forwarded-For': `198.51.100.${i}` })));
    assert.equal(rs.filter(r => r.status === 401).length, 20);
    assert.equal(rs.filter(r => r.status === 429).length, 20);
  });

  test('lots of logins at once: some are asked to try again in a moment, instead of slowing everything else down', async () => {
    const s = await start();
    const rs = await Promise.all(Array.from({ length: 120 }, (_, i) => join(s, right('Guest' + i), { 'X-Forwarded-For': `198.51.100.${i}` })));
    const busy = rs.filter(r => r.status === 503);
    assert.ok(busy.length > 0, 'some were turned away');
    assert.ok(busy.every(r => /Lots of people are logging in right now\. Try again in a moment/.test(r.text)));
    assert.ok(rs.every(r => r.status === 204 || r.status === 503), rs.map(r => r.status).join(' '));
    assert.equal((await join(s, right('Guest0'), { 'X-Forwarded-For': '198.51.100.0' })).status, 204, 'and afterwards it\'s back to normal');
  });

});
