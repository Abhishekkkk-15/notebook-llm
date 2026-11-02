export interface IImageMetadata {
  id?: string;
  pageNum: number;
  fileName: string;
  relativePath: string;
  url: string;
  width?: number;
  height?: number;
  hash?: string;
  caption?: string;
}

export type TMetadata = {
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  subtopicTitle: string;
  breadcrumb: string;
  images?: IImageMetadata[];
  imageUrls?: string[];
  hasDiagrams?: boolean;
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
  childChunkTokenSize?: number;
  childTokenOverlap?: number;
}
