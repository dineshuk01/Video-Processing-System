import * as crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { Logger } from '../utils/logger';
import { ResponseHandler } from '../utils/responseHandler';
import { readCookie } from './adminAuth';

/**
 * Viewer accounts. A signed-in viewer carries a signed, HttpOnly cookie "<payload>.<hmac>" where the
 * payload holds the email and an expiry. Nothing is stored server-side per session, so sessions
 * survive restarts and work across several servers that share USER_SESSION_SECRET.
 */
const COOKIE_NAME = 'vs_session';
export const SESSION_DAYS = 30;

let generatedSecret: string | null = null;
function secret(): string {
  const configured = process.env.USER_SESSION_SECRET;
  if (configured && configured.length >= 16) return configured;
  if (!generatedSecret) {
    generatedSecret = crypto.randomBytes(32).toString('hex');
    Logger.warn('USER_SESSION_SECRET is not set: using a random one, so viewers are signed out whenever the server restarts.');
  }
  return generatedSecret;
}

// Login can be switched off for a private test setup (REQUIRE_LOGIN=false)
export const loginRequired = () => process.env.REQUIRE_LOGIN !== 'false';

const sign = (value: string) => crypto.createHmac('sha256', secret()).update(value).digest('base64url');

export function createSessionToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** The signed-in viewer's email, or null */
export function sessionEmail(req: Request): string | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof e === 'string' && Number(x) > Date.now() ? e : null;
  } catch {
    return null;
  }
}

// CloudFront talks to the server over plain HTTP but says how the visitor connected
const isHttps = (req: Request) => req.secure
  || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
  || req.headers['cloudfront-forwarded-proto'] === 'https';

export function setSessionCookie(req: Request, res: Response, email: string) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(email))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}

export function clearSessionCookie(req: Request, res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
}

/** Routes that need a signed-in viewer. The email is put on res.locals.userEmail. */
export function requireUser(req: Request, res: Response, next: NextFunction) {
  const email = sessionEmail(req);
  if (email) { res.locals.userEmail = email; return next(); }
  if (!loginRequired() && !req.baseUrl.startsWith('/api/me')) return next();
  return ResponseHandler.error(res, 'Please log in to continue', 401, 'LOGIN_REQUIRED');
}

// ─── Passwords: scrypt with a random salt per account ────────
export function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = (stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return Promise.resolve(false);
  const expected = Buffer.from(keyB64, 'base64');
  return new Promise((resolve) => {
    crypto.scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 }, (err, key) => {
      resolve(!err && key.length === expected.length && crypto.timingSafeEqual(key, expected));
    });
  });
}
