import type { IParentChunk } from "../../types/chunktypes.js";

import { connectMongo } from "./mongo.js";
import {
  ParentChunkModel,
  type IParentChunkDoc,
} from "./parent_chunk.model.js";

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
  private static indexesEnsured = false;

  /**
   * Ensures MongoDB connection and indexes before executing operations.
   */
  private async ensureConnected(): Promise<void> {
    await connectMongo();
    if (!MongoParentStore.indexesEnsured) {
      try {
        await ParentChunkModel.createIndexes();
        MongoParentStore.indexesEnsured = true;
      } catch (err) {
        console.warn("[MongoDB] Warning while ensuring indexes:", err);
      }
    }
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
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );

    return result!;
  }

  /**
   * Bulk upsert parent chunks in batches.
   */
  async upsertParents(
    parents: IParentChunk[],
    batchSize = 50,
  ): Promise<{ upsertedCount: number; modifiedCount: number }> {
    await this.ensureConnected();

    let totalUpserted = 0;
    let totalModified = 0;

    for (let i = 0; i < parents.length; i += batchSize) {
      const slice = parents.slice(i, i + batchSize);
      const operations = slice.map((parent) => ({
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

      const res = await ParentChunkModel.bulkWrite(operations, {
        ordered: false,
      });
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

    // Deduplicate IDs and remove nulls/undefined
    const uniqueIds = Array.from(new Set(chunkIds)).filter(Boolean);
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
   * Retrieve all parent chunks belonging to a specific project.
   */
  async getParentsByProject(projectId: string): Promise<IParentChunkDoc[]> {
    await this.ensureConnected();
    return await ParentChunkModel.find({
      "metadata.projectId": projectId,
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
   * Delete all parent chunks of a project.
   */
  async deleteParentsByProject(projectId: string): Promise<number> {
    await this.ensureConnected();
    const res = await ParentChunkModel.deleteMany({
      "metadata.projectId": projectId,
    });
    return res.deletedCount;
  }

  /**
   * Delete ALL parent chunks from MongoDB.
   */
  async deleteAllParents(): Promise<number> {
    await this.ensureConnected();
    const res = await ParentChunkModel.deleteMany({});
    return res.deletedCount;
  }

  /**
   * Get the total count of parent chunks stored.
   */
  async countParents(filter?: Record<string, any>): Promise<number> {
    await this.ensureConnected();
    return await ParentChunkModel.countDocuments(filter || {});
  }

  /**
   * Full-text keyword search across parent chunks using MongoDB $text index.
   */
  async searchKeywordsAnd(
    keywords: string[],
    limit = 5,
    filter?: Record<string, any>,
  ): Promise<IParentChunkDoc[]> {
    await this.ensureConnected();

    if (!keywords || keywords.length === 0) {
      return [];
    }

    // Do NOT force quotes around every term: space-separated terms act as an OR search
    // ranked by relevance (textScore), which prevents strict zero-match failures
    const searchString = keywords
      .map((kw) => kw.replace(/[",*]/g, "").trim())
      .filter((kw) => kw.length > 0)
      .join(" ");

    if (!searchString.trim()) {
      return [];
    }

    const query: Record<string, any> = {
      $text: { $search: searchString },
      ...(filter || {}),
    };

    try {
      return (await ParentChunkModel.find(
        query,
        { score: { $meta: "textScore" } },
      )
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .exec()) as unknown as (IParentChunkDoc & { score: number })[];
    } catch (err: any) {
      if (err?.message?.includes("text index required")) {
        console.warn("[MongoDB] Building text index now, please retry in a moment...");
        await ParentChunkModel.createIndexes();
      }
      return [];
    }
  }
}

export const mongoParentStore = new MongoParentStore();
