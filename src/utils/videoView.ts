import { VideoRecord } from '../types';
import { videoService } from '../services/video/videoService';

// Lists and live updates leave out the processing log (it can be long); the detail view includes it.
export function withoutEvents(video: VideoRecord): Omit<VideoRecord, 'events'> & { eventCount: number } {
  const { events, ...rest } = video;
  return { ...rest, eventCount: events ? events.length : 0 };
}

// What admin responses return for a video: the log left out, and the addresses a client should use
// (CDN, and the admin's own thumbnail if one is set), so the UI can simply replace its copy.
export function summary(video: VideoRecord) {
  return withoutEvents(videoService.present(video));
}
