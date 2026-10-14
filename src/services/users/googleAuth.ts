import * as crypto from 'crypto';
import { HttpError } from '../../utils/responseHandler';

/**
 * "Sign in with Google": the website gets an ID token from Google (a signed JWT) and sends it here.
 * We check Google's signature and that the token was issued for this site, so only a real Google
 * account whose owner just signed in can create or open an account. No Google library needed.
 */
export const googleClientId = () => (process.env.GOOGLE_CLIENT_ID || '').trim();

// Email + password stays available only while Google sign-in is not set up, unless explicitly allowed
export const passwordLoginEnabled = () =>
  process.env.ALLOW_PASSWORD_LOGIN !== undefined ? process.env.ALLOW_PASSWORD_LOGIN === 'true' : !googleClientId();

const CERTS_URL = () => process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const CLOCK_SKEW_S = 60;

// Google's public keys change every few days; keep them for as long as Google says (Cache-Control)
let keyCache: { keys: Record<string, crypto.KeyObject>; until: number } | null = null;

async function googleKeys(force = false): Promise<Record<string, crypto.KeyObject>> {
  if (!force && keyCache && keyCache.until > Date.now()) return keyCache.keys;
  const res = await fetch(CERTS_URL());
  if (!res.ok) throw new Error(`Could not fetch Google's keys (HTTP ${res.status})`);
  const body = (await res.json()) as { keys: Array<Record<string, any>> };
  const keys: Record<string, crypto.KeyObject> = {};
  for (const jwk of body.keys || []) {
    if (jwk.kid && jwk.kty === 'RSA') keys[jwk.kid] = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  keyCache = { keys, until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return keys;
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const invalid = (why: string) => new HttpError(`Google sign-in failed: ${why}. Try again.`, 401, 'GOOGLE_TOKEN_INVALID');

export interface GoogleIdentity { email: string; name: string; sub: string }

export async function verifyGoogleIdToken(token: unknown): Promise<GoogleIdentity> {
  const clientId = googleClientId();
  if (!clientId) throw new HttpError('Google sign-in is not set up on this server', 503, 'GOOGLE_NOT_CONFIGURED');
  if (typeof token !== 'string' || token.split('.').length !== 3 || token.length > 4096) throw invalid('the sign-in response was not understood');

  const [h, p, s] = token.split('.');
  let header: any;
  let payload: any;
  try { header = decode(h); payload = decode(p); } catch { throw invalid('the sign-in response was not understood'); }
  if (header.alg !== 'RS256' || !header.kid) throw invalid('unexpected token type');

  let key = (await googleKeys())[header.kid];
  if (!key) key = (await googleKeys(true))[header.kid]; // Google may have just rotated its keys
  if (!key) throw invalid('unknown signing key');
  const signedOk = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!signedOk) throw invalid('the token is not signed by Google');

  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(payload.iss)) throw invalid('the token is not from Google');
  if (payload.aud !== clientId) throw invalid('the token was issued for another site');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) throw invalid('the token has expired');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > now) throw invalid('the token is from the future');
  if (!payload.email || payload.email_verified !== true) throw invalid('Google has not verified this email address');

  const email = String(payload.email).trim().toLowerCase();
  const name = String(payload.name || payload.given_name || email.split('@')[0]).trim().slice(0, 60);
  return { email, name, sub: String(payload.sub) };
}
