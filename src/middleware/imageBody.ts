import express, { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/responseHandler';
import { MAX_IMAGE_BYTES } from '../services/thumbnail/thumbnailService';

// Reads an image sent as the raw request body (Content-Type: image/jpeg, image/png or image/webp).
// Anything else leaves req.body as a non-Buffer, which the route answers with 415.
const raw = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES });

export function imageBody(req: Request, res: Response, next: NextFunction) {
  raw(req, res, (err?: any) => {
    if (err) return next(new HttpError(`Images can be up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB (JPEG, PNG or WebP)`, 413, 'IMAGE_TOO_LARGE'));
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return next(new HttpError('Send the image as the request body with an image/jpeg, image/png or image/webp content type', 415, 'UNSUPPORTED_IMAGE'));
    }
    next();
  });
}
