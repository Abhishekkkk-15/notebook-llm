import type { RecordMetadata } from "@pinecone-database/pinecone";

export interface IChunkPineconeMetadata extends RecordMetadata {
  parentId: string;
  text: string;
  tokenCount: number;
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  subtopicTitle: string;
  breadcrumb: string;
  imageUrls: string[];
  hasImages: boolean;
  hasDiagrams: boolean;
}

// 2. Your internal application chunk interface
export interface IPCChildChunk {
  id: string;
  values?: number[];
  metadata: IChunkPineconeMetadata;
}
