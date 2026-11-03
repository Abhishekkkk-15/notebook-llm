import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { ChatCompletionMessageParam } from "openai/resources";

import { chunkFormattedBook } from "../lib/chunker.js";
import { readAndFormatPdf } from "../lib/pdfFormatter.js";
import { mongoParentStore } from "../lib/db/mongo_store.js";
import { mongoProjectStore } from "../lib/db/project_store.js";
import type { IParentChunkDoc } from "../lib/db/parent_chunk.model.js";
import type { IProjectDoc } from "../lib/db/project.model.js";
import { PinconeStore } from "../lib/db/pc_store.js";
import { build_system_prompt, flat_chunks, llm } from "../lib/llm/embedding.js";
import { MemoryRegistory } from "../lib/llm/memory_registory.js";
import type { IChildChunk } from "../types/chunktypes.js";

export interface IIngestOption {
  projectId?: string;
  projectName?: string;
  filePath: string;
  bookTitle?: string;
  namespace?: string;
  childTokenSize?: number;
  childOverlap?: number;
  onProgress?: (status: string) => void;
}

export interface IQueryOption {
  query: string;
  projectId?: string;
  namespace?: string;
  bookTitle?: string;
  filters?: Record<string, any>;
  topK?: number;
}

export interface IQueryResponse {
  answer?: string;
  projectId?: string;
  images?: any[];
  imageUrls?: string[];
  sources: Array<{
    id: string;
    score: number;
    breadcrumb?: string;
    text?: string;
    images?: any[];
    imageUrls?: string[];
  }>;
}

export class RAGPipeline {
  constructor(
    private pcStore = new PinconeStore(),
    private parentStore = mongoParentStore,
    private projectStore = mongoProjectStore,
    private llmClient = llm,
  ) {}

  /**
   * Generates a unique, URL-safe project ID from a name or filename.
   */
  public generateProjectId(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    const rand = crypto.randomBytes(3).toString("hex");
    return `proj_${slug || "doc"}_${rand}`;
  }

  async listProjects(): Promise<IProjectDoc[]> {
    return await this.projectStore.listProjects();
  }

  async getProject(projectId: string): Promise<IProjectDoc | null> {
    return await this.projectStore.getProject(projectId);
  }

  /**
   * Retrieves all parent chunks belonging to a specific project.
   */
  async getProjectParents(projectId: string): Promise<IParentChunkDoc[]> {
    return await this.parentStore.getParentsByProject(projectId);
  }

  async deleteProject(projectId: string, namespace?: string): Promise<boolean> {
    await Promise.all([
      this.parentStore.deleteParentsByProject(projectId),
      this.pcStore.deleteByProjectId(projectId, namespace),
      this.projectStore.deleteProject(projectId),
    ]);
    return true;
  }

  /**
   * Completely reset and wipe all data across:
   * - MongoDB Parent chunks
   * - MongoDB Projects
   * - Pinecone vector chunks (all namespaces)
   * - Local extracted images directory (optional, default true)
   */
  async resetAllData(options?: {
    namespace?: string;
    deleteLocalImages?: boolean;
    onProgress?: (message: string) => void;
  }): Promise<{
    deletedParents: number;
    deletedProjects: number;
    pineconeCleared: boolean;
    imagesDeleted?: number;
  }> {
    options?.onProgress?.("Deleting all vector chunks from Pinecone...");
    let pineconeCleared = false;
    try {
      await this.pcStore.deleteAllVectors(options?.namespace);
      pineconeCleared = true;
    } catch (err: any) {
      console.warn("[RAGPipeline] Warning while clearing Pinecone vectors:", err?.message || err);
    }

    options?.onProgress?.("Deleting all parent sections from MongoDB...");
    const deletedParents = await this.parentStore.deleteAllParents();

    options?.onProgress?.("Deleting all projects from MongoDB...");
    const deletedProjects = await this.projectStore.deleteAllProjects();

    let imagesDeleted: number | undefined;
    if (options?.deleteLocalImages !== false) {
      options?.onProgress?.("Cleaning up extracted local image files...");
      const imagesDir = path.resolve("./extracted_images");
      if (fs.existsSync(imagesDir)) {
        try {
          const files = fs.readdirSync(imagesDir);
          imagesDeleted = files.length;
          fs.rmSync(imagesDir, { recursive: true, force: true });
          fs.mkdirSync(imagesDir, { recursive: true });
        } catch (err: any) {
          console.warn("[RAGPipeline] Warning cleaning extracted_images:", err?.message || err);
        }
      }
    }

    options?.onProgress?.("Database and vector store reset complete.");
    return {
      deletedParents,
      deletedProjects,
      pineconeCleared,
      imagesDeleted,
    };
  }

