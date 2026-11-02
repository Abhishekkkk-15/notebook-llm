import fs from "fs";
import path from "path";
import { Router } from "express";
import multer from "multer";
import type { RAGPipeline } from "../../../service/rag_pipeline.js";

const uploadDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB max PDF
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

export function createProjectRouter(ragPipeline: RAGPipeline): Router {
  const router = Router();

  // List all projects
  router.get("/", async (req, res) => {
    try {
      const projects = await ragPipeline.listProjects();
      res.json({ success: true, count: projects.length, data: projects });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Get project by ID
  router.get("/:projectId", async (req, res) => {
    const { projectId } = req.params;
    try {
      const project = await ragPipeline.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      res.json({ success: true, data: project });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Get Table of Contents / sections
  router.get("/:projectId/sections", async (req, res) => {
    const { projectId } = req.params;
    const includeText = req.query.includeText !== "false";
    try {
      const parents = await ragPipeline.getProjectParents(projectId);

      if (!parents || parents.length === 0) {
        return res.json({ success: true, count: 0, data: [] });
      }

      const data = parents.map((p) => {
        const base = {
          chunkId: p.chunkId,
          tokenCount: p.tokenCount,
          chapterNumber: p.metadata?.chapterNumber,
          chapterTitle: p.metadata?.chapterTitle,
          subtopicTitle: p.metadata?.subtopicTitle,
          breadcrumb: p.metadata?.breadcrumb,
          imageUrls: p.metadata?.imageUrls || [],
          hasDiagrams: p.metadata?.hasDiagrams || p.text.includes("```mermaid"),
        };
        if (includeText) {
          return { ...base, text: p.text };
        }
        return base;
      });

      res.json({ success: true, count: data.length, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Get visual assets (images and mermaid flowcharts)
  router.get("/:projectId/visuals", async (req, res) => {
    const { projectId } = req.params;
    try {
      const parents = await ragPipeline.getProjectParents(projectId);

      const visuals: Array<{
        id: string;
        type: "image" | "mermaid";
        title: string;
        breadcrumb: string;
        chapterNumber?: number;
        page?: number;
        url?: string;
        code?: string;
      }> = [];

      const seenUrls = new Set<string>();

      for (const parent of parents) {
        // 1. Images from metadata
        for (const img of parent.metadata?.images || []) {
          const url = img.url || img.relativePath;
          if (url && !seenUrls.has(url)) {
            seenUrls.add(url);
            visuals.push({
              id: `img_${visuals.length + 1}`,
              type: "image",
              title: img.caption || img.fileName || "Figure",
              breadcrumb: parent.metadata?.breadcrumb || parent.chunkId,
              chapterNumber: parent.metadata?.chapterNumber,
              page: img.pageNum,
              url,
            });
          }
        }

        // 2. Markdown image tags
        const mdImgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = mdImgRegex.exec(parent.text)) !== null) {
          const url = m[2]!;
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            visuals.push({
              id: `img_${visuals.length + 1}`,
              type: "image",
              title: m[1] || "Figure",
              breadcrumb: parent.metadata?.breadcrumb || parent.chunkId,
              chapterNumber: parent.metadata?.chapterNumber,
              url,
            });
          }
        }

        // 3. Mermaid diagrams
        const mermaidRegex = /```(?:mermaid|flowchart|graph)\s*([\s\S]*?)```/gi;
        let mm: RegExpExecArray | null;
        while ((mm = mermaidRegex.exec(parent.text)) !== null) {
          const code = mm[1]!.trim();
          const firstNode = code.match(/\["?(.*?)"?\]/);
          visuals.push({
            id: `diag_${visuals.length + 1}`,
            type: "mermaid",
            title: firstNode ? `Flowchart: ${firstNode[1]?.slice(0, 50)}` : "Flowchart Diagram",
            breadcrumb: parent.metadata?.breadcrumb || parent.chunkId,
            chapterNumber: parent.metadata?.chapterNumber,
            code,
          });
        }
      }

      res.json({ success: true, count: visuals.length, data: visuals });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Delete project
  router.delete("/:projectId", async (req, res) => {
    const { projectId } = req.params;
    try {
      const project = await ragPipeline.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      await ragPipeline.deleteProject(projectId);
      res.json({ success: true, message: `Project ${projectId} deleted successfully.` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Ingest PDF file (supports standard JSON response or SSE streaming)
  router.post("/ingest", upload.single("file"), async (req, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: "No PDF file uploaded" });
    }

    const projectName = req.body.projectName || file.originalname.replace(/\.pdf$/i, "");
    const childTokenSize = req.body.childTokenSize ? Number(req.body.childTokenSize) : undefined;
    const childOverlap = req.body.childOverlap ? Number(req.body.childOverlap) : undefined;
    const isStream = req.query.stream === "true" || req.headers.accept?.includes("text/event-stream");

    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const sendSse = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        sendSse("progress", { message: "Uploaded PDF received. Starting ingestion..." });

        const result = await ragPipeline.ingestDocument({
          filePath: file.path,
          projectName,
          childTokenSize,
          childOverlap,
          onProgress: (status) => {
            sendSse("progress", { message: status });
          },
        });

        sendSse("complete", { success: true, project: result });
        res.end();
      } catch (err: any) {
        sendSse("error", { success: false, error: err.message || String(err) });
        res.end();
      } finally {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    } else {
      try {
        const result = await ragPipeline.ingestDocument({
          filePath: file.path,
          projectName,
          childTokenSize,
          childOverlap,
        });
        res.json({ success: true, project: result });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message || String(err) });
      } finally {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }
  });

  return router;
}
