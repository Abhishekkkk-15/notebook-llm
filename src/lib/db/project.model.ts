import mongoose, { Schema, model, type Model, type Document } from "mongoose";

export interface IProjectDoc extends Document {
  projectId: string;
  name: string;
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  totalPages: number;
  totalSections: number;
  totalParents: number;
  totalChildren: number;
  totalImages: number;
  totalDiagrams: number;
  status: "ready" | "ingesting" | "error";
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema = new Schema<IProjectDoc>(
  {
    projectId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    fileName: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    fileSizeBytes: {
      type: Number,
      default: 0,
    },
    totalPages: {
      type: Number,
      default: 0,
    },
    totalSections: {
      type: Number,
      default: 0,
    },
    totalParents: {
      type: Number,
      default: 0,
    },
    totalChildren: {
      type: Number,
      default: 0,
    },
    totalImages: {
      type: Number,
      default: 0,
    },
    totalDiagrams: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["ready", "ingesting", "error"],
      default: "ingesting",
    },
    error: {
      type: String,
    },
  },
  {
    timestamps: true,
    collection: "projects",
  },
);

ProjectSchema.index({ createdAt: -1 });

export const ProjectModel: Model<IProjectDoc> =
  (mongoose.models["Project"] as Model<IProjectDoc>) ||
  model<IProjectDoc>("Project", ProjectSchema);