  async ingestDocument(option: IIngestOption) {
    const namespace = option.namespace ?? "child_chunks";
    const childTokenSize = option.childTokenSize ?? 350;
    const childOverlap = option.childOverlap ?? 60;

    const resolvedPath = path.resolve(process.cwd(), option.filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const fileName = path.basename(resolvedPath);
    const bookTitle =
      option.bookTitle ||
      option.projectName ||
      path.basename(resolvedPath, path.extname(resolvedPath));
    const projectName = option.projectName || bookTitle;
    const projectId =
      option.projectId || this.generateProjectId(projectName || fileName);
    const fileStats = fs.statSync(resolvedPath);

    option.onProgress?.(
      `Registering project: ${projectName} (${projectId})...`,
    );

    // 1. Initialize project in MongoDB
    await this.projectStore.createOrUpdateProject({
      projectId,
      name: projectName,
      fileName,
      filePath: resolvedPath,
      fileSizeBytes: fileStats.size,
      status: "ingesting",
    });

    try {
      option.onProgress?.(
        "Parsing PDF, extracting images & Mermaid diagrams...",
      );
      const formatted = await readAndFormatPdf(resolvedPath, {
        bookTitle,
      });

      option.onProgress?.(
        `Parsed ${formatted.totalPages} pages. Slicing into hierarchical parent/child chunks...`,
      );

      const { parents, children } = chunkFormattedBook(formatted, {
        projectId,
        bookTitle,
        childChunkTokenSize: childTokenSize,
        childTokenOverlap: childOverlap,
      });

      const totalImages = formatted.images?.length ?? 0;
      const totalDiagrams = parents.filter(
        (p) => p.metadata.hasDiagrams,
      ).length;

      option.onProgress?.(
        `Generating embeddings for ${children.length} child chunks...`,
      );

      const child_with_vec: Array<{ chunk: IChildChunk; vector: number[] }> =
        [];
      for (let i = 0; i < children.length; i++) {
        const c = children[i]!;
        const vector = await this.llmClient.generate_embedding(
          c.text,
          "NVIDIA",
          "passage",
        );

        if (!vector) {
          throw new Error(
            `Failed to generate embedding for child chunk ${c.id}`,
          );
        }

        child_with_vec.push({ chunk: c, vector });

        if ((i + 1) % 50 === 0 || i === children.length - 1) {
          option.onProgress?.(
            `Embedding generation: ${i + 1} / ${children.length} chunks done.`,
          );
        }
      }

      option.onProgress?.("Saving parent sections to MongoDB...");
      await this.parentStore.upsertParents(parents);

      option.onProgress?.("Upserting vectors to Pinecone...");
      await this.pcStore.upsertChunks(child_with_vec, { namespace });

      // 2. Mark project as ready in MongoDB
      const updatedProject = await this.projectStore.createOrUpdateProject({
        projectId,
        name: projectName,
        fileName,
        filePath: resolvedPath,
        fileSizeBytes: fileStats.size,
        totalPages: formatted.totalPages,
        totalSections: formatted.sections.length,
        totalParents: parents.length,
        totalChildren: children.length,
        totalImages,
        totalDiagrams,
        status: "ready",
      });

      option.onProgress?.("Ingestion completed successfully!");

      return {
        project: updatedProject,
        projectId,
        bookTitle: formatted.bookTitle,
        totalPages: formatted.totalPages,
        sectionsCount: formatted.sections.length,
        parentCount: parents.length,
        childCount: children.length,
        totalImages,
        totalDiagrams,
      };
    } catch (err: any) {
      await this.projectStore.createOrUpdateProject({
        projectId,
        name: projectName,
        status: "error",
        error: err?.message || String(err),
      });
      throw err;
    }
  }

  async query(option: IQueryOption): Promise<IQueryResponse> {
    const namespace = option.namespace ?? "child_chunks";

    const full_content = await this.hybrid_search({ ...option, namespace });

    if (!full_content || full_content.length === 0) {
      const scopeMsg =
        option.projectId ? ` in project '${option.projectId}'` : "";
      return {
        answer: `No relevant documents found matching your query${scopeMsg}. Please check that the PDF is ingested.`,
        projectId: option.projectId,
        sources: [],
      };
    }

    const user_message =
      "User Query : " +
      option.query +
      "\n" +
      "## Sources : \n " +
      flat_chunks(full_content);

    const allImages: any[] = [];
    const allImageUrls: string[] = [];
    const seenHashes = new Set<string>();

    for (const doc of full_content) {
      for (const img of doc.metadata.images || []) {
        const key = img.hash || img.url;
        if (!seenHashes.has(key)) {
          seenHashes.add(key);
          allImages.push(img);
          allImageUrls.push(img.url);
        }
      }
    }

    const res = await this.llmClient.generate_completion({
      user_message: user_message,
      images: allImageUrls.slice(0, 5),
    });

    return {
      answer: res?.content ?? undefined,
      projectId: option.projectId,
      images: allImages,
      imageUrls: allImageUrls,
      sources: full_content.map((c) => ({
        id: String(c.chunkId || c._id),
        score: (c as any).rrfScore || 0,
        breadcrumb: c.metadata.breadcrumb,
        text: c.text,
        images: c.metadata.images || [],
        imageUrls: c.metadata.imageUrls || [],
      })),
    };
  }

  /**
   * Execute multi-step Agentic ReAct query using tools.
   */
  async agentQuery(option: {
    query: string;
    projectId: string;
    iterationLimit?: number;
    onStep?: (step: any) => void;
  }): Promise<{
    answer: string;
    steps: any[];
    projectId?: string;
  }> {
    const res = await this.llmClient.agentRunTime({
      user_query: option.query,
      projectId: option.projectId,
      iterationLimit: option.iterationLimit ?? 8,
      onSteps: option.onStep,
    });

    return {
      answer: res?.answer || "No response generated.",
      steps: res?.steps || [],
      projectId: option.projectId,
    };
  }

  // Hybrid Search: Pinecone Vector + MongoDB Text Search merged via RRF (strictly filtered by projectId)
  async hybrid_search(option: IQueryOption): Promise<IParentChunkDoc[]> {
    const namespace = option.namespace ?? "child_chunks";
    const topK = option.topK ?? 5;
    const candidateLimit = Math.max(topK * 3, 15);

    const userQueryEmbd = await this.llmClient.generate_embedding(
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
    } catch {
      // Fallback
    }

    if (!keywords || keywords.length === 0) {
      keywords = option.query
        .split(/\s+/)
        .map((w) => w.replace(/[^\w]/g, "").trim())
        .filter((w) => w.length > 2);
    }

    // Set up project isolation filters
    const mongoFilter: Record<string, any> = {};
    const pcFilter: Record<string, any> = { ...(option.filters || {}) };

    if (option.projectId) {
      mongoFilter["metadata.projectId"] = option.projectId;
      pcFilter["projectId"] = { $eq: option.projectId };
    }

    // 1. Fetch wider candidate pools in parallel
    const [keyword_hits, vector_hits] = await Promise.all([
      this.parentStore.searchKeywordsAnd(keywords, candidateLimit, mongoFilter),
      this.pcStore.search(userQueryEmbd, {
        topK: candidateLimit,
        namespace,
        filter: Object.keys(pcFilter).length > 0 ? pcFilter : undefined,
      }),
    ]);

    const k = 60;
    const score_map = new Map<string, number>();

    // 2. Process Vector Hits: Deduplicate per parent to take its best rank
    const seenVectorParents = new Set<string>();
    vector_hits.forEach((hit, rank) => {
      const parentId = hit.metadata?.parentId;
      if (parentId && !seenVectorParents.has(parentId)) {
        seenVectorParents.add(parentId);
        score_map.set(
          parentId,
          (score_map.get(parentId) || 0) + 1 / (k + rank + 1),
        );
      }
    });

    // 3. Process Keyword Hits from MongoDB
    (keyword_hits || []).forEach((doc, rank) => {
      const chunkId = doc.chunkId;
      if (chunkId) {
        score_map.set(
          chunkId,
          (score_map.get(chunkId) || 0) + 1 / (k + rank + 1),
        );
      }
    });

    // 4. Rank top unique parent IDs by combined RRF score
    const topParentIds = Array.from(score_map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id]) => id)
      .filter(Boolean);

    if (topParentIds.length === 0) {
      return [];
    }

    // 5. Fetch from MongoDB and PRESERVE strict RRF ranked order
    const docs = await this.parentStore.getParentsByIds(topParentIds);
    const docMap = new Map(docs.map((d) => [d.chunkId, d]));

    return topParentIds
      .map((id) => {
        const doc = docMap.get(id);
        if (doc) {
          (doc as any).rrfScore = score_map.get(id) || 0;
        }
        return doc;
      })
      .filter((d): d is IParentChunkDoc => Boolean(d));
  }
}
