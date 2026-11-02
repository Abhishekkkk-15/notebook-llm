import mongoose, { Schema, model, type Model, type Document } from "mongoose";
import type { TMetadata } from "../../types/chunktypes.js";

/**
 * Interface representing a Parent Chunk document stored in MongoDB.
 */
export interface IParentChunkDoc extends Document {
  chunkId: string;
  text: string;
  tokenCount: number;
  metadata: TMetadata;
  createdAt: Date;
  updatedAt: Date;
}

const MetadataSchema = new Schema<TMetadata>(
  {
    projectId: { type: String },
    bookTitle: { type: String, required: true, index: true },
    chapterNumber: { type: Number, required: true },
    chapterTitle: { type: String, required: true },
    subtopicTitle: { type: String, required: true },
    breadcrumb: { type: String, required: true, index: true },
    type: { type: String, default: "text" },
    images: { type: [Schema.Types.Mixed], default: [] },
    imageUrls: { type: [String], default: [] },
    imageCaptions: { type: [String], default: [] },
    hasDiagrams: { type: Boolean, default: false },
  },
  { _id: false },
);

const ParentChunkSchema = new Schema<IParentChunkDoc>(
  {
    chunkId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    text: {
      type: String,
      required: true,
    },
    tokenCount: {
      type: Number,
      required: true,
    },
    metadata: {
      type: MetadataSchema,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "parent_chunks",
  },
);

// Indexes for querying sections of a specific project and book efficiently
ParentChunkSchema.index({ "metadata.projectId": 1 });
ParentChunkSchema.index({
  "metadata.projectId": 1,
  "metadata.bookTitle": 1,
});
ParentChunkSchema.index({
  "metadata.bookTitle": 1,
  "metadata.chapterNumber": 1,
});

// Full-text search index (requires "text" as index type)
ParentChunkSchema.index({
  text: "text",
  "metadata.subtopicTitle": "text",
  "metadata.chapterTitle": "text",
});

export const ParentChunkModel: Model<IParentChunkDoc> =
  (mongoose.models["ParentChunk"] as Model<IParentChunkDoc>) ||
  model<IParentChunkDoc>("ParentChunk", ParentChunkSchema);
