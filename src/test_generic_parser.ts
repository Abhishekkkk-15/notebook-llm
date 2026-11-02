import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import path from "path";

export interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  str: string;
  x: number;
  x2: number;
  w: number;
}

export interface ProcessedLine {
  y: number;
  h: number;
  cells: Cell[];
  rawText: string;
}

/**
 * 1. Universal Whitespace & Word Merging
 * Merges adjacent text tokens within normal inter-word spacing (<= 8px).
 */
export function groupItemsIntoCells(items: TextItem[]): Cell[] {
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
 * 2. Universal Bullet & Enumeration Detection (Document-Agnostic)
 * Detects standard Unicode bullets, digits, letters, roman numerals, or short alphanumeric keys.
 */
export function isBulletOrListLine(line: ProcessedLine): boolean {
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
    // A list item has either:
    // 1. Only 1 or 2 cells (marker + text)
    // 2. Or marker is narrow (< 55px) and followed by wide body text (> 180px)
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
 * 3. Universal Heading Detection (Document-Agnostic)
 * Detects headings via layout, typography, punctuation, and structural numbering.
 */
export function isHeadingLine(
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
 * 4. Universal Running Header / Footer Detection (Document-Agnostic)
 * Strips running page numbers, document titles, or recurring text in margin zones.
 */
export function isRunningHeaderOrFooter(
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
 * 5. Universal Column Anchors (Document-Agnostic)
 * Finds recurring column gutters from lines that have multiple cells.
 */
export function findColumnAnchors(lines: ProcessedLine[]): number[] {
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

  // Cluster X coordinates within 12px tolerance
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

  // Anchor must appear in at least 2 multi-cell lines (or 15% of multi-cell lines)
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

export function getColumnIndex(cellX: number, anchors: number[]): number {
  if (anchors.length === 0) return 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const cut = (anchors[i]! + anchors[i + 1]!) / 2;
    if (cellX < cut) return i;
  }
  return anchors.length - 1;
}

/**
 * 6. Universal Table Formatting with Multiline Continuation (Document-Agnostic)
 */
export function formatTable(lines: ProcessedLine[], anchors: number[]): string {
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

    // Starts a new row if:
    // 1. First line of the table (header)
    // 2. Has cell in Column 0
    // 3. Dense across columns (for tables where Column 0 is spanned or empty)
    const isNewRow =
      !currentRow ||
      hasCol0 ||
      (colCount >= 4 && (hasCol1 || hasCol2) && isDense);

    if (isNewRow) {
      if (currentRow) rows.push(currentRow);
      currentRow = Array(colCount).fill("");
    }

    // Append cells to active row
    for (const [cIdx, val] of colCells.entries()) {
      if (cIdx < colCount) {
        currentRow![cIdx] =
          currentRow![cIdx] ? `${currentRow![cIdx]} ${val}` : val;
      }
    }
  }

  if (currentRow) rows.push(currentRow);
  if (rows.length < 2) return "";

  // Prune empty columns
  const activeCols: number[] = [];
  for (let c = 0; c < colCount; c++) {
    if (rows.some((r) => r[c]?.trim().length! > 0)) activeCols.push(c);
  }
  if (activeCols.length < 2) return "";

  const header = activeCols.map((c) => rows[0]![c]?.trim() || " ");
  const mdLines: string[] = [];
  mdLines.push(`| ${header.join(" | ")} |`);
  mdLines.push(`| ${header.map(() => "---").join(" | ")} |`);

  for (let r = 1; r < rows.length; r++) {
    const cells = activeCols.map((c) => {
      const txt = rows[r]![c]?.trim() || "";
      return txt ? txt.replace(/\|/g, "\\|") : " ";
    });
    mdLines.push(`| ${cells.join(" | ")} |`);
  }

  return mdLines.join("\n");
}

export function isFigureCaptionLine(line: ProcessedLine): boolean {
  return /^(?:figure|fig\.?|diagram|chart)\s+\d+[\.\-]?\d*\s*[:\-\.]?\s*(.+)?/i.test(
    line.rawText.trim(),
  );
}

export function isDiagramOrVectorLine(line: ProcessedLine): boolean {
  return /(?:→|-->|->|⇒|~>|<-|<--|←)/.test(line.rawText);
}

export function hasInvalidColumns(
  lines: ProcessedLine[],
  anchors: number[],
): boolean {
  if (anchors.length < 2) return true;
  const hasAnyAlphanumericInCol0 = lines.some((l) => {
    if (l.cells.length === 0) return false;
    const c0 = l.cells[0]!;
    return /[a-zA-Z0-9]/.test(c0.str);
  });
  return !hasAnyAlphanumericInCol0;
}

/**
 * 7. Universal Page Parser (Document-Agnostic)
 */
export function parseUniversalPage(
  items: TextItem[],
  pageHeight: number = 792,
): string {
  // Group raw items into visual lines
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
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i]!;

    // 1. Running headers & footers
    if (isRunningHeaderOrFooter(line, pageHeight)) {
      i++;
      continue;
    }

    // 2. Figure Caption (Vector image / Diagram)
    if (isFigureCaptionLine(line)) {
      outputBlocks.push(`\n**${line.rawText}**\n`);
      i++;
      continue;
    }

    // 3. Headings
    const prevLine = i > 0 ? rawLines[i - 1] : undefined;
    const nextLine = i + 1 < rawLines.length ? rawLines[i + 1] : undefined;
    if (isHeadingLine(line, prevLine, nextLine)) {
      outputBlocks.push(`\n### ${line.rawText}\n`);
      i++;
      continue;
    }

    // 4. Bullet / List Items
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

    // 5. Candidate Table Block
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

        // Full-width paragraph starting near left margin
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
        const multiCount = candidateLines.filter(
          (l) => l.cells.length >= 2,
        ).length;

        if (
          anchors.length >= 2 &&
          multiCount >= 2 &&
          !hasInvalidColumns(candidateLines, anchors)
        ) {
          const mdTable = formatTable(candidateLines, anchors);
          if (mdTable) {
            outputBlocks.push(mdTable);
            i = k;
            continue;
          }
        }
      }
    }

    // 6. Regular body paragraph line
    outputBlocks.push(line.rawText);
    i++;
  }

  return outputBlocks.join("\n\n");
}

