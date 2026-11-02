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

interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  str: string;
  x: number;
  x2: number;
  w: number;
}

interface ProcessedLine {
  y: number;
  h: number;
  cells: Cell[];
  rawText: string;
}

/**
 * Groups raw text items on a visual line into merged cells if gaps between them are within word spacing (<= 8px).
 */
function groupItemsIntoCells(items: TextItem[]): Cell[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.x - b.x);

  const cells: Cell[] = [];
  let curr = {
    str: sorted[0]!.str.trim(),
    x: sorted[0]!.x,
    x2: sorted[0]!.x + sorted[0]!.w,
    w: sorted[0]!.w,
  };

  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i]!;
    const gap = it.x - curr.x2;
    // Word spacing is 3-5px; gap <= 8px merges intra-cell words while keeping 12-15px column gutters separate
    if (gap <= 8) {
      curr.str = `${curr.str} ${it.str.trim()}`;
      curr.x2 = Math.max(curr.x2, it.x + it.w);
      curr.w = curr.x2 - curr.x;
    } else {
      cells.push(curr);
      curr = {
        str: it.str.trim(),
        x: it.x,
        x2: it.x + it.w,
        w: it.w,
      };
    }
  }
  cells.push(curr);
  return cells;
}

/**
 * Universal Bullet & Enumeration Detection (Document-Agnostic).
 * Detects Unicode bullets, numbers, letters, roman numerals, or generic short labels without hardcoding.
 */
