import express from 'express';
import cookieParser from 'cookie-parser';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomInt, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createTwilioTransport, normalizeStatus, SmsError } from './sms.js';

const derive = promisify(scrypt);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nowISO = () => new Date().toISOString();
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });
const publicContact = (c) => ({ id: c.id, name: c.name, phone: c.phone, verified: Boolean(c.verified) });
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, min, max, label) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw fail(400, `${label} must be ${min}–${max} characters.`);
  return value.trim();
};
const parseId = (value) => {
  if (!/^[1-9]\d{0,14}$/.test(value)) throw fail(400, 'Invalid ID.');
  return Number(value);
};

export function createApp({ dbPath = process.env.DATABASE_PATH || './data/sos.sqlite', sms, config = {} } = {}) {
  const production = config.production ?? process.env.NODE_ENV === 'production';
  const appOrigin = config.appOrigin ?? process.env.APP_ORIGIN ?? 'http://localhost:5173';
  if (new URL(appOrigin).origin !== appOrigin) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin without a trailing slash.');
  if (!/^https?:\/\//.test(appOrigin)) throw new Error('APP_ORIGIN must use HTTP(S).');
  const accountSid = config.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = config.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = config.fromNumber ?? process.env.TWILIO_FROM_NUMBER;
  const configured = Boolean(sms || (accountSid && authToken && fromNumber));
  const transport = sms || (configured ? createTwilioTransport({ accountSid, authToken, fromNumber }) : null);
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, last_alert_at INTEGER NOT NULL DEFAULT 0,
      otp_day TEXT, otp_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, phone TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
      otp_hash TEXT, otp_expires INTEGER, otp_attempts INTEGER NOT NULL DEFAULT 0,
      otp_sent_at INTEGER NOT NULL DEFAULT 0, otp_day TEXT, otp_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id,phone)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, message TEXT NOT NULL, latitude REAL, longitude REAL
    );
    CREATE TABLE IF NOT EXISTS recipients (
      id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      name TEXT NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
      provider_sid TEXT, checked_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS contacts_user ON contacts(user_id);
    CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id);
    CREATE INDEX IF NOT EXISTS recipients_alert ON recipients(alert_id);
  `);
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.configured = configured;
  app.set('trust proxy', false);
  const cookieName = production ? '__Host-sos_session' : 'sos_session';
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: production, path: '/' };
  const sessionTTL = 7 * 24 * 60 * 60 * 1000;
  const buckets = new Map();
  function limit(key, maximum, windowMs) {
    const now = Date.now();
    if (buckets.size >= 10000) {
      for (const [k, b] of buckets) if (b.until <= now) buckets.delete(k);
      if (buckets.size >= 10000 && !buckets.has(key)) throw fail(503, 'Server is busy. Try again later.');
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      bucket = { count: 0, until: now + windowMs };
      buckets.set(key, bucket);
    }
    if (++bucket.count > maximum) throw fail(429, 'Too many requests. Try again later.');
  }
  app.use('/api', (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== appOrigin) return res.status(403).json({ error: 'Request origin is not allowed.' });
    next();
  });
  app.use('/api', express.json({ limit: '8kb', strict: true }), cookieParser());
  app.use('/api', (req, res, next) => {
    const token = req.cookies[cookieName];
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
      req.user = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), Date.now());
      req.sessionHash = hash(token);
    }
    next();
  });
  const auth = (req, res, next) => req.user ? next() : next(fail(401, 'Sign in to continue.'));
  const requireSMS = () => { if (!configured) throw fail(503, 'SMS is not configured. Set the Twilio account SID, auth token, and sender number.'); };
  function issueSession(req, res, user) {
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 9)').run(user.id, user.id);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), user.id, Date.now() + sessionTTL);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionTTL });
  }
  function credentials(req) {
    const email = text(req.body?.email, 3, 254, 'Email').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail(400, 'Password must be 12–128 characters.');
    limit(`auth-ip:${req.ip}`, 30, 15 * 60000);
    limit(`auth-email:${email}`, 10, 15 * 60000);
    return { email, password };
  }
  function contactFor(req) {
    const contact = db.prepare('SELECT * FROM contacts WHERE id=? AND user_id=?').get(parseId(req.params.id), req.user.id);
    if (!contact) throw fail(404, 'Contact not found.');
    return contact;
  }
  // Reserve quotas and OTP before awaiting the provider, preventing concurrent requests from bypassing limits.
  async function sendOTP(contact, userId) {
    const now = Date.now();
    const day = nowISO().slice(0, 10);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (now - contact.otp_sent_at < 60000) throw fail(429, 'Wait 60 seconds before requesting another verification code.');
    const contactCount = contact.otp_day === day ? contact.otp_count : 0;
    const userCount = user.otp_day === day ? user.otp_count : 0;
    if (contactCount >= 5 || userCount >= 10) throw fail(429, 'Daily verification limit reached. Try again tomorrow (UTC).');
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const salt = randomBytes(32).toString('hex');
    const digest = hash(`${salt}:${code}`);
    db.prepare('UPDATE users SET otp_day=?,otp_count=? WHERE id=?').run(day, userCount + 1, userId);
    db.prepare('UPDATE contacts SET otp_hash=?,otp_expires=?,otp_attempts=0,otp_sent_at=?,otp_day=?,otp_count=? WHERE id=?').run(`${salt}:${digest}`, now + 10 * 60000, now, day, contactCount + 1, contact.id);
    try {
      const result = await transport.send({ to: contact.phone, body: `SOS contact verification code: ${code}. Expires in 10 minutes. Share only with the person you agreed may send you SOS alerts. Ignore if unexpected. Reply STOP to opt out.` });
      if (['failed', 'undelivered'].includes(normalizeStatus(result.status))) throw new SmsError(result.error || 'Verification SMS was not delivered.');
      if (normalizeStatus(result.status) === 'unknown') throw new SmsError('Verification SMS status is unknown.', true);
    } catch (error) {
      const reason = error instanceof SmsError ? error.message : 'Verification SMS could not be confirmed.';
      const recovery = error instanceof SmsError && !error.ambiguous
        ? 'Contact remains unverified. Resolve the provider issue, then request a new code after the 60-second cooldown.'
        : 'Contact remains pending. If a code arrives, use it; otherwise check Twilio Messaging Logs before requesting another code after 60 seconds.';
      throw Object.assign(fail(502, `${reason} ${recovery}`), { contact: publicContact(contact) });
    }
  }
  function readAlert(id) {
    const a = db.prepare('SELECT * FROM alerts WHERE id=?').get(id);
    return { id: a.id, createdAt: a.created_at, message: a.message, latitude: a.latitude, longitude: a.longitude,
      recipients: db.prepare('SELECT name,phone,status,error FROM recipients WHERE alert_id=? ORDER BY id').all(id) };
  }

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/session', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, configured }));
  app.post('/api/auth/register', async (req, res) => {
    const { email, password } = credentials(req);
    const name = text(req.body?.name, 1, 80, 'Name');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = `${salt}:${(await derive(password, salt, 64)).toString('hex')}`;
    let id;
    try { id = Number(db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name, email, passwordHash).lastInsertRowid); }
    catch (error) { if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE')) throw fail(409, 'An account with this email already exists.'); throw error; }
    const user = { id, name, email };
    issueSession(req, res, user);
    res.status(201).json({ user });
  });
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = credentials(req);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const [salt, expected] = user ? user.password_hash.split(':') : ['00000000000000000000000000000000', '00'.repeat(64)];
    const actual = await derive(password, salt, 64);
    if (!user || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw fail(401, 'Invalid email or password.');
    issueSession(req, res, user);
    res.json({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  app.get('/api/contacts', auth, (req, res) => res.json({ contacts: db.prepare('SELECT * FROM contacts WHERE user_id=? ORDER BY id').all(req.user.id).map(publicContact) }));
  app.post('/api/contacts', auth, async (req, res) => {
    limit(`contacts:${req.user.id}`, 20, 3600000);
    const name = text(req.body?.name, 1, 80, 'Name');
    const phone = text(req.body?.phone, 8, 16, 'Phone');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw fail(400, 'Phone must use E.164 format, for example +14155550123.');
    if (req.body?.consent !== true) throw fail(400, 'Contact consent is required.');
    requireSMS();
    if (db.prepare('SELECT count(*) AS n FROM contacts WHERE user_id=?').get(req.user.id).n >= 5) throw fail(409, 'A maximum of five contacts is allowed.');
    if (db.prepare('SELECT id FROM contacts WHERE user_id=? AND phone=?').get(req.user.id, phone)) throw fail(409, 'Contact already exists. Use resend for a pending contact.');
    const id = Number(db.prepare('INSERT INTO contacts(user_id,name,phone) VALUES(?,?,?)').run(req.user.id, name, phone).lastInsertRowid);
    const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
    try { await sendOTP(contact, req.user.id); }
    catch (error) { error.contact = publicContact(contact); throw error; }
    res.status(201).json({ contact: publicContact(contact) });
  });
  app.post('/api/contacts/:id/resend', auth, async (req, res) => {
    limit(`resend:${req.user.id}`, 20, 3600000);
    const contact = contactFor(req);
    if (contact.verified) throw fail(409, 'Contact is already verified.');
    requireSMS();
    await sendOTP(contact, req.user.id);
    res.json({ contact: publicContact(contact) });
  });
  app.post('/api/contacts/:id/verify', auth, (req, res) => {
    limit(`verify:${req.user.id}`, 40, 15 * 60000);
    const c = contactFor(req);
    if (c.verified) return res.json({ contact: publicContact(c) });
    if (!c.otp_hash || Date.now() >= c.otp_expires) throw fail(400, 'Verification code expired. Request another code.');
    if (c.otp_attempts >= 5) throw fail(429, 'Verification attempt limit reached. Request another code after the cooldown.');
    db.prepare('UPDATE contacts SET otp_attempts=otp_attempts+1 WHERE id=?').run(c.id);
    const code = req.body?.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail(400, 'Enter the six-digit verification code.');
    const [salt, expected] = c.otp_hash.split(':');
    if (!timingSafeEqual(Buffer.from(hash(`${salt}:${code}`), 'hex'), Buffer.from(expected, 'hex'))) throw fail(400, 'Incorrect verification code.');
    db.prepare('UPDATE contacts SET verified=1,otp_hash=NULL,otp_expires=NULL WHERE id=?').run(c.id);
    res.json({ contact: publicContact({ ...c, verified: 1 }) });
  });
  app.delete('/api/contacts/:id', auth, (req, res) => {
    db.prepare('DELETE FROM contacts WHERE id=?').run(contactFor(req).id);
    res.status(204).end();
  });
  app.post('/api/alerts', auth, async (req, res) => {
    limit(`alerts:${req.user.id}`, 30, 3600000);
    if (req.body?.confirmed !== true) throw fail(400, 'Explicit confirmation is required to send an SOS alert.');
    const message = text(req.body?.message, 1, 500, 'Message');
    const { latitude, longitude } = req.body;
    const hasLocation = latitude !== undefined || longitude !== undefined;
    if (hasLocation && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180)) throw fail(400, 'Provide both valid latitude and longitude, or omit both.');
    requireSMS();
    const contacts = db.prepare('SELECT * FROM contacts WHERE user_id=? AND verified=1 ORDER BY id').all(req.user.id);
    if (!contacts.length) throw fail(409, 'Add and verify at least one contact before sending an SOS alert.');
    const now = Date.now();
    if (!db.prepare('UPDATE users SET last_alert_at=? WHERE id=? AND last_alert_at<=?').run(now, req.user.id, now - 60000).changes) throw fail(429, 'Wait 60 seconds before sending another SOS alert. Check alert history before retrying.');
    const id = Number(db.prepare('INSERT INTO alerts(user_id,created_at,message,latitude,longitude) VALUES(?,?,?,?,?)').run(req.user.id, nowISO(), message, hasLocation ? latitude : null, hasLocation ? longitude : null).lastInsertRowid);
    const rows = contacts.map((c) => ({ ...c, recipientId: Number(db.prepare("INSERT INTO recipients(alert_id,name,phone,status,error) VALUES(?,?,?,'unknown',?)").run(id, c.name, c.phone, 'SMS submission has not been confirmed.').lastInsertRowid) }));
    const body = `SOS from ${req.user.name}: ${message}${hasLocation ? `\nLocation: https://maps.google.com/?q=${latitude},${longitude}` : ''}\nReply STOP to opt out.`;
    await Promise.all(rows.map(async (c) => {
      try {
        const result = await transport.send({ to: c.phone, body });
        const status = normalizeStatus(result.status);
        db.prepare('UPDATE recipients SET status=?,error=?,provider_sid=?,checked_at=? WHERE id=?').run(status, result.error || (status === 'unknown' ? 'Delivery status is unknown.' : null), result.sid || null, Date.now(), c.recipientId);
      } catch (error) {
        const status = error instanceof SmsError && !error.ambiguous ? 'failed' : 'unknown';
        const reason = error instanceof SmsError ? error.message : 'SMS submission was not confirmed.';
        db.prepare('UPDATE recipients SET status=?,error=?,checked_at=? WHERE id=?').run(status, status === 'failed' ? reason : `${reason} Delivery is unknown; no automatic retry will occur.`, Date.now(), c.recipientId);
      }
    }));
    res.status(201).json({ alert: readAlert(id) });
  });
  app.get('/api/alerts', auth, async (req, res) => {
    limit(`history:${req.user.id}`, 60, 60000);
    const alerts = db.prepare('SELECT id FROM alerts WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id);
    if (transport?.getStatus) {
      const pending = db.prepare("SELECT r.* FROM recipients r JOIN alerts a ON a.id=r.alert_id WHERE a.user_id=? AND r.provider_sid IS NOT NULL AND r.status IN ('queued','accepted','sent','unknown') AND r.checked_at<=? ORDER BY r.checked_at LIMIT 10").all(req.user.id, Date.now() - 15000);
      pending.forEach((r) => db.prepare('UPDATE recipients SET checked_at=? WHERE id=?').run(Date.now(), r.id));
      await Promise.all(pending.map(async (r) => {
        try {
          const result = await transport.getStatus(r.provider_sid);
          db.prepare('UPDATE recipients SET status=?,error=? WHERE id=?').run(normalizeStatus(result.status), result.error || null, r.id);
        } catch { /* Preserve the last confirmed status when polling fails. */ }
      }));
    }
    res.json({ alerts: alerts.map((a) => readAlert(a.id)) });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    res.status(status).json({ error: status === 413 ? 'Request body is too large.' : status >= 500 && !error.status ? 'Internal server error.' : status === 400 && error.type === 'entity.parse.failed' ? 'Invalid JSON body.' : error.message,
      ...(error.contact ? { contact: error.contact } : {}) });
  });
  return app;
}
