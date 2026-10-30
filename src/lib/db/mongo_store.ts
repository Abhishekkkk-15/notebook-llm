import type { IParentChunk } from "../../types/chunktypes.js";

import { connectMongo } from "./mongo.js";
import { ParentChunkModel, type IParentChunkDoc } from "./parent_chunk.model.js";

/**
 * ============================================================================
 * MONGO PARENT STORE
 * ============================================================================
 *
 * Provides persistence and retrieval methods for full parent chunk documents
 * in MongoDB via Mongoose.
 *
 * In a Hierarchical Parent-Document RAG architecture:
 * 1. Pinecone stores child vectors (200-token slices) for semantic similarity search.
 * 2. MongoDB stores full parent chunks (complete sections/chapters) for rich LLM context.
 * 3. When a child chunk matches in Pinecone, query this store using its `parentId`
 *    to retrieve the full parent content for synthesis.
 */
export class MongoParentStore {
  /**
   * Ensures MongoDB connection before executing operations.
   */
  private async ensureConnected(): Promise<void> {
    await connectMongo();
  }

  /**
   * Upsert a single parent chunk.
   */
  async upsertParent(parent: IParentChunk): Promise<IParentChunkDoc> {
    await this.ensureConnected();

    const result = await ParentChunkModel.findOneAndUpdate(
      { chunkId: parent.id },
      {
        $set: {
          chunkId: parent.id,
          text: parent.text,
          tokenCount: parent.tokenCount,
          metadata: parent.metadata,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return result!;
  }

  /**
   * Bulk upserts multiple parent chunks using batch bulkWrite operations.
   */
  async upsertParents(
    parents: IParentChunk[],
    options?: { batchSize?: number },
  ): Promise<{ upsertedCount: number; modifiedCount: number }> {
    await this.ensureConnected();

    if (parents.length === 0) {
      return { upsertedCount: 0, modifiedCount: 0 };
    }

    const batchSize = options?.batchSize ?? 100;
    let totalUpserted = 0;
    let totalModified = 0;

    for (let i = 0; i < parents.length; i += batchSize) {
      const batch = parents.slice(i, i + batchSize);

      const ops = batch.map((parent) => ({
        updateOne: {
          filter: { chunkId: parent.id },
          update: {
            $set: {
              chunkId: parent.id,
              text: parent.text,
              tokenCount: parent.tokenCount,
              metadata: parent.metadata,
            },
          },
          upsert: true,
        },
      }));

      const res = await ParentChunkModel.bulkWrite(ops);
      totalUpserted += res.upsertedCount;
      totalModified += res.modifiedCount;
    }

    return {
      upsertedCount: totalUpserted,
      modifiedCount: totalModified,
    };
  }

  /**
   * Retrieve a single parent chunk by its chunk ID.
   */
  async getParentById(chunkId: string): Promise<IParentChunkDoc | null> {
    await this.ensureConnected();
    return await ParentChunkModel.findOne({ chunkId }).exec();
  }

  /**
   * Retrieve multiple parent chunks by an array of IDs.
   * Useful when Pinecone returns multiple child matches with different parentIds.
   */
  async getParentsByIds(chunkIds: string[]): Promise<IParentChunkDoc[]> {
    await this.ensureConnected();
    if (chunkIds.length === 0) return [];

    // Deduplicate IDs
    const uniqueIds = Array.from(new Set(chunkIds));
    return await ParentChunkModel.find({
      chunkId: { $in: uniqueIds },
    }).exec();
  }

  /**
   * Retrieve all parent chunks belonging to a specific book.
   */
  async getParentsByBook(bookTitle: string): Promise<IParentChunkDoc[]> {
    await this.ensureConnected();
    return await ParentChunkModel.find({
      "metadata.bookTitle": bookTitle,
    })
      .sort({ "metadata.chapterNumber": 1 })
      .exec();
  }

  /**
   * Delete a parent chunk by chunk ID.
   */
  async deleteParentById(chunkId: string): Promise<boolean> {
    await this.ensureConnected();
    const res = await ParentChunkModel.deleteOne({ chunkId });
    return res.deletedCount > 0;
  }

  /**
   * Delete all parent chunks of a book.
   */
  async deleteParentsByBook(bookTitle: string): Promise<number> {
    await this.ensureConnected();
    const res = await ParentChunkModel.deleteMany({
      "metadata.bookTitle": bookTitle,
    });
    return res.deletedCount;
  }

  /**
   * Get the total count of parent chunks stored.
   */
  async countParents(filter?: Record<string, any>): Promise<number> {
    await this.ensureConnected();
    return await ParentChunkModel.countDocuments(filter || {});
  }
}

export const mongoParentStore = new MongoParentStore();
