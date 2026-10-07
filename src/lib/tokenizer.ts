import type {
  ChunkingConfig,
  IChildChunk,
  IParentChunk,
} from "../types/chunktypes.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

export function splitIntoIChildChunks(
  parentText: string,
  targetTokens = 200,
  overlapTokens = 40,
): string[] {
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;
  if (parentText.length <= targetChars) {
    return [parentText.trim()];
  }
  const chunks: string[] = [];
  const paragraphs = parentText.split(/\n\s*\n/);

  let currentBuffer = "";

  for (const para of paragraphs) {
    if ((currentBuffer + "\n\n" + para).length <= targetChars) {
      currentBuffer = currentBuffer ? `${currentBuffer}\n\n${para}` : para;
    } else {
      if (currentBuffer) {
        chunks.push(currentBuffer.trim());
        // Carry forward trailing characters as overlap
        const sliceStart = Math.max(0, currentBuffer.length - overlapChars);
        currentBuffer = currentBuffer.slice(sliceStart) + "\n\n" + para;
      } else {
        // Single Paragraph exceeds target size: split by sentences
        const sentences = para.split(/(?<=[.?!])\s+/);
        for (const sentence of sentences) {
          if ((currentBuffer.length + " " + sentence).length <= targetChars) {
            currentBuffer =
              currentBuffer ? `${currentBuffer} ${sentence}` : sentence;
          } else {
            if (currentBuffer) chunks.push(currentBuffer.trim());
            const sliceStart = Math.max(0, currentBuffer.length - overlapChars);
            currentBuffer = currentBuffer.slice(sliceStart) + " " + sentence;
          }
        }
      }
    }
  }
  if (currentBuffer.trim()) {
    chunks.push(currentBuffer.trim());
  }
  return chunks;
}

export function chunkBookHierarchy(
  bookMarkdown: string,
  config: ChunkingConfig,
): { parents: IParentChunk[]; children: IChildChunk[] } {
  const {
    bookTitle,
    childChunkTokenSize = 200,
    childTokenOverlap = 40,
  } = config;

  const parents: IParentChunk[] = [];
  const children: IChildChunk[] = [];

  // Split by top-level chapters (# Chapter ...)
  const chapterBlocks = bookMarkdown.split(/^#\s+/m).filter(Boolean);

  let chapterIndex = 0;

  for (const chapterBlock of chapterBlocks) {
    chapterIndex++;
    const [rawChapterHeading, ...chapterBodyLines] = chapterBlock.split("\n");
    const chapterTitle = rawChapterHeading!.trim();
    const chapterContent = chapterBodyLines.join("\n").trim();

    // Split chapter into subtopics (## Subtopic ...)
    const subtopicBlocks = chapterContent.split(/^##\s+/m).filter(Boolean);

    let subtopicIndex = 0;

    for (const subtopicBlock of subtopicBlocks) {
      subtopicIndex++;
      const [rawSubtopicHeading, ...subtopicBodyLines] =
        subtopicBlock.split("\n");
      const subtopicTitle = rawSubtopicHeading!.trim();
      const parentBody = subtopicBodyLines.join("\n").trim();

      if (!parentBody) continue;

      const parentId = `p_ch${chapterIndex}_sec${subtopicIndex}`;
      const breadcrumb = `[${bookTitle} > Ch.${chapterIndex}: ${chapterTitle} > ${subtopicTitle}]`;

      // 1. Create Parent Chunk (Store in KV store / DB)
      const IParentChunk: IParentChunk = {
        id: parentId,
        text: `## ${subtopicTitle}\n\n${parentBody}`,
        tokenCount: estimateTokens(parentBody),
        metadata: {
          bookTitle,
          chapterNumber: chapterIndex,
          chapterTitle,
          subtopicTitle,
          breadcrumb,
        },
      };
      parents.push(IParentChunk);

      // 2. Slice Parent into Child Chunks (Store in Vector DB)
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
            chapterNumber: chapterIndex,
            chapterTitle,
            subtopicTitle,
            breadcrumb,
          },
        });
      });
    }
  }

  return { parents, children };
}
