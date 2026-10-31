import type { ChatCompletionMessageParam } from "openai/resources";

import { chunkFormattedBook } from "../lib/chunker.js";
import { readAndFormatPdf } from "../lib/pdfFormatter.js";
import { mongoParentStore } from "../lib/db/mongo_store.js";
import { PinconeStore } from "../lib/db/pc_store.js";
import { build_system_prompt, flat_chunks, llm } from "../lib/llm/embedding.js";
import { MemoryRegistory } from "../lib/llm/memory_registory.js";

interface IIngestOption {
  filePath: string;
  bookTitle: string;
  namespace?: string;
  childTokenSize?: number;
  childOverlap?: number;
}

interface IQueryOption {
  query: string;
  namespace?: string;
  bookTitle?: string;
  filters?: Record<string, any>;
  topK?: number;
}

export interface IQueryResponse {
  answer?: string;
  sources: Array<{
    id: string;
    score: number;
    breadcrumb?: string;
    text?: string;
  }>;
}

export class RAGPipeline {
  constructor(
    private pcStore = new PinconeStore(),
    private parentStore = mongoParentStore,
    private llmClient = llm,
  ) {}

  async ingestDocument(option: IIngestOption) {
    const namespace = option.namespace ?? "child_chunks";
    const childTokenSize = option.childTokenSize ?? 350;
    const childOverlap = option.childOverlap ?? 60;

    let formatted = await readAndFormatPdf(option.filePath, {
      bookTitle: option.bookTitle,
    });

    const { parents, children } = chunkFormattedBook(formatted, {
      childChunkTokenSize: childTokenSize,
      childTokenOverlap: childOverlap,
    });

    let child_with_vec = [];

    for (let c of children) {
      let vector = await this.llmClient.generate_embedding(
        c.text,
        "NVIDIA",
        "passage",
      );

      if (!vector) {
        throw new Error(`Failed to generate embedding for child chunk ${c.id}`);
      }

      child_with_vec.push({
        chunk: c,
        vector,
      });
    }

    console.log(
      `Embedding generation completed for ${child_with_vec.length} child chunks.`,
    );

    await this.parentStore.upsertParents(parents);

    await this.pcStore.upsertChunks(child_with_vec, {
      namespace,
    });

    return {
      bookTitle: formatted.bookTitle,
      totalPages: formatted.totalPages,
      sectionsCount: formatted.sections.length,
      parentCount: parents.length,
      childCount: children.length,
    };
  }

  async query(option: IQueryOption) {
    const namespace = option.namespace ?? "child_chunks";

    let full_content = await this.hybrid_search({ ...option, namespace });

    if (!full_content || full_content.length === 0) {
      return {
        answer: "No relevant documents found matching your query. Please make sure the book has been ingested via /ingest.",
        sources: [],
      };
    }

    const user_message =
      "User Query : " +
      option.query +
      "\n" +
      "## Sources : \n " +
      flat_chunks(full_content);

    const res = await this.llmClient.generate_completion(user_message);

    return {
      answer: res?.content ?? undefined,
      sources: full_content.map((c) => ({
        id: String(c.chunkId || c._id),
        score: 0,
        breadcrumb: c.metadata.breadcrumb,
        text: c.text,
      })),
    };
  }

  // Hybrid Search: Pinecone Vector + MongoDB Text Search merged via RRF
  async hybrid_search(option: IQueryOption) {
    const namespace = option.namespace ?? "child_chunks";
    const topK = option.topK ?? 5;

    let userQueryEmbd = await this.llmClient.generate_embedding(
      option.query,
      "NVIDIA",
      "query",
    );

    if (!userQueryEmbd) {
      throw new Error("Failed to generate embedding for the user query.");
    }

    let keywords: string[] = [];
    try {
      keywords = await this.llmClient.get_keyword(option.query);
    } catch (err) {
      console.warn("[Hybrid Search] Could not extract LLM keywords, falling back to query terms.");
    }

    // If LLM returned no keywords, extract meaningful words from query
    if (!keywords || keywords.length === 0) {
      keywords = option.query
        .split(/\s+/)
        .map((w) => w.replace(/[^\w]/g, "").trim())
        .filter((w) => w.length > 2);
    }

    const [keyword_hits, vector_hits] = await Promise.all([
      this.parentStore.searchKeywordsAnd(keywords, topK),
      this.pcStore.search(userQueryEmbd, { topK, namespace }),
    ]);

    const k = 60;
    const score_map = new Map<string, number>();

    // 1. Process dense vector hits from Pinecone
    vector_hits.forEach((hit, rank) => {
      const parentId = hit.metadata?.parentId;
      if (parentId) {
        score_map.set(
          parentId,
          (score_map.get(parentId) || 0) + 1 / (k + rank + 1),
        );
      }
    });

    // 2. Process sparse keyword hits from MongoDB
    (keyword_hits || []).forEach((doc, rank) => {
      const chunkId = doc.chunkId;
      if (chunkId) {
        score_map.set(
          chunkId,
          (score_map.get(chunkId) || 0) + 1 / (k + rank + 1),
        );
      }
    });

    // 3. Rank top unique parent IDs by combined RRF score
    const topParentIds = Array.from(score_map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id]) => id)
      .filter(Boolean);

    if (topParentIds.length === 0) {
      return [];
    }

    return await this.parentStore.getParentsByIds(topParentIds);
  }
}
