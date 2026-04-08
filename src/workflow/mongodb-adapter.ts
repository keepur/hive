import type { Collection, Document, Filter, UpdateFilter } from "mongodb";
import type { ICollectionAdapter, FindOptions, UpdateResult, DeleteResult } from "@dodi-hq/fsm-persistence";

/**
 * MongoDB native driver adapter implementing ICollectionAdapter.
 * Bridges @dodi-hq/fsm-persistence's generic interface to mongodb's Collection.
 */
export class MongoDBAdapter<T extends Document> implements ICollectionAdapter<T> {
  constructor(private collection: Collection<T>) {}

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.collection.findOne(filter as Filter<T>) as Promise<T | null>;
  }

  async find(filter: Record<string, unknown>, options?: FindOptions): Promise<T[]> {
    let cursor = this.collection.find(filter as Filter<T>);
    if (options?.sort) cursor = cursor.sort(options.sort as any);
    if (options?.skip) cursor = cursor.skip(options.skip);
    if (options?.limit) cursor = cursor.limit(options.limit);
    if (options?.projection) cursor = cursor.project(options.projection);
    return cursor.toArray() as Promise<T[]>;
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: "before" | "after" },
  ): Promise<T | null> {
    const result = await this.collection.findOneAndUpdate(filter as Filter<T>, update as UpdateFilter<T>, {
      returnDocument: options?.returnDocument ?? "after",
    });
    return result as T | null;
  }

  async insertOne(doc: T): Promise<string> {
    const result = await this.collection.insertOne(doc as any);
    return result.insertedId.toString();
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<UpdateResult> {
    const result = await this.collection.updateOne(filter as Filter<T>, update as UpdateFilter<T>);
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async deleteOne(filter: Record<string, unknown>): Promise<DeleteResult> {
    const result = await this.collection.deleteOne(filter as Filter<T>);
    return { deletedCount: result.deletedCount };
  }
}
