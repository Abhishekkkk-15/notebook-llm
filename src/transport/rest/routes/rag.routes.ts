import { Router } from "express";
import type { RAGPipeline } from "../../../service/rag_pipeline.js";

export function createRagRouter(ragPipeline: RAGPipeline): Router {
  const router = Router();

  // Natural Language Q&A Query
  router.post("/query", async (req, res) => {
    const { query, projectId, topK, mode } = req.body;
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: "Field 'query' is required." });
    }

    try {
      if (projectId && mode !== "direct") {
        const agentRes = await ragPipeline.agentQuery({
          query: query.trim(),
          projectId: String(projectId).trim(),
          iterationLimit: 8,
        });

        return res.json({
          success: true,
          answer: agentRes.answer,
          steps: agentRes.steps,
          projectId,
          sources: [],
          imageUrls: [],
        });
      }

      const response = await ragPipeline.query({
        query: query.trim(),
        projectId: projectId ? String(projectId).trim() : undefined,
        topK: topK ? Number(topK) : 4,
      });

      res.json({
        success: true,
        answer: response.answer,
        sources: response.sources,
        images: response.images,
        imageUrls: response.imageUrls,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Semantic / Hybrid Vector Search
  router.post("/search", async (req, res) => {
    const { query, projectId, topK, mode } = req.body;
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ success: false, error: "Field 'query' is required." });
    }

    try {
      const hits = await ragPipeline.hybrid_search({
        query: query.trim(),
        projectId: projectId ? String(projectId).trim() : undefined,
        topK: topK ? Number(topK) : 5,
      });

      res.json({
        success: true,
        count: hits.length,
        results: hits.map((hit) => ({
          chunkId: hit.chunkId,
          text: hit.text,
          rrfScore: (hit as any).rrfScore || 0,
          tokenCount: hit.tokenCount,
          metadata: hit.metadata,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  return router;
}
