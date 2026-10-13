import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Series } from '../../types';
import { createDocClient, queryAllByEntity, SERIES_ENTITY, tableName } from '../db/dynamoDb';

const KEY_PREFIX = 'series#';
const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Series kept in the videos table (a series item's key is "series#<id>"), with the same read() and
 * transaction() shape as the JSON file store so the series service does not care which one it has.
 *
 * transaction() reads every series, lets the caller change the list, and writes back only what
 * changed. Each write is conditional on the item not having changed since it was read; if another
 * request got there first, the whole thing is re-read and run again.
 */
export class DynamoSeriesStore {
  private doc = createDocClient();
  private table = tableName();

  async read(): Promise<Series[]> {
    const items = await queryAllByEntity(this.doc, this.table, SERIES_ENTITY);
    return items.map(({ entity, id, ...rest }) => ({ ...rest, id: String(id).slice(KEY_PREFIX.length) }) as Series);
  }

  async transaction<R>(fn: (items: Series[]) => { result: R; write: boolean }): Promise<R> {
    for (let attempt = 1; ; attempt++) {
      const items = await this.read();
      const before = new Map(items.map((s) => [s.id, JSON.stringify(s)]));
      const { result, write } = fn(items);
      if (!write) return result;

      try {
        const stillThere = new Set<string>();
        for (const series of items) {
          stillThere.add(series.id);
          const old = before.get(series.id);
          if (old === JSON.stringify(series)) continue; // untouched
          const oldUpdatedAt = old ? (JSON.parse(old) as Series).updatedAt : undefined;
          await this.doc.send(
            new PutCommand({
              TableName: this.table,
              Item: { ...series, id: KEY_PREFIX + series.id, entity: SERIES_ENTITY },
              ...(oldUpdatedAt
                ? { ConditionExpression: 'updatedAt = :old', ExpressionAttributeValues: { ':old': oldUpdatedAt } }
                : { ConditionExpression: 'attribute_not_exists(id)' }),
            })
          );
        }
        for (const [id, old] of before) {
          if (stillThere.has(id)) continue; // removed from the list: delete it
          await this.doc.send(
            new DeleteCommand({
              TableName: this.table,
              Key: { id: KEY_PREFIX + id },
              ConditionExpression: 'updatedAt = :old',
              ExpressionAttributeValues: { ':old': (JSON.parse(old) as Series).updatedAt },
            })
          );
        }
        return result;
      } catch (err: any) {
        if (err.name !== 'ConditionalCheckFailedException' || attempt >= MAX_ATTEMPTS) throw err;
        await sleep(80 * attempt); // someone else changed it first: read again and retry
      }
    }
  }
}
