import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "dotenv";
config();
const pinecode_key = process.env.PC_API_KEY;
const pc_index = process.env.PC_INDEX;

if (!pinecode_key || !pc_index) {
  throw new Error("both are required");
}

const pc = new Pinecone({
  apiKey: pinecode_key,
});

export const index = pc.index(pc_index);
export const child_chunk_ns = index.namespace("child_chunks");
