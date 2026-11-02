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
  cells: Cell[];
  rawText: string;
}

/**
 * Groups raw text items on a visual line into merged cells if gaps between them are small (<= 14px).
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
 * Checks if a line is a bullet point or numbered/labeled list item (NOT a table row).
 */
function isBulletOrListLine(line: ProcessedLine): boolean {
  if (line.cells.length === 0) return false;
  const first = line.cells[0]!.str.trim();

  const isSymbolBullet = /^[•\-\*–—▪▫◦\u2022\u25cf\u25cb\u25aa]/.test(first) || first === "o" || first === "O";
  const isLabelBullet =
    /^(?:(?:\(?\d+[\.\)]|\(?[a-zA-Z][\.\)]|\b(?:CLO|CO|PEO|PSO|Stmt|Step|Section|Q|Fig|Figure)\s*[-–\.:]?\s*\d*))\b/i.test(
      first,
    );

  if (isSymbolBullet || isLabelBullet) {
    // If line has <= 2 cells, it's definitely a list item (e.g. "•" + "description" or "CLO1" + "text")
    if (line.cells.length <= 2) return true;

    // Check if remaining cells are just wrapped parts of a single sentence
    const totalW = line.cells.reduce((s, c) => s + c.w, 0);
    if (totalW > 300 && line.cells.length <= 3) return true;
  }
  return false;
}

/**
 * Checks if a line is a heading.
 */
function isHeadingLine(line: ProcessedLine): boolean {
  const text = line.rawText.trim();
  if (!text) return false;
  return /^(Semester\s+[IVX\d]+|Elective\s+\d+|Track\s+\d+|Course\s+Learning\s+Objectives|Course\s+Outcomes|Suggested\s+Readings|Department\s+Vision|Department\s+Mission|Program\s+Education\s+Objectives|Program\s+Specific\s+Outcomes|\d+\.\s+[A-Z])/i.test(
    text,
  );
}

/**
 * Checks if a line is a note, footer, or body paragraph that signals table termination.
 */
function isTableTerminator(line: ProcessedLine): boolean {
  const text = line.rawText.trim();
  if (!text) return true;
  if (/^FCS\s*[-–]\s*MCA\s*Syllabus/i.test(text)) return true;
  if (/^(?:Mandatory\s+Training|COMPULSORY|Note\b|Notes\b|Suggested\s+Readings)/i.test(text)) return true;
  return false;
}

/**
 * Clusters cell X coordinates into stable column anchors based on frequency.
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

  // Minimum frequency based on multi-cell lines, so tables with many continuation lines aren't penalized
  const minFreq = multiCellLineCount <= 4 ? 2 : Math.max(2, Math.ceil(multiCellLineCount * 0.15));
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
    // 3. In dense multi-column tables (>= 4 cols), having col 1 or col 2 along with dense columns (for rows where col 0 is blank/spanned)
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
        currentRow![cIdx] = currentRow![cIdx]
          ? `${currentRow![cIdx]} ${val}`
          : val;
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

/**
 * Parses text items on a page, identifies tabular layouts and lists, and converts them to Markdown.
 */
function parsePageLayoutAndTables(
  items: TextItem[],
  previousCaption?: string,
): { text: string; carriedCaption: string } {
  // 1. Group items into visual lines by matching Y coordinates
  items.sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));
  const rawLines: ProcessedLine[] = [];
  for (const it of items) {
    let l = rawLines.find((line) => Math.abs(line.y - it.y) <= 4);
    if (!l) {
      l = { y: it.y, cells: [], rawText: "" };
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
  const tableCaptionRegex = /^(Table\s+\d+[\-\.:]\d*|\bTable\b)\s*[:\-\.]?\s*(.+)?/i;

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i]!;

    // Ignore page running headers/footers
    if (/FCS\s*[-–]\s*MCA\s*Syllabus/i.test(line.rawText)) {
      i++;
      continue;
    }

    // Check if this row is a Table Caption
    const captionMatch = line.rawText.match(tableCaptionRegex);
    if (captionMatch && line.cells.length <= 2 && line.cells.every((c) => c.w < 380)) {
      pendingCaption = line.rawText;
      i++;
      continue;
    }

    // Heading Line
    if (isHeadingLine(line)) {
      outputBlocks.push(`\n### ${line.rawText}\n`);
      i++;
      continue;
    }

    // Bullet / Labeled List Item (NOT a table)
    if (isBulletOrListLine(line)) {
      const first = line.cells[0]!.str;
      const rest = line.cells.slice(1).map((c) => c.str).join(" ");
      outputBlocks.push(`* **${first}**: ${rest}`);
      i++;
      continue;
    }

    // Check for Table Block
    if (line.cells.length >= 2) {
      const candidateLines: ProcessedLine[] = [];
      let k = i;
      while (k < rawLines.length) {
        const next = rawLines[k]!;
        if (isHeadingLine(next)) break;
        if (isBulletOrListLine(next)) break;
        if (isTableTerminator(next)) break;

        // Note line like "H - High Correlation..." ends the matrix table
        if (/^H\s*[-–]\s*High Correlation/i.test(next.rawText)) {
          candidateLines.push(next);
          k++;
          break;
        }

        candidateLines.push(next);
        k++;
      }

      const anchors = findColumnAnchors(candidateLines);
      const multiCellCount = candidateLines.filter((l) => l.cells.length >= 2).length;

      if (anchors.length >= 2 && multiCellCount >= 2) {
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
    const textContent = await page.getTextContent();

    const items: TextItem[] = [];
    for (const item of textContent.items as any[]) {
      if (!item.str || typeof item.str !== "string" || !item.str.trim()) continue;
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
