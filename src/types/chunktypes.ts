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
  projectId?: string;
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  subtopicTitle: string;
  breadcrumb: string;
  type?: "text" | "image";
  images?: IImageMetadata[];
  imageUrls?: string[];
  imageCaptions?: string[];
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
  projectId?: string;
  bookTitle: string;
  childChunkTokenSize?: number;
  childTokenOverlap?: number;
}
