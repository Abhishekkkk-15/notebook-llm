import fs from "fs";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export interface FormattedSection {
  title: string;
  parentTitle?: string;
  breadcrumb: string;
  pageStart: number;
  pageEnd: number;
  content: string;
}

export interface FormattedBook {
  bookTitle: string;
  totalPages: number;
  sections: FormattedSection[];
}

export interface PdfReaderOptions {
  bookTitle?: string;
}

interface RawPage {
  pageNum: number;
  text: string;
}

interface OutlineNode {
  title: string;
  pageIndex: number;
  parentTitle?: string;
}

/**
 * Extracts line-separated text from all pages while preserving basic layout flow.
 */
async function extractRawPages(doc: any): Promise<RawPage[]> {
  const pages: RawPage[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();

    let lastY: number | undefined;
    let pageText = "";

    for (const item of textContent.items as any[]) {
      if (!item.str) continue;

      // New line if vertical Y-coordinate changes significantly (> 5 points)
      if (lastY !== undefined && Math.abs(item.transform[5] - lastY) > 5) {
        pageText += "\n";
      } else if (
        pageText &&
        !pageText.endsWith(" ") &&
        !pageText.endsWith("\n")
      ) {
        pageText += " ";
      }

      pageText += item.str;
      lastY = item.transform[5];
    }

    pages.push({ pageNum: i, text: pageText.trim() });
  }

  return pages;
}

/**
 * Resolves the PDF embedded outline/bookmarks tree into a flat sequence of sections.
 */
async function resolveOutline(
  doc: any,
  items: any[],
  parentTitle?: string,
): Promise<OutlineNode[]> {
  const result: OutlineNode[] = [];
  if (!items || !items.length) return result;

  for (const item of items) {
    let pageIndex = -1;

    try {
      let dest = item.dest;
      if (typeof dest === "string") {
        dest = await doc.getDestination(dest);
      }
      if (Array.isArray(dest) && dest[0]) {
        pageIndex = await doc.getPageIndex(dest[0]);
      }
    } catch {
      // Fallback if destination reference fails to resolve
    }

    if (pageIndex !== -1) {
      result.push({
        title: item.title.trim(),
        pageIndex,
        parentTitle: parentTitle || "",
      });
    }

    // Traverse nested subtopics
    if (item.items && item.items.length > 0) {
      const nested = await resolveOutline(doc, item.items, item.title.trim());
      result.push(...nested);
    }
  }

  return result.sort((a, b) => a.pageIndex - b.pageIndex);
}

/**
 * Regex-based TOC fallback if the PDF lacks an embedded bookmark outline.
 */
function createHeuristicOutline(pages: RawPage[]): OutlineNode[] {
  const outline: OutlineNode[] = [];
  const headingRegex = /^(chapter\s+\d+|[0-9]+\.[0-9]+(\.[0-9]+)?)\s+(.+)$/im;

  pages.forEach((p, idx) => {
    const lines = p.text.split("\n");
    for (const line of lines) {
      if (headingRegex.test(line.trim())) {
        outline.push({
          title: line.trim(),
          pageIndex: idx,
        });
        break;
      }
    }
  });

  return outline;
}

/**
 * Reads and formats any PDF into structured topic/subtopic sections with content.
 */
export async function readAndFormatPdf(
  pdfPath: string,
  options: PdfReaderOptions = {},
): Promise<FormattedBook> {
  const bookTitle =
    options.bookTitle || path.basename(pdfPath, path.extname(pdfPath));
  const fileBuffer = fs.readFileSync(pdfPath);
  const data = new Uint8Array(fileBuffer);

  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true })
    .promise;
  const pages = await extractRawPages(doc);

  // 1. Try reading the embedded PDF bookmark outline
  const outline = await doc.getOutline();
  let nodes: OutlineNode[] = [];

  if (outline && outline.length > 0) {
    nodes = await resolveOutline(doc, outline);
  }

  // 2. Fallback to heuristic heading detection if no outline exists
  if (nodes.length === 0) {
    nodes = createHeuristicOutline(pages);
  }

  // 3. Fallback to 5-page blocks if no headings were found at all
  if (nodes.length === 0) {
    for (let i = 0; i < pages.length; i += 5) {
      nodes.push({
        title: `Pages ${i + 1} - ${Math.min(i + 5, pages.length)}`,
        pageIndex: i,
      });
    }
  }

  // 4. Stitch page texts together into formatted section blocks
  const sections: FormattedSection[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    const next = nodes[i + 1];

    const startPage = current!.pageIndex;
    const endPage = next ? next.pageIndex : pages.length;

    const content = pages
      .slice(startPage, endPage)
      .map((p) => p.text)
      .join("\n\n")
      .trim();

    if (!content) continue;

    const parentPrefix =
      current!.parentTitle ? `${current!.parentTitle} > ` : "";
    const breadcrumb = `[${bookTitle} > ${parentPrefix}${current!.title}]`;

    sections.push({
      title: current!.title,
      parentTitle: current!.parentTitle || "",
      breadcrumb,
      pageStart: startPage + 1,
      pageEnd: endPage,
      content,
    });
  }

  return {
    bookTitle,
    totalPages: doc.numPages,
    sections,
  };
}
