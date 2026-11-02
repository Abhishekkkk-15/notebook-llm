import { Router } from "express";
import type { RAGPipeline } from "../../../service/rag_pipeline.js";

export function createSystemRouter(ragPipeline: RAGPipeline): Router {
  const router = Router();

  router.post("/reset", async (req, res) => {
    const { confirm } = req.body;
    if (confirm !== "DELETE_ALL_DATA") {
      return res.status(400).json({
        success: false,
        error: "Confirmation string 'DELETE_ALL_DATA' is required to wipe all data.",
      });
    }

    try {
      const result = await ragPipeline.resetAllData();
      res.json({
        success: true,
        message: "All projects, chunks, vectors, and extracted images have been wiped.",
        stats: result,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  return router;
}
