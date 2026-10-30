import path from "node:path";
import { config } from "dotenv";
import { InteractiveCLI } from "./transport/cli.js";
import { RAGPipeline } from "./service/rag_pipeline.js";
import { PinconeStore } from "./lib/db/pc_store.js";
import { mongoParentStore } from "./lib/db/mongo_store.js";
import { llm } from "./lib/llm/embedding.js";

config();

const pcStore = new PinconeStore();
const ragPipeline = new RAGPipeline(pcStore, mongoParentStore, llm);

const cli = new InteractiveCLI({
  appName: "Notebook-LLM",
  version: "1.0.0",
  defaultNamespace: "child_chunks",
  defaultTopK: 5,
  bannerSubtitle: "Hierarchical Parent-Child RAG with Pinecone & MongoDB",
});

cli.setHandlers({
  // Natural language query / LLM Q&A
  onQuery: async (prompt, { topK, namespace }) => {
    const res = await ragPipeline.query({
      query: prompt,
      topK,
      namespace,
    });
    return {
      answer: res.answer ?? undefined,
      sources: res.sources,
    };
  },

  // Raw semantic vector search
  onSearch: async (query, { topK, namespace }) => {
    const vec = await llm.generate_embedding(query, "NVIDIA", "query");
    if (!vec) throw new Error("Failed to generate embedding for query");
    const matches = await pcStore.search(vec, { topK, namespace });
    return matches.map((m) => ({
      id: m.id,
      score: m.score,
      breadcrumb: m.metadata?.breadcrumb,
      text: m.metadata?.text,
      metadata: m.metadata,
    }));
  },

  // Document ingestion from PDF
  onIngest: async (filePath, options) => {
    const title =
      options.title || path.basename(filePath, path.extname(filePath));
    return await ragPipeline.ingestDocument({
      filePath,
      bookTitle: title,
      childTokenSize: options.childChunkTokenSize,
      childOverlap: options.childTokenOverlap,
    });
  },

  // System and database status
  onStatus: async () => {
    const parentCount = await mongoParentStore.countParents();
    return {
      "MongoDB Parent Documents": parentCount,
      "Vector Database": "Pinecone",
      "Vector Namespace": "child_chunks",
      "Embedding Model": "nvidia/nemotron-3.5-embed-1b",
      "LLM Model": "Azure OpenAI (gpt-5.6-luna)",
    };
  },

  // Clear namespace
  onClear: async (namespace) => {
    const ns = namespace || "child_chunks";
    await pcStore.clearNamespace(ns);
    return `Namespace '${ns}' successfully cleared from Pinecone.`;
  },
});

async function main() {
  await cli.start();
}

main().catch((err) => {
  console.error("Fatal CLI error:", err);
  process.exit(1);
});
