import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getUserStore } from '../services/users/userStore';
import { clearSessionCookie, hashPassword, requireUser, setSessionCookie, verifyPassword } from '../middleware/userAuth';
import { HttpError, ResponseHandler } from '../utils/responseHandler';
import { Logger } from '../utils/logger';

// ─── /api/auth: sign up, log in, log out, who am I ──────────
export const authRouter = Router();

// Slows down password guessing: 20 attempts per 15 minutes per address
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many attempts. Try again in a few minutes.', code: 'RATE_LIMIT_EXCEEDED' } },
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function parseEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) throw new HttpError('Enter a valid email address', 400, 'INVALID_EMAIL');
  return email;
}
function parsePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError('The password must be at least 8 characters', 400, 'WEAK_PASSWORD');
  if (value.length > 200) throw new HttpError('The password is too long', 400, 'INVALID_PASSWORD');
  return value;
}
function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 60) throw new HttpError('Enter your name (up to 60 characters)', 400, 'INVALID_NAME');
  return name;
}

authRouter.post('/signup', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = parseName(req.body?.name);
    const email = parseEmail(req.body?.email);
    const password = parsePassword(req.body?.password);
    await getUserStore().createUser({ email, name, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() });
    Logger.info('New viewer account created');
    setSessionCookie(req, res, email);
    return ResponseHandler.success(res, { name, email }, 201);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = email ? await getUserStore().getUser(email) : null;
    // Same answer whether the email or the password is wrong, so accounts can't be discovered this way
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return ResponseHandler.error(res, 'Wrong email or password', 401, 'BAD_CREDENTIALS');
    }
    setSessionCookie(req, res, email);
    return ResponseHandler.success(res, { name: user.name, email: user.email });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  clearSessionCookie(req, res);
  return ResponseHandler.success(res, { loggedOut: true });
});

authRouter.get('/me', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = res.locals.userEmail as string | undefined;
    const user = email ? await getUserStore().getUser(email) : null;
    if (!user) {
      clearSessionCookie(req, res); // the account no longer exists
      return ResponseHandler.error(res, 'Please log in to continue', 401, 'LOGIN_REQUIRED');
    }
    return ResponseHandler.success(res, { name: user.name, email: user.email });
  } catch (err) {
    next(err);
  }
});

// ─── /api/me: the signed-in viewer's own data ───────────────
export const meRouter = Router();
meRouter.use(requireUser);

const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const me = (res: Response) => res.locals.userEmail as string;

// My List and every video's progress (the watch history is the progress with a "seen" time)
meRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return ResponseHandler.success(res, await getUserStore().getData(me(res)));
  } catch (err) {
    next(err);
  }
});

meRouter.put('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > 500 || !items.every((x) => typeof x === 'string' && ID.test(x))) {
      throw new HttpError('items must be a list of up to 500 ids', 400, 'INVALID_LIST');
    }
    await getUserStore().setList(me(res), [...new Set(items as string[])]);
    return ResponseHandler.success(res, { saved: true });
  } catch (err) {
    next(err);
  }
});

meRouter.put('/progress/:videoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const videoId = req.params.videoId;
    if (!ID.test(videoId)) throw new HttpError('Invalid video id', 400, 'INVALID_ID');
    const { pos, seen, watched } = req.body || {};
    const patch: Record<string, any> = {};
    if (pos !== undefined) { if (typeof pos !== 'number' || !(pos >= 0) || pos > 1e6) throw new HttpError('pos must be seconds', 400, 'INVALID_BODY'); patch.pos = Math.round(pos * 10) / 10; }
    if (seen !== undefined) { if (typeof seen !== 'number' || !(seen > 0)) throw new HttpError('seen must be a time', 400, 'INVALID_BODY'); patch.seen = Math.round(seen); }
    if (watched !== undefined) { if (typeof watched !== 'boolean') throw new HttpError('watched must be true or false', 400, 'INVALID_BODY'); patch.watched = watched; }
    await getUserStore().setProgress(me(res), videoId, patch);
    return ResponseHandler.success(res, { saved: true });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/progress/:videoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!ID.test(req.params.videoId)) throw new HttpError('Invalid video id', 400, 'INVALID_ID');
    await getUserStore().deleteProgress(me(res), req.params.videoId);
    return ResponseHandler.success(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/progress', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await getUserStore().deleteProgress(me(res));
    return ResponseHandler.success(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});
