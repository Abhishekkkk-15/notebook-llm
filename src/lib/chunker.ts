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
  const projectId = config?.projectId;

  const parents: IParentChunk[] = [];
  const children: IChildChunk[] = [];

  book.sections.forEach((section: FormattedSection, index: number) => {
    const parentBody = section.content.trim();
    if (!parentBody) return;

    const parentId = projectId
      ? `p_${projectId}_sec_${index + 1}_p${section.pageStart}`
      : `p_sec_${index + 1}_p${section.pageStart}`;
    const breadcrumb = section.breadcrumb;

    const sectionImages = (section.images || []).map((img) => ({
      id: img.id,
      pageNum: img.pageNum,
      fileName: img.fileName,
      relativePath: img.relativePath,
      url: img.url || img.relativePath,
      width: img.width,
      height: img.height,
      hash: img.hash,
      caption: img.caption,
    }));
    const sectionImageUrls = sectionImages.map((img) => img.url);
    const sectionImageCaptions = sectionImages
      .map((img) => img.caption || "")
      .filter(Boolean);
    const parentHasDiagrams = /```mermaid/i.test(parentBody);

    // 1. Map to IParentChunk (Level 2: complete section for LLM context)
    const parentChunk: IParentChunk = {
      id: parentId,
      text: `## ${section.title}\n\n${parentBody}`,
      tokenCount: estimateTokens(parentBody),
      metadata: {
        projectId,
        bookTitle,
        chapterNumber: index + 1,
        chapterTitle: section.parentTitle || section.title,
        subtopicTitle: section.title,
        breadcrumb,
        type: "text",
        images: sectionImages,
        imageUrls: sectionImageUrls,
        imageCaptions: sectionImageCaptions,
        hasDiagrams: parentHasDiagrams,
      },
    };
    parents.push(parentChunk);

    // 2. Slice Parent Body into Child Chunks (Level 3: for Text Vector Search)
    const rawSlices = splitIntoIChildChunks(
      parentBody,
      childChunkTokenSize,
      childTokenOverlap,
    );

    rawSlices.forEach((slice, sliceIndex) => {
      // Find images that appear in this specific slice
      const sliceImages = sectionImages.filter(
        (img) =>
          slice.includes(img.relativePath) || slice.includes(img.fileName),
      );
      const sliceImageUrls = sliceImages.map((img) => img.url);
      const sliceImageCaptions = sliceImages
        .map((img) => img.caption || "")
        .filter(Boolean);
      const sliceHasDiagrams = /```mermaid/i.test(slice);

      // Inject breadcrumb prefix directly into child embedding text
      const enrichedChildText = `${breadcrumb}\n\n${slice}`;

      children.push({
        id: `${parentId}_c${sliceIndex + 1}`,
        parentId: parentId,
        text: enrichedChildText,
        tokenCount: estimateTokens(enrichedChildText),
        metadata: {
          projectId,
          bookTitle,
          chapterNumber: index + 1,
          chapterTitle: section.parentTitle || section.title,
          subtopicTitle: section.title,
          breadcrumb,
          type: "text",
          images: sliceImages,
          imageUrls: sliceImageUrls,
          imageCaptions: sliceImageCaptions,
          hasDiagrams: sliceHasDiagrams,
        },
      });
    });

    // 3. Dedicated Image Child Chunks (Level 3: for Multimodal / Image Vector Search)
    sectionImages.forEach((img, imgIndex) => {
      const imgDesc = img.caption
        ? `Figure: ${img.caption}`
        : `Image file: ${img.fileName} (Page ${img.pageNum})`;
      const enrichedImageText = `${breadcrumb}\n\n${imgDesc}`;

      children.push({
        id: `${parentId}_img_${img.id || imgIndex + 1}`,
        parentId: parentId,
        text: enrichedImageText,
        tokenCount: estimateTokens(enrichedImageText),
        metadata: {
          projectId,
          bookTitle,
          chapterNumber: index + 1,
          chapterTitle: section.parentTitle || section.title,
          subtopicTitle: section.title,
          breadcrumb,
          type: "image",
          images: [img],
          imageUrls: [img.url],
          imageCaptions: img.caption ? [img.caption] : [],
          hasDiagrams: false,
        },
      });
    });
  });

  return { parents, children };
}
