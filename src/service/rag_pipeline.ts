import type { ChatCompletionMessageParam } from "openai/resources";

import { chunkFormattedBook } from "../lib/chunker.js";
import { readAndFormatPdf } from "../lib/pdfFormatter.js";
import { mongoParentStore } from "../lib/db/mongo_store.js";
import { PinconeStore } from "../lib/db/pc_store.js";
import { build_system_prompt, llm } from "../lib/llm/embedding.js";

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
        throw new Error(
          `Failed to generate embedding for child chunk ${c.id}`,
        );
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

    let userQueryEmbd = await this.llmClient.generate_embedding(
      option.query,
      "NVIDIA",
      "query",
    );

    if (!userQueryEmbd) {
      throw new Error("Failed to generate embedding for the user query.");
    }

    let child_chunks = await this.pcStore.search(userQueryEmbd, {
      namespace,
      filter: option.filters,
      topK: option.topK ?? 5,
    });

    let parent_ids: string[] = child_chunks.map((c) => c.metadata.parentId);

    let full_content = await this.parentStore.getParentsByIds(parent_ids);

    let sys_prompt = build_system_prompt(full_content);

    let messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: sys_prompt,
      },
      {
        role: "user",
        content: option.query,
      },
    ];

    const res = await this.llmClient.generate_completion(messages);

    return {
      answer: res?.content ?? undefined,
      sources: child_chunks.map((c) => ({
        id: c.id,
        score: c.score,
        breadcrumb: c.metadata.breadcrumb,
        text: c.metadata.text,
      })),
    };
  }
}
