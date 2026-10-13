import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './fileLock';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Serialises work inside this process; the file lock below covers other processes
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * A small list of records kept in one JSON file (local mode). Every change is a locked
 * read-modify-write, safe across the API, worker and scripts that share the file.
 */
export class JsonFileStore<T> {
  private lockPath: string;
  private mutex = new Mutex();

  constructor(private filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8');
    this.lockPath = `${filePath}.lock`;
  }

  // Readers tolerate a bad read; writers (below) must not, or an empty list could be written back
  async read(): Promise<T[]> {
    try {
      return JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  private async readStrict(): Promise<T[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
      } catch (err: any) {
        if (attempt >= 4) throw new Error(`Failed to read ${path.basename(this.filePath)}: ${err.message}`);
        await sleep(25 * (attempt + 1));
      }
    }
  }

  transaction<R>(fn: (items: T[]) => { result: R; write: boolean }): Promise<R> {
    return this.mutex.run(() =>
      withFileLock(this.lockPath, async () => {
        const items = await this.readStrict();
        const { result, write } = fn(items);
        if (write) await writeFileAtomic(this.filePath, JSON.stringify(items, null, 2));
        return result;
      })
    );
  }
}
