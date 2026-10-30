import mongoose from "mongoose";
import { config } from "dotenv";

config();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/notebook_llm";

interface MongoConnectionState {
  isConnected: boolean;
}

const state: MongoConnectionState = {
  isConnected: false,
};

/**
 * Connects to MongoDB using Mongoose.
 * Reuses existing connection if already established.
 */
export async function connectMongo(): Promise<typeof mongoose> {
  if (state.isConnected || mongoose.connection.readyState === 1) {
    return mongoose;
  }

  try {
    const conn = await mongoose.connect(MONGODB_URI);
    state.isConnected = true;
    console.log(`[MongoDB] Connected to database: ${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error("[MongoDB] Connection error:", error);
    throw error;
  }
}

/**
 * Closes the active MongoDB connection.
 */
export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    state.isConnected = false;
    console.log("[MongoDB] Disconnected successfully.");
  }
}

export { mongoose };
