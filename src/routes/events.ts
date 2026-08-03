import { Router, Request, Response } from 'express';
import { dbService } from '../services/db/dbService';
import { Logger } from '../utils/logger';

const router = Router();

// Track all active SSE client responses
const clients: Set<Response> = new Set();

// Internal helper to broadcast an event to every connected client
function broadcast(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((client) => {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  });
}

// Start background polling loop to detect database changes and push to clients
let lastSnapshot: Record<string, string> = {}; // videoId -> status:progress

async function startPolling() {
  setInterval(async () => {
    if (clients.size === 0) return; // no clients — skip polling

    try {
      const result = await dbService.listVideos(1, 100);
      const videos = result.videos;

      for (const video of videos) {
        const key = `${video.status}:${video.progress}`;
        if (lastSnapshot[video.id] !== key) {
          lastSnapshot[video.id] = key;
          broadcast('video-update', video);
        }
      }
    } catch (err: any) {
      Logger.debug('SSE polling error', err.message);
    }
  }, 2000);
}

startPolling();

// GET /api/events — SSE endpoint
router.get('/', (req: Request, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering if proxied
  res.flushHeaders();

  clients.add(res);
  Logger.info(`SSE client connected. Total clients: ${clients.size}`);

  // Send initial snapshot of all videos immediately on connect
  dbService.listVideos(1, 100).then((result) => {
    const payload = `event: initial-load\ndata: ${JSON.stringify(result.videos)}\n\n`;
    res.write(payload);
  }).catch(() => {});

  // Heartbeat every 30s to prevent proxy/firewall timeouts
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Clean up on client disconnect
  req.on('close', () => {
    clients.delete(res);
    clearInterval(heartbeat);
    Logger.info(`SSE client disconnected. Total clients: ${clients.size}`);
  });
});

export default router;
