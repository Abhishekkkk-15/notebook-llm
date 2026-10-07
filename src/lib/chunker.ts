import type {
  ChunkingConfig,
  IChildChunk,
  IParentChunk,
} from "../types/chunktypes.js";
import type { FormattedBook, FormattedSection } from "./pdfFormatter.js";
import { estimateTokens, splitIntoIChildChunks } from "./tokenizer.js";

export function chunkFormattedBook(
  book: FormattedBook,
  config?: Partial<ChunkingConfig>,
): { parents: IParentChunk[]; children: IChildChunk[] } {
  const childChunkTokenSize = config?.childChunkTokenSize ?? 200;
  const childTokenOverlap = config?.childTokenOverlap ?? 40;
  const bookTitle = config?.bookTitle || book.bookTitle;

  const parents: IParentChunk[] = [];
  const children: IChildChunk[] = [];

  book.sections.forEach((section: FormattedSection, index: number) => {
    const parentBody = section.content.trim();
    if (!parentBody) return;

    const parentId = `p_sec_${index + 1}_p${section.pageStart}`;
    const breadcrumb = section.breadcrumb;

    // 1. Map to IParentChunk (Level 2: complete section for LLM context)
    const parentChunk: IParentChunk = {
      id: parentId,
      text: `## ${section.title}\n\n${parentBody}`,
      tokenCount: estimateTokens(parentBody),
      metadata: {
        bookTitle,
        chapterNumber: index + 1,
        chapterTitle: section.parentTitle || section.title,
        subtopicTitle: section.title,
        breadcrumb,
      },
    };
    parents.push(parentChunk);

    // 2. Slice Parent Body into Child Chunks (Level 3: for Vector Search)
    const rawSlices = splitIntoIChildChunks(
      parentBody,
      childChunkTokenSize,
      childTokenOverlap,
    );

    rawSlices.forEach((slice, sliceIndex) => {
      // Inject breadcrumb prefix directly into child embedding text
      const enrichedChildText = `${breadcrumb}\n\n${slice}`;

      children.push({
        id: `${parentId}_c${sliceIndex + 1}`,
        parentId: parentId,
        text: enrichedChildText,
        tokenCount: estimateTokens(enrichedChildText),
        metadata: {
          bookTitle,
          chapterNumber: index + 1,
          chapterTitle: section.parentTitle || section.title,
          subtopicTitle: section.title,
          breadcrumb,
        },
      });
    });
  });

  return { parents, children };
}
