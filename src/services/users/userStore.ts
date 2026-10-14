import * as path from 'path';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { JsonFileStore } from '../../utils/jsonFileStore';
import { HttpError } from '../../utils/responseHandler';

export interface UserProfile {
  email: string;          // normalised (lower case); also the account's key
  name: string;
  passwordHash: string;   // never leaves the server
  googleSub?: string;     // set for accounts created with Google sign-in
  createdAt: string;
}

// How far a viewer got with one video. `seen` (ms) orders the watch history.
export interface Progress {
  pos?: number;      // seconds
  seen?: number;     // when it was last watched
  watched?: boolean; // finished
}

export interface UserData {
  list: string[];                       // My List: video ids, and "series:<id>" for a series
  progress: Record<string, Progress>;   // by video id
}

export interface UserStore {
  getUser(email: string): Promise<UserProfile | null>;
  /** Fails with 409 when the email is already registered */
  createUser(user: UserProfile): Promise<void>;
  getData(email: string): Promise<UserData>;
  setList(email: string, list: string[]): Promise<void>;
  setProgress(email: string, videoId: string, patch: Progress): Promise<void>;
  /** One video's progress, or everything when videoId is omitted (clears the history) */
  deleteProgress(email: string, videoId?: string): Promise<void>;
}

const taken = () => new HttpError('An account with this email already exists. Log in instead.', 409, 'EMAIL_TAKEN');
const merge = (a: Progress | undefined, b: Progress): Progress => {
  const out: Progress = { ...(a || {}) };
  if (b.pos !== undefined) out.pos = b.pos;
  if (b.seen !== undefined) out.seen = b.seen;
  if (b.watched !== undefined) out.watched = b.watched;
  return out;
};

// ─── Local mode: users.json ──────────────────────────────────
interface JsonUser extends UserProfile { list?: string[]; progress?: Record<string, Progress> }

class JsonUserStore implements UserStore {
  private store = new JsonFileStore<JsonUser>(path.join(path.resolve(process.env.LOCAL_DATA_DIR || './data'), 'users.json'));

  async getUser(email: string) {
    const u = (await this.store.read()).find((x) => x.email === email);
    if (!u) return null;
    return { email: u.email, name: u.name, passwordHash: u.passwordHash, googleSub: u.googleSub, createdAt: u.createdAt };
  }

  async createUser(user: UserProfile) {
    await this.store.transaction((items) => {
      if (items.some((x) => x.email === user.email)) throw taken();
      items.push({ ...user, list: [], progress: {} });
      return { result: undefined, write: true };
    });
  }

  async getData(email: string): Promise<UserData> {
    const u = (await this.store.read()).find((x) => x.email === email);
    return { list: u?.list || [], progress: u?.progress || {} };
  }

  private change(email: string, fn: (u: JsonUser) => void) {
    return this.store.transaction((items) => {
      const u = items.find((x) => x.email === email);
      if (!u) return { result: undefined, write: false };
      fn(u);
      return { result: undefined, write: true };
    });
  }

  async setList(email: string, list: string[]) { await this.change(email, (u) => { u.list = list; }); }

  async setProgress(email: string, videoId: string, patch: Progress) {
    await this.change(email, (u) => { u.progress = { ...(u.progress || {}), [videoId]: merge(u.progress?.[videoId], patch) }; });
  }

  async deleteProgress(email: string, videoId?: string) {
    await this.change(email, (u) => {
      if (videoId === undefined) u.progress = {};
      else if (u.progress) delete u.progress[videoId];
    });
  }
}

// ─── AWS: a table of its own (USERS_TABLE_NAME) ──────────────
// pk = "USER#<email>"; sk = "PROFILE" | "LIST" | "PROGRESS#<videoId>".
// Everything about one person shares a partition, so one Query loads it all.
class DynamoUserStore implements UserStore {
  private doc = (() => { const { createDocClient } = require('../db/dynamoDb'); return createDocClient(); })();
  private table = (() => {
    const t = process.env.USERS_TABLE_NAME;
    if (!t) throw new Error('USERS_TABLE_NAME is required when PROVIDER=aws');
    return t;
  })();
  private pk = (email: string) => `USER#${email}`;

  async getUser(email: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: this.pk(email), sk: 'PROFILE' }, ConsistentRead: true }));
    if (!r.Item) return null;
    const { email: e, name, passwordHash, googleSub, createdAt } = r.Item;
    return { email: e, name, passwordHash, googleSub, createdAt };
  }

  async createUser(user: UserProfile) {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { pk: this.pk(user.email), sk: 'PROFILE', ...user },
        ConditionExpression: 'attribute_not_exists(pk)', // one account per email
      }));
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') throw taken();
      throw err;
    }
  }

  async getData(email: string): Promise<UserData> {
    const data: UserData = { list: [], progress: {} };
    let startKey: Record<string, any> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': this.pk(email) },
        ExclusiveStartKey: startKey,
      }));
      for (const item of r.Items || []) {
        if (item.sk === 'LIST') data.list = item.items || [];
        else if (String(item.sk).startsWith('PROGRESS#')) {
          data.progress[String(item.sk).slice('PROGRESS#'.length)] = { pos: item.pos, seen: item.seen, watched: item.watched };
        }
      }
      startKey = r.LastEvaluatedKey;
    } while (startKey);
    return data;
  }

  async setList(email: string, list: string[]) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: this.pk(email), sk: 'LIST', items: list } }));
  }

  async setProgress(email: string, videoId: string, patch: Progress) {
    const sets: string[] = [];
    const values: Record<string, any> = {};
    (['pos', 'seen', 'watched'] as const).forEach((k) => {
      if (patch[k] !== undefined) { sets.push(`${k} = :${k}`); values[`:${k}`] = patch[k]; }
    });
    if (!sets.length) return;
    await this.doc.send(new UpdateCommand({
      TableName: this.table,
      Key: { pk: this.pk(email), sk: `PROGRESS#${videoId}` },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
    }));
  }

  async deleteProgress(email: string, videoId?: string) {
    if (videoId !== undefined) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: this.pk(email), sk: `PROGRESS#${videoId}` } }));
      return;
    }
    const all = Object.keys((await this.getData(email)).progress);
    for (const id of all) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: this.pk(email), sk: `PROGRESS#${id}` } }));
    }
  }
}

let instance: UserStore | null = null;
export const getUserStore = (): UserStore =>
  (instance ??= process.env.PROVIDER === 'aws' ? new DynamoUserStore() : new JsonUserStore());