async function runGenericTest() {
  const pdfPath = process.argv[2] || "./sal.pdf";
  console.log(`Running Universal Document-Agnostic Parser on: ${pdfPath}...`);
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  let totalTables = 0;
  let totalBullets = 0;
  let totalHeadings = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: TextItem[] = [];

    for (const it of tc.items as any[]) {
      if (!it.str || typeof it.str !== "string" || !it.str.trim()) continue;
      items.push({
        str: it.str.trim(),
        x: Math.round(it.transform[4]),
        y: Math.round(it.transform[5]),
        w: Math.round(it.width),
        h: Math.round(it.height),
      });
    }

    const output = parseUniversalPage(items, viewport.height);
    const tables = (output.match(/^\|\s*---\s*\|/gm) || []).length;
    const bullets = (output.match(/^\* \*\*[^*]+\*\*:/gm) || []).length;
    const headings = (output.match(/^###\s+.+/gm) || []).length;

    totalTables += tables;
    totalBullets += bullets;
    totalHeadings += headings;
    console.log(output);

    if (p === 0) {
      console.log(`\n========================================`);
      console.log(`PAGE 7 GENERIC PARSED OUTPUT PREVIEW:`);
      console.log(`========================================`);
      console.log(output);
      console.log(`========================================\n`);
    }
  }

  console.log(`\n========================================`);
  console.log(`GENERIC PARSER RESULTS (All ${doc.numPages} Pages)`);
  console.log(`========================================`);
  console.log(`Total Markdown Tables Extracted: ${totalTables}`);
  console.log(`Total Lists/Bullets Formatted:   ${totalBullets}`);
  console.log(`Total Headings Detected:         ${totalHeadings}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("test_generic_parser.ts")) {
  runGenericTest().catch(console.error);
}
