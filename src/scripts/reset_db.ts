import { config } from "dotenv";
import dns from "node:dns";
import { RAGPipeline } from "../service/rag_pipeline.js";
import { PinconeStore } from "../lib/db/pc_store.js";
import { mongoParentStore } from "../lib/db/mongo_store.js";
import { mongoProjectStore } from "../lib/db/project_store.js";
import { llm } from "../lib/llm/embedding.js";

config();
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const pcStore = new PinconeStore();
const ragPipeline = new RAGPipeline(
  pcStore,
  mongoParentStore,
  mongoProjectStore,
  llm,
);

async function main() {
  console.log("🔥 Starting full database reset (MongoDB + Pinecone)...");
  const result = await ragPipeline.resetAllData({
    deleteLocalImages: true,
    onProgress: (msg: string) => console.log(`[RESET] ${msg}`),
  });

  console.log("\n✅ Reset completed successfully!");
  console.log(`  • Deleted Projects:      ${result.deletedProjects}`);
  console.log(`  • Deleted Parent Chunks: ${result.deletedParents}`);
  console.log(
    `  • Pinecone Cleared:      ${result.pineconeCleared ? "Yes" : "Failed"}`,
  );
  if (result.imagesDeleted !== undefined) {
    console.log(`  • Extracted Images Cleaned: ${result.imagesDeleted}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Reset failed:", err);
  process.exit(1);
});
