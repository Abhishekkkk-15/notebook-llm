import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "dotenv";
config();
const pc = new Pinecone({
  apiKey: process.env.PC_API_KEY!,
});

const indexName = process.env.PC_INDEX!; // e.g. "notebook-llm-index"

await pc.createIndex({
  name: indexName,
  dimension: 2048, // Set this to your exact model's dimension (e.g. 768, 1024, 1536)
  metric: "cosine",
  spec: {
    serverless: {
      cloud: "aws",
      region: "us-east-1",
    },
  },
});

console.log(`Vector index "${indexName}" created successfully!`);
