import { VideoRecord } from '../types';

// Lists and live updates leave out the processing log (it can be long); the detail view includes it.
export function withoutEvents(video: VideoRecord): Omit<VideoRecord, 'events'> & { eventCount: number } {
  const { events, ...rest } = video;
  return { ...rest, eventCount: events ? events.length : 0 };
}