function isBulletOrListLine(line: ProcessedLine): boolean {
  if (line.cells.length === 0) return false;
  const first = line.cells[0]!.str.trim();

  // A. Common Unicode bullet symbols & wrap arrows
  const isSymbolBullet =
    /^[•\-\*–—▪▫◦\u2022\u25cf\u25cb\u25aa\u25ba\u25b6\u2713\u2714\u2043\u2219\u21aa\u21b5\u21b3\u2190-\u21ff\u2794]/.test(
      first,
    ) ||
    first === "o" ||
    first === "O";

  // B. Standard enumeration: 1., (1), [1], 1.1, a., (a), [A], i., (iv)
  const isNumberedBullet =
    /^(?:\(?\d+[\.\)]|\(\d+\)|\[\d+\]|\d+\.\d+(\.\d+)*)\b/.test(first);
  const isLetterBullet =
    /^(?:\(?[a-zA-Z][\.\)]|\([a-zA-Z]\)|\[[a-zA-Z]\])\b/.test(first);
  const isRomanBullet =
    /^(?:\(?[ivxlcdmIVXLCDM]+[\.\)]|\([ivxlcdmIVXLCDM]+\))\b/.test(first);

  // C. Generic short alphanumeric label (e.g. Step 1, Item 2, Rule 3, Section 4, Q1, Stmt-1, PEO-1, CLO-1)
  // Exclude Figure/Fig/Table captions
  const isGenericLabel =
    !/^(?:figure|fig|table|diagram|chart)\b/i.test(first) &&
    (/^[A-Za-z]{1,8}[-_ ]?\d{1,4}\s*[:–\.-]?$/i.test(first) ||
      /^[A-Za-z]{1,8}[-_ ]?\d{1,4}\b/i.test(first));

  // D. Short term definition (e.g. "Note:", "Warning:", "Syntax:")
  const isTermDefinition =
    first.endsWith(":") &&
    line.cells.length === 2 &&
    first.length <= 25 &&
    !/^(?:figure|fig|table|diagram|chart)\b/i.test(first);

  if (
    isSymbolBullet ||
    isNumberedBullet ||
    isLetterBullet ||
    isRomanBullet ||
    isGenericLabel ||
    isTermDefinition
  ) {
    if (line.cells.length <= 2) return true;
    if (
      line.cells[0]!.w < 55 &&
      line.cells.slice(1).reduce((sum, c) => sum + c.w, 0) > 180
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Universal Heading Detection (Document-Agnostic).
 * Identifies headings by typographical structure, length, punctuation, and vertical isolation.
 */
function isHeadingLine(
  line: ProcessedLine,
  prevLine?: ProcessedLine,
  nextLine?: ProcessedLine,
): boolean {
  const text = line.rawText.trim();
  if (!text) return false;

  // Multi-column lines with gutters (> 15px) are table rows/headers, not headings
  if (line.cells.length >= 2) {
    const hasGutter = line.cells.some(
      (c, idx) => idx > 0 && c.x - line.cells[idx - 1]!.x2 > 15,
    );
    if (hasGutter) return false;
  }

  // Headings are concise (< 80 chars, < 14 words)
  if (text.length > 80 || text.split(/\s+/).length > 14) return false;

  // Headings do not end with sentence punctuation (. , ; ? !)
  if (/[.,;?!]$/.test(text)) return false;

  // Total text width of heading is compact (< 320px)
  const totalW = line.cells.reduce((sum, c) => sum + c.w, 0);
  if (totalW > 320) return false;

  // A. Numbered chapter/section patterns: e.g. "1. Introduction", "2.1 Methods", "Chapter 3"
  if (
    /^(?:chapter|section|part|appendix|module|lesson)\s+(?:\d+|[ivxlcdm]+)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/^(?:[0-9]+\.)+[0-9]*\s+[A-Z]/.test(text)) return true;

  // B. Isolated Title Case or UPPERCASE line with vertical whitespace gap
  const isUpperOrTitle =
    /^[A-Z0-9\s,:&()/-]{3,60}$/.test(text) ||
    /^[A-Z][a-z0-9]+(\s+[A-Z0-9][a-z0-9]*)*$/.test(text);

  if (isUpperOrTitle) {
    const hasGapAbove = prevLine ? Math.abs(prevLine.y - line.y) >= 16 : true;
    const hasGapBelow = nextLine ? Math.abs(line.y - nextLine.y) >= 12 : true;
    if (hasGapAbove || hasGapBelow) return true;
  }

  return false;
}

/**
 * Universal Running Header / Footer Detection (Document-Agnostic).
 * Strips running page numbers, document titles, or recurring text in margin zones.
 */
function isRunningHeaderOrFooter(
  line: ProcessedLine,
  pageHeight: number = 792,
): boolean {
  const text = line.rawText.trim();
  if (!text) return false;

  // Extreme top (> 93% of page) or extreme bottom (< 7% of page)
  const isMarginZone = line.y > pageHeight * 0.93 || line.y < pageHeight * 0.07;
  if (!isMarginZone) return false;

  // Common pagination patterns: "Page 1", "1 / 45", "1 of 20", "Doc Title / 1", single standalone number
  if (
    /^(?:page\s*\d+|\d+\s*[\/|]\s*\d+|\d+\s+of\s+\d+|.+?\s*[\/|]\s*\d+|\d+)$/i.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Clusters cell X coordinates into stable column anchors based on recurrence.
 */
function findColumnAnchors(lines: ProcessedLine[]): number[] {
  const allX: number[] = [];
  let multiCellLineCount = 0;

  for (const l of lines) {
    if (l.cells.length >= 2) {
      multiCellLineCount++;
      for (const c of l.cells) {
        allX.push(c.x);
      }
    }
  }
  if (allX.length === 0) return [];
  allX.sort((a, b) => a - b);

  const clusters: { sum: number; count: number; mean: number }[] = [];
  for (const x of allX) {
    let match = clusters.find((cl) => Math.abs(cl.mean - x) <= 12);
    if (!match) {
      match = { sum: x, count: 1, mean: x };
      clusters.push(match);
    } else {
      match.sum += x;
      match.count += 1;
      match.mean = Math.round(match.sum / match.count);
    }
  }

  // Minimum frequency based on multi-cell lines to preserve tables with many continuation lines
  const minFreq =
    multiCellLineCount <= 4 ? 2 : (
      Math.max(2, Math.ceil(multiCellLineCount * 0.15))
    );
  const validClusters = clusters
    .filter((cl) => cl.count >= minFreq)
    .map((cl) => cl.mean)
    .sort((a, b) => a - b);

  const anchors: number[] = [];
  for (const x of validClusters) {
    if (anchors.length === 0 || x - anchors[anchors.length - 1]! >= 16) {
      anchors.push(x);
    }
  }
  return anchors;
}

function getColumnIndex(cellX: number, anchors: number[]): number {
  if (anchors.length === 0) return 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const cut = (anchors[i]! + anchors[i + 1]!) / 2;
    if (cellX < cut) return i;
  }
  return anchors.length - 1;
}

/**
 * Assembles table lines into a clean Markdown table with row bounding and multiline cell continuation.
 */
function formatTable(lines: ProcessedLine[], anchors: number[]): string {
  const colCount = anchors.length;
  if (colCount < 2 || lines.length === 0) return "";

  const rows: string[][] = [];
  let currentRow: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const colCells = new Map<number, string>();
    for (const c of l.cells) {
      const cIdx = getColumnIndex(c.x, anchors);
      const existing = colCells.get(cIdx);
      colCells.set(cIdx, existing ? `${existing} ${c.str}` : c.str);
    }

    const hasCol0 = colCells.has(0);
    const hasCol1 = colCells.has(1);
    const hasCol2 = colCells.has(2);
    const isDense = colCells.size >= Math.min(3, colCount);

    // Line starts a new row if:
    // 1. It is the header line (first line)
    // 2. Col 0 is present (e.g. Unit 1, Unit 2 or SEM I, II or Course Code or PEO-1)
    // 3. In dense multi-column tables (>= 4 cols), having col 1 or col 2 along with dense columns
    const isNewRow =
      !currentRow ||
      hasCol0 ||
      (colCount >= 4 && (hasCol1 || hasCol2) && isDense);

    if (isNewRow) {
      if (currentRow) rows.push(currentRow);
      currentRow = Array(colCount).fill("");
    }

    // Accumulate cell content into currentRow
    for (const [cIdx, val] of colCells.entries()) {
      if (cIdx < colCount) {
        currentRow![cIdx] =
          currentRow![cIdx] ? `${currentRow![cIdx]} ${val}` : val;
      }
    }
  }

  if (currentRow) rows.push(currentRow);
  if (rows.length < 2) return "";

  // Prune completely empty columns across all rows
  const activeColIndices: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const hasData = rows.some((r) => r[c]?.trim().length! > 0);
    if (hasData) activeColIndices.push(c);
  }
  if (activeColIndices.length < 2) return "";

  const header = activeColIndices.map((c) => rows[0]![c]?.trim() || " ");
  const mdLines: string[] = [];
  mdLines.push(`| ${header.join(" | ")} |`);
  mdLines.push(`| ${header.map(() => "---").join(" | ")} |`);

  for (let r = 1; r < rows.length; r++) {
    const cells = activeColIndices.map((c) => {
      const txt = rows[r]![c]?.trim() || "";
      return txt ? txt.replace(/\|/g, "\\|") : " ";
    });
    mdLines.push(`| ${cells.join(" | ")} |`);
  }

  return mdLines.join("\n");
}

function isFigureCaptionLine(line: ProcessedLine): boolean {
  return /^(?:figure|fig\.?|diagram|chart)\s+\d+[\.\-]?\d*\s*[:\-\.]?\s*(.+)?/i.test(
    line.rawText.trim(),
  );
}

function isDiagramOrVectorLine(line: ProcessedLine): boolean {
  return /(?:→|-->|->|⇒|~>|<-|<--|←)/.test(line.rawText);
}

function hasInvalidColumns(lines: ProcessedLine[], anchors: number[]): boolean {
  if (anchors.length < 2) return true;
  const hasAnyAlphanumericInCol0 = lines.some((l) => {
    if (l.cells.length === 0) return false;
    const c0 = l.cells[0]!;
    return /[a-zA-Z0-9]/.test(c0.str);
  });
  return !hasAnyAlphanumericInCol0;
}

/**
 * Parses text items on a page, identifies tabular layouts and lists, and converts them to Markdown.
 */
function parsePageLayoutAndTables(
  items: TextItem[],
  previousCaption?: string,
  pageHeight: number = 792,
): { text: string; carriedCaption: string } {
  // 1. Group items into visual lines by matching Y coordinates
  items.sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));
  const rawLines: ProcessedLine[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    let l = rawLines.find((line) => Math.abs(line.y - it.y) <= 4);
    if (!l) {
      l = { y: it.y, h: it.h, cells: [], rawText: "" };
      rawLines.push(l);
    }
    l.cells.push(it as any);
  }
  rawLines.sort((a, b) => b.y - a.y);
  for (const l of rawLines) {
    l.cells = groupItemsIntoCells(l.cells as any);
    l.rawText = l.cells.map((c) => c.str).join(" ");
  }

  const outputBlocks: string[] = [];
  let pendingCaption = previousCaption || "";
  const tableCaptionRegex =
    /^(Table\s+\d+[\-\.:]\d*|\bTable\b)\s*[:\-\.]?\s*(.+)?/i;

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i]!;

    // 1. Universal running header / footer filtering
    if (isRunningHeaderOrFooter(line, pageHeight)) {
      i++;
      continue;
    }

    // 2. Table Caption Detection
    const captionMatch = line.rawText.match(tableCaptionRegex);
    if (
      captionMatch &&
      line.cells.length <= 2 &&
      line.cells.every((c) => c.w < 380)
    ) {
      pendingCaption = line.rawText;
      i++;
      continue;
    }

    // 3. Figure Caption Detection (Vector diagrams / Figures)
    if (isFigureCaptionLine(line)) {
      outputBlocks.push(`\n**${line.rawText}**\n`);
      i++;
      continue;
    }

    // 4. Heading Detection
    const prevLine = i > 0 ? rawLines[i - 1] : undefined;
    const nextLine = i + 1 < rawLines.length ? rawLines[i + 1] : undefined;
    if (isHeadingLine(line, prevLine, nextLine)) {
      outputBlocks.push(`\n### ${line.rawText}\n`);
      i++;
      continue;
    }

    // 5. Bullet / List Item (NOT a table)
    if (isBulletOrListLine(line)) {
      const first = line.cells[0]!.str;
      const rest = line.cells
        .slice(1)
        .map((c) => c.str)
        .join(" ");
      outputBlocks.push(`* **${first}**: ${rest}`);
      i++;
      continue;
    }

    // 6. Check for Table Block
    if (line.cells.length >= 2) {
      const candidateLines: ProcessedLine[] = [];
      let k = i;
      let tableLeft = Math.min(...line.cells.map((c) => c.x));
      let tableRight = Math.max(...line.cells.map((c) => c.x2));
      let hitFigure = false;
      let hitDiagramFlow = false;

      while (k < rawLines.length) {
        const next = rawLines[k]!;
        const prevCandidate =
          candidateLines.length > 0 ?
            candidateLines[candidateLines.length - 1]
          : undefined;

        // Termination checks:
        if (isHeadingLine(next)) break;
        if (isBulletOrListLine(next)) break;
        if (isRunningHeaderOrFooter(next, pageHeight)) break;
        if (isFigureCaptionLine(next)) {
          hitFigure = true;
          break;
        }

        // Detect diagram flow connectors (arrows etc)
        if (isDiagramOrVectorLine(next)) {
          hitDiagramFlow = true;
        }

        // Large vertical gap jump (> 35px between table lines)
        if (prevCandidate && Math.abs(prevCandidate.y - next.y) > 35) {
          break;
        }

        // Full-width body paragraph starting near left margin
        if (next.cells.length === 1) {
          const c0 = next.cells[0]!;
          const isAtLeftMargin = c0.x <= tableLeft + 20;
          const isFullWidth =
            c0.w >= (tableRight - tableLeft) * 0.75 || c0.w > 320;
          if (isAtLeftMargin && isFullWidth) {
            break;
          }
        }

        candidateLines.push(next);
        tableLeft = Math.min(tableLeft, ...next.cells.map((c) => c.x));
        tableRight = Math.max(tableRight, ...next.cells.map((c) => c.x2));
        k++;
      }

      // Do not convert vector diagrams/figures or invalid column structures to tables
      if (!hitFigure && !hitDiagramFlow) {
        const anchors = findColumnAnchors(candidateLines);
        const multiCellCount = candidateLines.filter(
          (l) => l.cells.length >= 2,
        ).length;

        if (
          anchors.length >= 2 &&
          multiCellCount >= 2 &&
          !hasInvalidColumns(candidateLines, anchors)
        ) {
          const mdTable = formatTable(candidateLines, anchors);
          if (mdTable) {
            if (pendingCaption) {
              outputBlocks.push(`\n**${pendingCaption}**\n`);
              pendingCaption = "";
            }
            outputBlocks.push(mdTable);
            i = k;
            continue;
          }
        }
      }
    }

    // Standard body line
    outputBlocks.push(line.rawText);
    i++;
  }

  return {
    text: outputBlocks.join("\n\n"),
    carriedCaption: pendingCaption,
  };
}

/**
 * Extracts line-separated text and Markdown-formatted tables from all pages.
 */
async function extractRawPages(doc: any): Promise<RawPage[]> {
  const pages: RawPage[] = [];
  let carriedCaption = "";

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    const items: TextItem[] = [];
    for (const item of textContent.items as any[]) {
      if (!item.str || typeof item.str !== "string" || !item.str.trim())
        continue;
      items.push({
        str: item.str.trim(),
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        w: Math.round(item.width),
        h: Math.round(item.height),
      });
    }

    const { text, carriedCaption: nextCaption } = parsePageLayoutAndTables(
      items,
      carriedCaption,
      viewport.height,
    );
    carriedCaption = nextCaption;

    pages.push({ pageNum: i, text: text.trim() });
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

  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
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
