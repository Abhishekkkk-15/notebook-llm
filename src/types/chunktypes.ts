export type TMetadata = {
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  subtopicTitle: string;
  breadcrumb: string;
};

export interface IChildChunk {
  id: string;
  parentId: string;
  text: string;
  tokenCount: number;
  metadata: TMetadata;
}

export interface IParentChunk {
  id: string;
  text: string;
  tokenCount: number;
  metadata: TMetadata;
}

export interface ChunkingConfig {
  bookTitle: string;
  childChunktokenSize?: number;
  childTokenOverlap?: number;
}
