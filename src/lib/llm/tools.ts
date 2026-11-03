import fs from "fs";
import type { ChatCompletionTool } from "openai/resources";
import { mongoParentStore } from "../db/mongo_store.js";
import { mongoProjectStore } from "../db/project_store.js";
import { ParentChunkModel } from "../db/parent_chunk.model.js";
import { PinconeStore } from "../db/pc_store.js";
import { RAGPipeline } from "../../service/rag_pipeline.js";
import { llm } from "./embedding.js";

// ============================================================================
// 1. Tool Definitions (Passed directly to OpenAI / Azure client `tools: tools`)
// ============================================================================

export const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "hybrid_search",
      description:
        "Perform hybrid search (combining dense vector search and full-text keyword search) to retrieve the most relevant parent sections for a specific topic, concept, or question.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query or keywords to look up.",
          },
          topK: {
            type: "integer",
            description:
              "Number of top matching sections to retrieve (default: 5).",
            default: 5,
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_table_of_contents",
      description:
        "Retrieve the structural table of contents for the entire book, listing all chapters, subtopics, section titles, chunk IDs, and token counts. Essential for whole-book structural questions, finding where specific topics or exercise sections are located, or navigating the corpus.",
      parameters: {
        type: "object",
        properties: {
          chapterNumber: {
            type: "integer",
            description:
              "Optional chapter number to filter sections for a specific chapter.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_sections_by_title",
      description:
        "Search and filter document sections whose title, chapter heading, or breadcrumb matches a keyword (e.g. 'Exercises', 'Summary', 'Problems', 'Review', 'Introduction', 'Architecture'). Returns matching section titles, chapter numbers, chunk IDs, and text previews across the entire book.",
      parameters: {
        type: "object",
        properties: {
          titleQuery: {
            type: "string",
            description:
              "The keyword or phrase to search for in section titles (case-insensitive, e.g. 'exercise', 'summary', 'problem').",
          },
          limit: {
            type: "integer",
            description:
              "Maximum number of matching sections to return (default: 50).",
            default: 50,
          },
        },
        required: ["titleQuery"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_section",
      description:
        "Read the complete text, figures, and details of a specific parent section using its chunkId. Use this after identifying relevant section chunkIds via get_table_of_contents or find_sections_by_title.",
      parameters: {
        type: "object",
        properties: {
          chunkId: {
            type: "string",
            description:
              "The unique chunkId of the section to read (e.g. 'ai_p_1', 'sal_p_12').",
          },
        },
        required: ["chunkId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_stats",
      description:
        "Retrieve high-level metadata and statistics for the current book/document, including total pages, total sections, total parent chunks, total children, total images, total diagrams, and status.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vector_search",
      description:
        "Perform pure dense vector similarity search across child chunks using NVIDIA embeddings. Useful for semantic similarity matches across small chunk fragments.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The natural language query to embed and search.",
          },
          topK: {
            type: "integer",
            description: "Number of vector hits to return (default: 5).",
            default: 5,
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_image",
      description:
        "Inspect and visually analyze an image or diagram from the document using its file path (e.g. from hybrid_search or read_section). Loads the visual pixels directly into the conversation for multimodal vision analysis.",
      parameters: {
        type: "object",
        properties: {
          imagePath: {
            type: "string",
            description:
              "The relative or absolute file path of the image or diagram to visually inspect (e.g. './extracted_images/ai/page_12_img_1.png').",
          },
        },
        required: ["imagePath"],
      },
    },
  },
];

// ============================================================================
// 2. Lazy Pipeline & Store Helpers
// ============================================================================

let defaultPipeline: RAGPipeline | null = null;
let defaultPcStore: PinconeStore | null = null;

function getPipeline(): RAGPipeline {
  if (!defaultPipeline) {
    if (!defaultPcStore) {
      defaultPcStore = new PinconeStore();
    }
    defaultPipeline = new RAGPipeline(
      defaultPcStore,
      mongoParentStore,
      mongoProjectStore,
      llm,
    );
  }
  return defaultPipeline;
}

function getPcStore(): PinconeStore {
  if (!defaultPcStore) {
    defaultPcStore = new PinconeStore();
  }
  return defaultPcStore;
}

// ============================================================================
// 3. Individual Tool Execution Implementations
// ============================================================================

export async function hybridSearchTool(args: {
  query: string;
  projectId?: string;
  topK?: number;
}): Promise<any> {
  const pipeline = getPipeline();
  const topK = args.topK || 5;
  const docs = await pipeline.hybrid_search({
    query: args.query,
    projectId: args.projectId,
    topK,
  });

  if (!docs || docs.length === 0) {
    return {
      count: 0,
      results: [],
      message: `No matching sections found for query: "${args.query}"`,
    };
  }

  return {
    count: docs.length,
    results: docs.map((d) => ({
      chunkId: d.chunkId,
      breadcrumb: d.metadata?.breadcrumb,
      chapterNumber: d.metadata?.chapterNumber,
      chapterTitle: d.metadata?.chapterTitle,
      subtopicTitle: d.metadata?.subtopicTitle,
      score: (d as any).rrfScore || 0,
      text: d.text,
      images: d.metadata?.imageUrls || [],
    })),
  };
}

export async function getTableOfContentsTool(args: {
  projectId: string;
  chapterNumber?: number;
}): Promise<any> {
  const docs = await mongoParentStore.getParentsByProject(args.projectId);

  if (!docs || docs.length === 0) {
    return {
      projectId: args.projectId,
      totalSections: 0,
      sections: [],
      message: `No sections found for project "${args.projectId}". Check if the document was ingested.`,
    };
  }

  let filtered = docs;
  if (args.chapterNumber !== undefined) {
    filtered = docs.filter(
      (d) => d.metadata?.chapterNumber === args.chapterNumber,
    );
  }

  const sections = filtered.map((d) => ({
    chunkId: d.chunkId,
    chapterNumber: d.metadata?.chapterNumber,
    chapterTitle: d.metadata?.chapterTitle,
    subtopicTitle: d.metadata?.subtopicTitle,
    breadcrumb: d.metadata?.breadcrumb,
    tokenCount: d.tokenCount,
    hasImages: (d.metadata?.images?.length || 0) > 0,
    hasDiagrams: d.metadata?.hasDiagrams || false,
  }));

  return {
    projectId: args.projectId,
    totalSections: sections.length,
    sections,
  };
}

export async function findSectionsByTitleTool(args: {
  projectId: string;
  titleQuery: string;
  limit?: number;
}): Promise<any> {
  const limit = args.limit || 50;
  const regex = new RegExp(args.titleQuery, "i");

  const query: Record<string, any> = {
    $or: [
      { "metadata.subtopicTitle": regex },
      { "metadata.chapterTitle": regex },
      { "metadata.breadcrumb": regex },
    ],
  };

  if (args.projectId) {
    query["metadata.projectId"] = args.projectId;
  }

  const docs = await ParentChunkModel.find(query).limit(limit).lean();

  if (!docs || docs.length === 0) {
    return {
      count: 0,
      sections: [],
      message: `No sections matched title query: "${args.titleQuery}" in project "${args.projectId}".`,
    };
  }

  return {
    count: docs.length,
    sections: docs.map((d) => ({
      chunkId: d.chunkId,
      chapterNumber: d.metadata?.chapterNumber,
      chapterTitle: d.metadata?.chapterTitle,
      subtopicTitle: d.metadata?.subtopicTitle,
      breadcrumb: d.metadata?.breadcrumb,
      tokenCount: d.tokenCount,
      preview: d.text.slice(0, 300) + (d.text.length > 300 ? "..." : ""),
    })),
  };
}

export async function readSectionTool(args: { chunkId: string }): Promise<any> {
  const doc = await mongoParentStore.getParentById(args.chunkId);

  if (!doc) {
    return {
      found: false,
      chunkId: args.chunkId,
      error: `Section chunk with ID "${args.chunkId}" was not found in MongoDB.`,
    };
  }

  return {
    found: true,
    chunkId: doc.chunkId,
    breadcrumb: doc.metadata?.breadcrumb,
    chapterNumber: doc.metadata?.chapterNumber,
    chapterTitle: doc.metadata?.chapterTitle,
    subtopicTitle: doc.metadata?.subtopicTitle,
    tokenCount: doc.tokenCount,
    text: doc.text,
    images: doc.metadata?.imageUrls || [],
    diagrams: doc.metadata?.hasDiagrams || false,
  };
}

export async function getProjectStatsTool(args: {
  projectId: string;
}): Promise<any> {
  const project = await mongoProjectStore.getProject(args.projectId);

  if (!project) {
    return {
      found: false,
      projectId: args.projectId,
      error: `Project "${args.projectId}" not found in database.`,
    };
  }

  return {
    found: true,
    projectId: project.projectId,
    name: project.name,
    fileName: project.fileName,
    totalPages: project.totalPages,
    totalSections: project.totalSections,
    totalParents: project.totalParents,
    totalChildren: project.totalChildren,
    totalImages: project.totalImages,
    totalDiagrams: project.totalDiagrams,
    status: project.status,
  };
}

export async function vectorSearchTool(args: {
  query: string;
  projectId?: string;
  topK?: number;
}): Promise<any> {
  const pcStore = getPcStore();
  const topK = args.topK || 5;

  const vector = await llm.generate_embedding(args.query, "NVIDIA", "query");
  if (!vector) {
    return { error: "Failed to generate embedding for vector search query." };
  }

  const filter =
    args.projectId ? { projectId: { $eq: args.projectId } } : undefined;

  const hits = await pcStore.search(vector, {
    topK,
    filter,
  });

  return {
    count: hits.length,
    results: hits.map((h) => ({
      id: h.id,
      score: h.score,
      parentId: h.metadata?.parentId,
      breadcrumb: h.metadata?.breadcrumb,
      text: h.metadata?.text,
      type: h.metadata?.type,
      imageUrl: h.metadata?.imageUrl,
    })),
  };
}

export async function inspectImageTool(args: {
  imagePath: string;
}): Promise<any> {
  const imagePath = args.imagePath;
  if (!imagePath) {
    return { error: "Missing required parameter 'imagePath'." };
  }

  const exists = fs.existsSync(imagePath);
  if (!exists) {
    return {
      success: false,
      imagePath,
      error: `Image file '${imagePath}' not found on disk.`,
    };
  }

  const stats = fs.statSync(imagePath);
  return {
    success: true,
    imagePath,
    fileSizeBytes: stats.size,
    message: `Image '${imagePath}' loaded into visual context for analysis.`,
  };
}

// ============================================================================
// 4. Tool Registry Map & Dispatcher
// ============================================================================

export type ToolHandler = (args: any) => Promise<any>;

export const toolRegistry: Record<string, ToolHandler> = {
  hybrid_search: hybridSearchTool,
  get_table_of_contents: getTableOfContentsTool,
  find_sections_by_title: findSectionsByTitleTool,
  read_section: readSectionTool,
  get_project_stats: getProjectStatsTool,
  vector_search: vectorSearchTool,
  inspect_image: inspectImageTool,
};

/**
 * Converts any value (object, array, primitive, Error, null, undefined)
 * into a safe, formatted string suitable for OpenAI's tool message `content`.
 * Handles circular references, BigInt, Errors, and optional length truncation.
 */
export function formatToolResult(
  value: unknown,
  options?: { maxChars?: number; pretty?: boolean },
): string {
  if (value === undefined || value === null) {
    return JSON.stringify({ result: null });
  }

  if (typeof value === "string") {
    if (options?.maxChars && value.length > options.maxChars) {
      return (
        value.slice(0, options.maxChars) +
        `\n... [Truncated ${value.length - options.maxChars} characters]`
      );
    }
    return value;
  }

  if (value instanceof Error) {
    return JSON.stringify({
      error: value.name || "Error",
      message: value.message,
    });
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    const seen = new WeakSet();
    const jsonString = JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === "bigint") {
          return val.toString();
        }
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) {
            return "[Circular Reference]";
          }
          seen.add(val);
        }
        return val;
      },
      options?.pretty ? 2 : undefined,
    );

    if (options?.maxChars && jsonString.length > options.maxChars) {
      return (
        jsonString.slice(0, options.maxChars) +
        `\n... [Truncated ${jsonString.length - options.maxChars} characters]`
      );
    }

    return jsonString;
  } catch (err: any) {
    return JSON.stringify({
      error: "SerializationError",
      message: err?.message || String(err),
    });
  }
}

/**
 * Execute a tool by name and arguments. Returns formatted result string (or raw object).
 * Handles unknown tools and errors gracefully.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  returnAsString = true,
): Promise<any> {
  const handler = toolRegistry[toolName];
  if (!handler) {
    const errorResult = {
      error: `Unknown tool "${toolName}". Available tools: ${Object.keys(toolRegistry).join(", ")}`,
    };
    return returnAsString ? formatToolResult(errorResult) : errorResult;
  }

  try {
    const result = await handler(args);
    return returnAsString ? formatToolResult(result) : result;
  } catch (err: any) {
    const errorResult = {
      error: `Error executing tool "${toolName}": ${err?.message || String(err)}`,
    };
    return returnAsString ? formatToolResult(errorResult) : errorResult;
  }
}
