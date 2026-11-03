import { config } from "dotenv";
import dns from "node:dns";
import type { Server } from "http";
import { RAGPipeline } from "../../service/rag_pipeline.js";
import { PinconeStore } from "../../lib/db/pc_store.js";
import { mongoParentStore } from "../../lib/db/mongo_store.js";
import { mongoProjectStore } from "../../lib/db/project_store.js";
import { llm } from "../../lib/llm/embedding.js";
import { createRestApp } from "./app.js";

config();
dns.setServers(["8.8.8.8", "8.8.4.4"]);

export async function startServer(
  customPort?: number,
): Promise<{ app: any; server: Server; port: number }> {
  const port = customPort || Number(process.env.PORT) || 3000;
  const pcStore = new PinconeStore();
  const ragPipeline = new RAGPipeline(
    pcStore,
    mongoParentStore,
    mongoProjectStore,
    llm,
  );

  const app = createRestApp(ragPipeline);

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(
        `\n\x1b[36m╭─ 🚀 Notebook-LLM REST API Server Started ─────────────────────────╮\x1b[0m`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mBase URL:       \x1b[0m\x1b[32mhttp://localhost:${port}\x1b[0m`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mHealth Check:   \x1b[0mGET  http://localhost:${port}/api/health`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mList Projects:  \x1b[0mGET  http://localhost:${port}/api/projects`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mUpload PDF:     \x1b[0mPOST http://localhost:${port}/api/projects/ingest`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mAsk Question:   \x1b[0mPOST http://localhost:${port}/api/rag/query`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mHybrid Search:  \x1b[0mPOST http://localhost:${port}/api/rag/search`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mStatic Images:  \x1b[0mGET  http://localhost:${port}/assets/images/...`,
      );
      console.log(
        `\x1b[36m╰───────────────────────────────────────────────────────────────────╯\x1b[0m\n`,
      );
      resolve({ app, server, port });
    });
  });
}

// Auto-run if executed directly via node or tsx




const scriptPath = process.argv[1]?.replace(/\\/g, "/") || "";
const isDirect =
  scriptPath.endsWith("rest/index.ts") ||
  scriptPath.endsWith("rest/index.js");

if (isDirect) {
  startServer(3000).catch((err) => {
    console.error("Fatal Server Startup Error:", err);
    process.exit(1);
  });
}
