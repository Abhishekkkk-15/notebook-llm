import { chunkFormattedBook } from "../lib/chunker.js";
import { mongoParentStore } from "../lib/db/mongo_store.js";
import { PinconeStore } from "../lib/db/pc_store.js";
import { llm } from "../lib/llm/embedding.js";
import { readAndFormatPdf } from "../lib/pdfFormatter.js";

interface IIngestOption {
  filePath: string;
  bookTitle: string;
  namespace: string;
  childTokenSize: number;
  childOverlap: number;
}

export class RAGPipeline {
  constructor(
    private pcStore = new PinconeStore(),
    private parentStore = mongoParentStore,
    private llmClient = llm,
  ) {}

  async ingestDocument(option: IIngestOption) {
    let formatted = await readAndFormatPdf(option.filePath, {
      bookTitle: option.bookTitle,
    });

    const { parents, children } = chunkFormattedBook(formatted, {
      childChunkTokenSize: 350,
      childTokenOverlap: 60,
    });

    let child_with_vec = [];

    for (let c of children) {
      let vector = await llm.generate_embedding(c.text);

      child_with_vec.push({
        chunk: c,
        vector: vector ? vector : [1, 1, 2, 3, 4],
      });
    }

    console.log(
      "embedding generation completed",
      child_with_vec[child_with_vec.length - 1],
    );

    await this.parentStore.upsertParents(parents);

    const count = await this.pcStore.upsertChunks(child_with_vec, {
      namespace: "child_chunks",
    });

    return {
      bookTitle: formatted.bookTitle,
      totalPages: formatted.totalPages,
      sectionsCount: formatted.sections.length,
      parentCount: parents.length,
      childCount: children.length,
    };
  }
}
