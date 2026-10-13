import * as crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Logger } from '../utils/logger';
import { ResponseHandler } from '../utils/responseHandler';

/**
 * Minimal admin gate: one shared key (ADMIN_API_KEY) exchanged for a signed, HttpOnly session cookie.
 * It protects every admin route and the raw/unpublished media. Replace `isAdminRequest` with your
 * real login system when it exists; everything else only depends on that function.
 *
 *  - ADMIN_API_KEY set        -> login required.
 *  - not set, NODE_ENV!=production -> admin is open (local development only; a warning is logged).
 *  - not set, NODE_ENV=production  -> admin is locked (503) so it can never be exposed by accident.
 */
const COOKIE_NAME = 'vs_admin';
const SESSION_HOURS = Math.max(1, parseInt(process.env.ADMIN_SESSION_HOURS || '12', 10) || 12);

const adminKey = () => process.env.ADMIN_API_KEY || '';
const isProduction = () => process.env.NODE_ENV === 'production';

export type AdminMode = 'protected' | 'open' | 'locked';
// The placeholder from .env.example must never protect a production server
const isPlaceholderKey = () => adminKey() === 'change-me';

export function adminMode(): AdminMode {
  if (adminKey() && !(isPlaceholderKey() && isProduction())) return 'protected';
  return isProduction() ? 'locked' : 'open';
}

export function warnIfAdminOpen() {
  if (isPlaceholderKey() && isProduction()) {
    Logger.error('ADMIN_API_KEY is still the placeholder "change-me": admin routes are disabled. Set a real key.');
  } else if (adminMode() === 'open') {
    Logger.warn('ADMIN_API_KEY is not set: the admin app and API are OPEN. Set it before exposing this server.');
  } else if (adminMode() === 'locked') {
    Logger.error('ADMIN_API_KEY is not set and NODE_ENV=production: admin routes are disabled.');
  }
}

function sign(value: string): string {
  return crypto.createHmac('sha256', adminKey()).update(value).digest('hex');
}

// Stateless token "<expiresAtMs>.<hmac>": survives restarts and needs no server-side store
function createToken(): string {
  const expires = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  return `${expires}.${sign(expires)}`;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyToken(token: string | undefined): boolean {
  if (!token || !adminKey()) return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature) return false;
  if (!safeEqual(signature, sign(expires))) return false;
  return Number(expires) > Date.now();
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** True when the request comes from an authenticated admin (or admin is open in development). */
export function isAdminRequest(req: Request): boolean {
  // A user-only server has no admin at all, whatever the request or environment says
  if (process.env.APP_MODE === 'user') return false;
  const mode = adminMode();
  if (mode === 'open') return true;
  if (mode === 'locked') return false;
  const headerKey = req.headers['x-admin-key'];
  if (typeof headerKey === 'string' && safeEqual(headerKey, adminKey())) return true; // scripts / curl
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (bearer && safeEqual(bearer[1], adminKey())) return true; // e.g. Prometheus scraping /metrics
  return verifyToken(readCookie(req, COOKIE_NAME));
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (adminMode() === 'locked') {
    return ResponseHandler.error(res, 'Admin is disabled: ADMIN_API_KEY is not configured.', 503, 'ADMIN_DISABLED');
  }
  if (isAdminRequest(req)) return next();
  return ResponseHandler.error(res, 'Admin sign-in required', 401, 'UNAUTHORIZED');
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many sign-in attempts. Try again later.', code: 'LOGIN_RATE_LIMIT' } },
});

// Mounted at /api/admin (before requireAdmin): login, logout and session check
export const adminAuthRouter = Router();

adminAuthRouter.get('/session', (req: Request, res: Response) => {
  const mode = adminMode();
  return ResponseHandler.success(res, {
    mode,
    authenticated: isAdminRequest(req),
    loginRequired: mode === 'protected',
  });
});

adminAuthRouter.post('/login', loginLimiter, (req: Request, res: Response) => {
  if (adminMode() !== 'protected') {
    return ResponseHandler.success(res, { authenticated: isAdminRequest(req), mode: adminMode() });
  }
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!key || !safeEqual(key, adminKey())) {
    Logger.warn('Failed admin sign-in attempt', { ip: req.ip });
    return ResponseHandler.error(res, 'Incorrect admin key', 401, 'INVALID_KEY');
  }
  const secure = isProduction() || req.secure;
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(createToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
  return ResponseHandler.success(res, { authenticated: true });
});

adminAuthRouter.post('/logout', (req: Request, res: Response) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  return ResponseHandler.success(res, { authenticated: false });
});
