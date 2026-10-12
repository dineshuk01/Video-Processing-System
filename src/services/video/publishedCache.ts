// Short-lived cache of "is this video published?" for media requests: a player fetches many
// segments per video, so the database is not read on every one.
const TTL_MS = 5000;
const cache = new Map<string, { ok: boolean; expires: number }>();

export function getPublishedCache(id: string): boolean | undefined {
  const hit = cache.get(id);
  return hit && hit.expires > Date.now() ? hit.ok : undefined;
}

export function setPublishedCache(id: string, ok: boolean) {
  cache.set(id, { ok, expires: Date.now() + TTL_MS });
}

// Called whenever publishing changes, so a (un)publish takes effect immediately in this process
export function clearPublishedCache(id: string) {
  cache.delete(id);
}
