import * as path from 'path';
import { Series } from '../../types';
import { HttpError } from '../../utils/responseHandler';
import { JsonFileStore } from '../../utils/jsonFileStore';

export const MAX_SEASON = 99;
export const MAX_EPISODE = 9999;

// Series are stored in series.json next to db.json (local mode). Created on first use so AWS-only
// deployments don't create local files. A DynamoDB version belongs with the other AWS services.
let store: JsonFileStore<Series> | null = null;
const getStore = () =>
  (store ||= new JsonFileStore<Series>(path.join(path.resolve(process.env.LOCAL_DATA_DIR || './data'), 'series.json')));

export function parseSeasonNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SEASON) {
    throw new HttpError(`Season must be a whole number from 0 to ${MAX_SEASON} (0 is for specials)`, 400, 'INVALID_SEASON');
  }
  return n;
}

export function parseEpisodeNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_EPISODE) {
    throw new HttpError(`Episode must be a whole number from 1 to ${MAX_EPISODE}`, 400, 'INVALID_EPISODE');
  }
  return n;
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError('A series needs a title', 400, 'INVALID_TITLE');
  const title = value.trim().replace(/\s+/g, ' ');
  if (title.length > 120) throw new HttpError('The title must be 120 characters or fewer', 400, 'INVALID_TITLE');
  return title;
}

function parseDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError('The description must be text', 400, 'INVALID_DESCRIPTION');
  const text = value.trim();
  if (text.length > 2000) throw new HttpError('The description must be 2000 characters or fewer', 400, 'INVALID_DESCRIPTION');
  return text || undefined;
}

const notFound = (id: string) => new HttpError(`Series ${id} not found`, 404, 'SERIES_NOT_FOUND');

export const seriesService = {
  async list(): Promise<Series[]> {
    const all = await getStore().read();
    return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  async get(id: string): Promise<Series | null> {
    return (await getStore().read()).find((s) => s.id === id) || null;
  },

  async require(id: string): Promise<Series> {
    const series = await this.get(id);
    if (!series) throw notFound(id);
    return series;
  },

  async create(input: { title: unknown; description?: unknown }): Promise<Series> {
    const title = parseTitle(input.title);
    const description = parseDescription(input.description);
    const now = new Date().toISOString();
    const series: Series = {
      id: Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 8),
      title,
      description,
      published: false, // a new series stays hidden until an admin publishes it
      seasons: [1],
      createdAt: now,
      updatedAt: now,
    };
    return getStore().transaction((items) => {
      items.push(series);
      return { result: series, write: true };
    });
  },

  async update(id: string, input: { title?: unknown; description?: unknown; published?: unknown }): Promise<Series> {
    const patch: Partial<Series> = {};
    if (input.title !== undefined) patch.title = parseTitle(input.title);
    if (input.description !== undefined) patch.description = parseDescription(input.description);
    if (input.published !== undefined) {
      if (typeof input.published !== 'boolean') throw new HttpError('published must be true or false', 400, 'INVALID_BODY');
      patch.published = input.published;
    }
    return getStore().transaction((items) => {
      const series = items.find((s) => s.id === id);
      if (!series) throw notFound(id);
      const now = new Date().toISOString();
      Object.assign(series, patch, { updatedAt: now });
      if (patch.published === true && !series.publishedAt) series.publishedAt = now;
      return { result: { ...series }, write: true };
    });
  },

  // Makes sure the season exists, e.g. when an episode is added to "Season 3"
  async ensureSeason(id: string, season: number): Promise<Series> {
    return getStore().transaction((items) => {
      const series = items.find((s) => s.id === id);
      if (!series) throw notFound(id);
      if (series.seasons.includes(season)) return { result: { ...series }, write: false };
      series.seasons = [...series.seasons, season].sort((a, b) => a - b);
      series.updatedAt = new Date().toISOString();
      return { result: { ...series }, write: true };
    });
  },

  async addSeason(id: string, season: unknown): Promise<Series> {
    return this.ensureSeason(id, parseSeasonNumber(season));
  },

  async removeSeason(id: string, season: number, hasEpisodes: boolean): Promise<Series> {
    if (hasEpisodes) throw new HttpError('This season still has episodes. Move or remove them first.', 409, 'SEASON_NOT_EMPTY');
    return getStore().transaction((items) => {
      const series = items.find((s) => s.id === id);
      if (!series) throw notFound(id);
      series.seasons = series.seasons.filter((n) => n !== season);
      series.updatedAt = new Date().toISOString();
      return { result: { ...series }, write: true };
    });
  },

  async setPoster(id: string, posterKey: string | undefined): Promise<Series> {
    return getStore().transaction((items) => {
      const series = items.find((s) => s.id === id);
      if (!series) throw notFound(id);
      series.posterKey = posterKey;
      series.updatedAt = new Date().toISOString();
      return { result: { ...series }, write: true };
    });
  },

  async delete(id: string): Promise<void> {
    await getStore().transaction((items) => {
      const index = items.findIndex((s) => s.id === id);
      if (index === -1) throw notFound(id);
      items.splice(index, 1);
      return { result: undefined, write: true };
    });
  },
};
