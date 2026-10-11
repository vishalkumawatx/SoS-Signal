import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { SmsError, createTwilioTransport } from '../server/sms.js';

async function fixture(t, { configured = true, sms: supplied, dbPath = ':memory:' } = {}) {
  const messages = [];
  const sms = supplied || {
    async send(message) { messages.push(message); return { sid: `SM${'0'.repeat(31)}1`, status: 'queued' }; },
    async getStatus() { return { status: 'delivered', error: null }; },
  };
  const app = createApp({ dbPath, sms: configured ? sms : undefined, config: { appOrigin: 'http://localhost:5173', production: false, accountSid: '', authToken: '', fromNumber: '' } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, cookie, method = body === undefined ? 'GET' : 'POST', origin = 'http://localhost:5173') {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  async function register(email = 'test@example.invalid') {
    const response = await request('/auth/register', { name: 'Test User', email, password: 'safe-test-password-123' });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.cookie;
  }
  async function contact(cookie, phone = '+14155550123') {
    const result = await request('/contacts', { name: 'Test Contact', phone, consent: true }, cookie);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.contact;
  }
  async function verify(cookie, c) {
    const code = messages.findLast(m => m.to === c.phone).body.match(/\b\d{6}\b/)[0];
    const response = await request(`/contacts/${c.id}/verify`, { code }, cookie);
    assert.equal(response.status, 200, JSON.stringify(response.data));
  }
  return { request, register, contact, verify, messages, db: app.locals.db, app };
}

test('accounts, hashed sessions, invalid login, origin checks and logout', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/session')).data.user, null);
  assert.equal((await f.request('/contacts')).status, 401);
  assert.equal((await f.request('/auth/register', { name: 'X' }, undefined, 'POST', 'https://untrusted.invalid')).status, 403);
  const cookie = await f.register();
  const stored = f.db.prepare('SELECT * FROM users').get();
  assert.notEqual(stored.password_hash, 'safe-test-password-123');
  assert.notEqual(f.db.prepare('SELECT token_hash FROM sessions').get().token_hash, cookie.split('=')[1]);
  assert.equal((await f.request('/session', undefined, cookie)).data.user.email, 'test@example.invalid');
  assert.equal((await f.request('/auth/login', { email: 'test@example.invalid', password: 'wrong-password-123' })).status, 401);
  assert.equal((await f.request('/auth/register', { name: 'Duplicate', email: 'test@example.invalid', password: 'safe-test-password-123' })).status, 409);
  assert.equal((await f.request('/auth/logout', {}, cookie)).status, 204);
  assert.equal((await f.request('/session', undefined, cookie)).data.user, null);
  const login = await f.request('/auth/login', { email: 'test@example.invalid', password: 'safe-test-password-123' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
});

test('SMS stays unavailable without configuration and emits no pretend success', async t => {
  const f = await fixture(t, { configured: false });
  const cookie = await f.register();
  assert.equal((await f.request('/session', undefined, cookie)).data.configured, false);
  assert.equal((await f.request('/contacts', { name: 'Contact', phone: '+14155550123', consent: true }, cookie)).status, 503);
  assert.equal((await f.request('/alerts', { message: 'Help', confirmed: true }, cookie)).status, 503);
  assert.equal(f.messages.length, 0);
});

test('contact validation, consent, account isolation, verification and deletion', async t => {
  const f = await fixture(t);
  const a = await f.register();
  const b = await f.register('second@example.invalid');
  assert.equal((await f.request('/contacts', { name: 'Contact', phone: '555', consent: true }, a)).status, 400);
  assert.equal((await f.request('/contacts', { name: 'Contact', phone: '+14155550123' }, a)).status, 400);
  const c = await f.contact(a);
  assert.equal(c.verified, false);
  assert.deepEqual((await f.request('/contacts', undefined, b)).data.contacts, []);
  assert.equal((await f.request(`/contacts/${c.id}/verify`, { code: '000000' }, b)).status, 404);
  assert.equal((await f.request(`/contacts/${c.id}`, undefined, b, 'DELETE')).status, 404);
  assert.equal((await f.request(`/contacts/${c.id}/resend`, {}, a)).status, 429);
  await f.verify(a, c);
  assert.equal((await f.request('/contacts', undefined, a)).data.contacts[0].verified, true);
  assert.equal((await f.request(`/contacts/${c.id}`, undefined, a, 'DELETE')).status, 204);
  assert.deepEqual((await f.request('/contacts', undefined, a)).data.contacts, []);
});

test('verification code attempt and expiration limits', async t => {
  const f = await fixture(t);
  const cookie = await f.register();
  const c = await f.contact(cookie);
  for (let i = 0; i < 5; i++) assert.equal((await f.request(`/contacts/${c.id}/verify`, { code: 'invalid' }, cookie)).status, 400);
  const code = f.messages[0].body.match(/\b\d{6}\b/)[0];
  assert.equal((await f.request(`/contacts/${c.id}/verify`, { code }, cookie)).status, 429);
  f.db.prepare('UPDATE contacts SET otp_expires=0,otp_attempts=0 WHERE id=?').run(c.id);
  assert.equal((await f.request(`/contacts/${c.id}/verify`, { code }, cookie)).status, 400);
});

test('alerts require verified recipients, valid coordinates and explicit confirmation', async t => {
  const f = await fixture(t);
  const cookie = await f.register();
  await f.contact(cookie);
  assert.equal((await f.request('/alerts', { message: 'Help', confirmed: true }, cookie)).status, 409);
  assert.equal((await f.request('/alerts', { message: 'Help' }, cookie)).status, 400);
  assert.equal((await f.request('/alerts', { message: 'Help', confirmed: true, latitude: 900, longitude: 0 }, cookie)).status, 400);
  assert.equal((await f.request('/alerts', { message: 'Help', confirmed: true, latitude: 30 }, cookie)).status, 400);
  assert.equal(f.messages.length, 1);
});

test('SOS only reaches verified contacts, persists status and enforces concurrent cooldown', async t => {
  const f = await fixture(t);
  const cookie = await f.register();
  const c = await f.contact(cookie);
  await f.verify(cookie, c);
  await f.contact(cookie, '+14155550124');
  const results = await Promise.all([1, 2].map(() => f.request('/alerts', { message: 'Please call me.', confirmed: true, latitude: 12.3, longitude: 45.6 }, cookie)));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 429]);
  const alert = results.find(r => r.status === 201).data.alert;
  assert.equal(alert.recipients.length, 1);
  assert.equal(alert.recipients[0].status, 'queued');
  assert.equal(alert.latitude, 12.3);
  assert.equal(f.messages.filter(m => m.body.startsWith('SOS from')).length, 1);
  assert.match(f.messages.at(-1).body, /12\.3,45\.6/);
  const second = await f.register('other@example.invalid');
  assert.deepEqual((await f.request('/alerts', undefined, second)).data.alerts, []);
  f.db.prepare('UPDATE recipients SET checked_at=0').run();
  assert.equal((await f.request('/alerts', undefined, cookie)).data.alerts[0].recipients[0].status, 'delivered');
});

test('failed and ambiguous provider submissions are recorded honestly', async t => {
  let failSends = false;
  let count = 0;
  const f = await fixture(t, { sms: { async send() {
    if (!failSends) return { sid: `SM${'1'.repeat(32)}`, status: 'queued' };
    count++;
    throw new SmsError('Provider failure', count === 2);
  } } });
  const cookie = await f.register();
  await f.contact(cookie);
  await f.contact(cookie, '+14155550124');
  f.db.prepare('UPDATE contacts SET verified=1').run();
  failSends = true;
  const result = await f.request('/alerts', { message: 'Help', confirmed: true }, cookie);
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.alert.recipients.map(r => r.status), ['failed', 'unknown']);
  assert.equal(result.data.alert.recipients[0].error, 'Provider failure');
  assert.match(result.data.alert.recipients[1].error, /Provider failure.*Delivery is unknown/);
  assert.equal(count, 2);
  assert.equal((await f.request('/alerts', undefined, cookie)).data.alerts.length, 1);
  assert.equal(count, 2);
});

