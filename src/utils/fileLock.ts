import * as fs from 'fs';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cross-process lock built on an exclusively created lock file.
 *
 * The API, the worker and the transcoder subprocess all read-modify-write the same JSON
 * files in local mode. An in-process mutex can't protect against that, so this serialises
 * the whole read-modify-write across processes. A lock older than `staleMs` is assumed to
 * belong to a crashed process and is removed.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  { timeoutMs = 10000, staleMs = 15000 }: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      await handle.close();
      break;
    } catch (err: any) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      try {
        const stats = await fs.promises.stat(lockPath);
        if (Date.now() - stats.mtimeMs > staleMs) {
          await fs.promises.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch { /* the holder released it between our attempts */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
      await sleep(15 + Math.random() * 25);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.promises.unlink(lockPath).catch(() => {});
  }
}

/** Write via a temp file and rename, so readers never see a half-written file. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, content, 'utf8');
  // On Windows a rename can fail briefly while another process has the target open
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, filePath);
      return;
    } catch (err: any) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw err;
      }
      await sleep(20 * (attempt + 1));
    }
  }
}
