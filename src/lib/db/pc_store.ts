import { Pinecone, type Index } from "@pinecone-database/pinecone";
import type {
  IChunkPineconeMetadata,
  IPCChildChunk,
} from "../../types/pctypes.js";
import type { IChildChunk } from "../../types/chunktypes.js";
import { llm } from "../llm/embedding.js";
import type { Embedding } from "openai/resources";

export class PinconeStore {
  private index: Index<IChunkPineconeMetadata>;
  private defaultNamespace: string;

  constructor(defaultNamespace = "default") {
    const pinecode_key = process.env.PC_API_KEY;
    const pc_index = process.env.PC_INDEX;

    if (!pinecode_key || !pc_index) {
      throw new Error("both are required");
    }

    const pc = new Pinecone({
      apiKey: pinecode_key,
    });

    this.index = pc.index<IChunkPineconeMetadata>(pc_index);
    this.defaultNamespace = defaultNamespace;
  }

  private toPineconeRecord(chunk: IChildChunk, vector: number[]) {
    return {
      id: chunk.id,
      values: vector,
      metadata: {
        projectId: chunk.metadata.projectId ?? "",
        parentId: chunk.parentId,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        bookTitle: chunk.metadata.bookTitle,
        chapterNumber: chunk.metadata.chapterNumber,
        chapterTitle: chunk.metadata.chapterTitle,
        subtopicTitle: chunk.metadata.subtopicTitle,
        breadcrumb: chunk.metadata.breadcrumb,
        type: chunk.metadata.type ?? "text",
        imageUrl: chunk.metadata.imageUrls?.[0] ?? "",
        imageUrls: chunk.metadata.imageUrls ?? [],
        imageCaptions:
          chunk.metadata.imageCaptions ??
          (chunk.metadata.images ?? [])
            .map((img) => img.caption || "")
            .filter(Boolean),
        imagesJson: JSON.stringify(chunk.metadata.images ?? []),
        hasImages: (chunk.metadata.imageUrls?.length ?? 0) > 0,
        hasDiagrams: chunk.metadata.hasDiagrams ?? false,
      },
    };
  }

  async upsertChunks(
    chunks: Array<{ chunk: IChildChunk; vector: number[] }>,
    options?: { namespace?: string; batchSize?: number },
  ) {
    const ns = this.index.namespace(
      options?.namespace ?? this.defaultNamespace,
    );
    const batchSize = options?.batchSize ?? 40;

    const records = chunks.map(({ chunk, vector }) =>
      this.toPineconeRecord(chunk, vector),
    );

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await ns.upsert({ records: batch });
    }

    return { upsertedCount: records.length };
  }

  /**
   * Run semantic similarity search
   */
  async search(
    queryVector: number[],
    options?: {
      topK?: number;
      namespace?: string;
      filter?: Record<string, any>;
    },
  ) {
    const ns = this.index.namespace(
      options?.namespace ?? this.defaultNamespace,
    );

    const response = await ns.query({
      vector: queryVector,
      topK: options?.topK ?? 5,
      includeMetadata: true,
      includeValues: false,
      filter: options?.filter,
    });

    // Clean up matches into a friendlier shape
    return response.matches.map((match) => ({
      id: match.id,
      score: match.score ?? 0,
      metadata: match.metadata!,
    }));
  }

  /**
   * Delete by record IDs
   */
  async deleteByIds(ids: string[], namespace?: string) {
    const ns = this.index.namespace(namespace ?? this.defaultNamespace);
    await ns.deleteMany(ids);
  }

  /**
   * Delete all vectors belonging to a specific project
   */
  async deleteByProjectId(projectId: string, namespace?: string) {
    const ns = this.index.namespace(namespace ?? this.defaultNamespace);
    await ns.deleteMany({ filter: { projectId: { $eq: projectId } } });
  }

  /**
   * Wipe an entire namespace
   */
  async clearNamespace(namespace?: string) {
    const ns = this.index.namespace(namespace ?? this.defaultNamespace);
    await ns.deleteAll();
  }

  /**
   * Wipe all vectors across all namespaces (or specific namespace)
   */
  async deleteAllVectors(namespace?: string): Promise<void> {
    if (namespace) {
      const ns = this.index.namespace(namespace);
      await ns.deleteAll();
      return;
    }

    try {
      const stats = await this.index.describeIndexStats();
      const namespaces = Object.keys(stats.namespaces || {});
      if (namespaces.length === 0) {
        await this.index.namespace(this.defaultNamespace).deleteAll();
      } else {
        await Promise.all(
          namespaces.map((ns) => this.index.namespace(ns).deleteAll()),
        );
      }
    } catch {
      await this.index.namespace(this.defaultNamespace).deleteAll();
    }
  }
}
