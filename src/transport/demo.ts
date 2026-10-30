import { InteractiveCLI } from "./cli.js";

/**
 * ============================================================================
 * MOCKED INTERACTIVE CLI RUNNER FOR TESTING
 * ============================================================================
 *
 * This script runs a fully interactive mocked session of InteractiveCLI.
 * No external API keys (OpenAI / NVIDIA / Pinecone) are needed.
 *
 * To run:
 *   pnpm tsx src/transport/demo.ts
 */

// Helper to simulate async network latency (so you can see the animated spinner)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cli = new InteractiveCLI({
  appName: "Notebook-LLM (Mock Demo)",
  version: "1.0.0",
  defaultNamespace: "mock_chunks",
  defaultTopK: 3,
  bannerSubtitle: "Interactive TUI Test Runner (Mocked - No API keys required)",
});

// Configure mocked handlers to test all TUI features
cli.setHandlers({
  // 1. Natural Language / RAG Q&A (tested by typing any prompt or /ask <query>)
  onQuery: async (prompt, { topK, namespace }) => {
    await sleep(800); // Simulate network latency

    return {
      answer: `Here is a simulated answer for your question:\n"${prompt}"\n\nIn the real pipeline, this is synthesized by your LLM using retrieved parent document sections.`,
      sources: [
        {
          id: "chunk_ch1_sec2_c1",
          score: 0.945,
          breadcrumb: "[AI Agents in Depth > Chapter 1: Introduction > Agent Architecture]",
          text: "An autonomous agent is an entity that perceives its environment through sensors and takes actions using actuators to achieve its designated goals.",
        },
        {
          id: "chunk_ch2_sec1_c3",
          score: 0.892,
          breadcrumb: "[AI Agents in Depth > Chapter 2: Reasoning > Chain-of-Thought]",
          text: "Chain-of-thought prompting enables complex reasoning capabilities through intermediate reasoning steps before generating final answers.",
        },
        {
          id: "chunk_ch3_sec4_c2",
          score: 0.831,
          breadcrumb: "[AI Agents in Depth > Chapter 3: Planning > Task Decomposition]",
          text: "Hierarchical task decomposition breaks complex high-level objectives into actionable sub-tasks.",
        },
      ].slice(0, topK),
    };
  },

  // 2. Vector Similarity Search (tested via /search <query>)
  onSearch: async (query, { topK, namespace }) => {
    await sleep(500); // Simulate vector search latency

    return [
      {
        id: "mock_vec_001",
        score: 0.965,
        breadcrumb: "[AI Agents in Depth > Ch.3: Planning > Subgoal Planning]",
        text: "Complex tasks are hierarchically decomposed into executable atomic actions using backward and forward planning.",
      },
      {
        id: "mock_vec_002",
        score: 0.912,
        breadcrumb: "[AI Agents in Depth > Ch.4: Memory > Working Memory]",
        text: "Working memory retains immediate context and intermediate execution steps across agent turns.",
      },
      {
        id: "mock_vec_003",
        score: 0.854,
        breadcrumb: "[AI Agents in Depth > Ch.5: Tool Use > Function Calling]",
        text: "Agents invoke external tools and APIs by formatting arguments into structured JSON schemas.",
      },
      {
        id: "mock_vec_004",
        score: 0.798,
        breadcrumb: "[AI Agents in Depth > Ch.6: Multi-Agent > Coordination]",
        text: "Multi-agent collaboration protocols facilitate distributed consensus and task handoffs.",
      },
    ].slice(0, topK);
  },

  // 3. Document Ingestion (tested via /ingest <file> [title])
  onIngest: async (filePath, { title }) => {
    await sleep(1000); // Simulate PDF extraction and chunking

    return {
      bookTitle: title || "Mock Book (" + filePath + ")",
      totalPages: 42,
      sectionsCount: 10,
      parentCount: 10,
      childCount: 58,
      message: "Simulated document successfully parsed into parent/child chunks.",
    };
  },

  // 4. Remote Status (tested via /status)
  onStatus: async () => {
    await sleep(300);
    return {
      status: "Mock Engine Ready",
      pineconeIndex: "mock-notebook-llm-index",
      dimension: 2048,
      totalVectors: 1250,
      namespaces: ["mock_chunks", "default"],
      llmProvider: "Mocked (Offline Mode)",
    };
  },

  // 5. Namespace Clear (tested via /clear [namespace])
  onClear: async (namespace) => {
    await sleep(400);
    return `[Mock] Namespace "${namespace}" successfully cleared.`;
  },
});

// Launch the interactive CLI
await cli.start();
