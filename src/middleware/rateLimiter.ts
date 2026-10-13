import rateLimit from 'express-rate-limit';

// Public site API: generous, since a page load makes a few requests and the site refreshes in the
// background. Admin routes are not rate limited here; they sit behind the admin sign-in instead.
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: 'Too many requests from this IP, please try again in a few minutes',
      code: 'RATE_LIMIT_EXCEEDED',
    },
  },
});
