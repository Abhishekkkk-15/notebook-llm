process.env.FORCE_COLOR = process.env.FORCE_COLOR || "3";
import { config } from "dotenv";
import dns from "node:dns";
import { RAGPipeline } from "./service/rag_pipeline.js";
import { PinconeStore } from "./lib/db/pc_store.js";
import { mongoParentStore } from "./lib/db/mongo_store.js";
import { mongoProjectStore } from "./lib/db/project_store.js";
import { llm } from "./lib/llm/embedding.js";
import { InteractiveTUI } from "./transport/cli/index.js";

config();
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const pcStore = new PinconeStore();
const ragPipeline = new RAGPipeline(pcStore, mongoParentStore, mongoProjectStore, llm);
const tui = new InteractiveTUI(ragPipeline);

async function main() {
  await tui.start();
}

main().catch((err) => {
  console.error("Fatal CLI error:", err);
  process.exit(1);
});