test('provider OTP failure preserves an unverified contact for recovery', async t => {
  const f = await fixture(t, { sms: { async send() { throw new SmsError('Unavailable', true); } } });
  const cookie = await f.register();
  const response = await f.request('/contacts', { name: 'Contact', phone: '+14155550123', consent: true }, cookie);
  assert.equal(response.status, 502);
  assert.equal(response.data.contact.verified, false);
  assert.match(response.data.error, /Unavailable/);
  assert.match(response.data.error, /check Twilio Messaging Logs/);
  assert.equal((await f.request('/contacts', undefined, cookie)).data.contacts.length, 1);
});

test('SQLite data persists when the application is reopened', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-test-'));
  const dbPath = join(directory, 'test.sqlite');
  const first = createApp({ dbPath, config: { accountSid: '', authToken: '', fromNumber: '' } });
  first.locals.db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run('Persisted', 'saved@example.invalid', 'not-a-real-password');
  first.locals.db.close();
  const second = createApp({ dbPath, config: { accountSid: '', authToken: '', fromNumber: '' } });
  t.after(() => { second.locals.db.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(second.locals.db.prepare('SELECT name FROM users').get().name, 'Persisted');
});

test('Twilio adapter encodes requests and treats unconfirmed outcomes as unknown', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ sid: `SM${'a'.repeat(32)}`, status: 'queued' }), { status: 201 });
  };
  const transport = createTwilioTransport({ accountSid: 'test-account', authToken: 'test-token', fromNumber: '+14155550100' });
  assert.equal((await transport.send({ to: '+14155550123', body: 'Test only' })).status, 'queued');
  assert.equal(requests[0].options.body.get('To'), '+14155550123');
  assert.equal(requests[0].options.redirect, 'error');
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  await assert.rejects(transport.send({ to: '+14155550123', body: 'Test only' }), error => error.ambiguous === true);
  globalThis.fetch = async () => new Response('{}', { status: 400 });
  await assert.rejects(transport.send({ to: '+14155550123', body: 'Test only' }), error => error.ambiguous === false);
  for (const [code, expected] of [[20003, /authentication failed/], [21608, /Verify the recipient/], [21408, /Geographic Permissions/], [21606, /SMS-capable/], [30034, /registration/], [21610, /opted out/], [572006, /no specific explanation.*Twilio Console.*contact Twilio support/]]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ code, message: 'PRIVATE_PROVIDER_DETAIL' }), { status: 400 });
    await assert.rejects(transport.send({ to: '+14155550123', body: 'Test only' }), error => {
      assert.match(error.message, new RegExp(String(code)));
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_DETAIL/);
      return error.ambiguous === false;
    });
  }
  globalThis.fetch = async () => new Response('not JSON', { status: 401 });
  await assert.rejects(transport.send({ to: '+14155550123', body: 'Test only' }), /authentication failed/);
  globalThis.fetch = async () => new Response(JSON.stringify({ sid: `SM${'a'.repeat(32)}`, status: 'undelivered', error_code: 30007 }));
  const outcome = await transport.getStatus(`SM${'a'.repeat(32)}`);
  assert.equal(outcome.status, 'undelivered');
  assert.match(outcome.error, /carrier filtered/);
});
