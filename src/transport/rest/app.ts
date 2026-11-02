import path from "path";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import type { RAGPipeline } from "../../service/rag_pipeline.js";
import { createHealthRouter } from "./routes/health.routes.js";
import { createProjectRouter } from "./routes/project.routes.js";
import { createRagRouter } from "./routes/rag.routes.js";
import { createSystemRouter } from "./routes/system.routes.js";

export function createRestApp(ragPipeline: RAGPipeline): Express {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Static Assets: Serve extracted diagrams and figures
  // Allows web UI or client to view images directly via http://localhost:PORT/assets/images/...
  const imagesDir = path.resolve(process.cwd(), "extracted_images");
  app.use("/assets/images", express.static(imagesDir));
  app.use("/extracted_images", express.static(imagesDir));

  // Serve Public Web UI (White + Beige Shadcn Theme)
  const publicDir = path.resolve(process.cwd(), "public");
  app.use(express.static(publicDir));
  app.get("/", (req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // API Routes
  app.use("/api/health", createHealthRouter());
  app.use("/api/projects", createProjectRouter(ragPipeline));
  app.use("/api/rag", createRagRouter(ragPipeline));
  app.use("/api/system", createSystemRouter(ragPipeline));

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: `Route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Global Error handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("[REST API Error]", err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  });

  return app;
}
