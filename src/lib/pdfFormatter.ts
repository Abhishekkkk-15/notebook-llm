import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
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
  imageOutputDir?: string;
  extractImages?: boolean;
}

export interface ExtractedImage {
  id: string;
  pageNum: number;
  fileName: string;
  relativePath: string;
  width: number;
  height: number;
  hash: string;
}

// ==========================================
// 1. Pure Node.js PNG Encoder (Zero Dependencies)
// ==========================================
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, chunkData: Buffer): Buffer {
  const len = chunkData.length;
  const buf = Buffer.alloc(12 + len);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, "ascii");
  chunkData.copy(buf, 8);

  const crcBuf = Buffer.alloc(4 + len);
  crcBuf.write(type, 0, 4, "ascii");
  chunkData.copy(crcBuf, 4);
  const crc = crc32(crcBuf);
  buf.writeUInt32BE(crc, 8 + len);
  return buf;
}

export function encodeRawToPng(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
  channels: 3 | 4 = 4,
): Buffer {
  const lineLength = width * channels;
  const rawScanlines = Buffer.alloc(height * (lineLength + 1));

  let srcOffset = 0;
  let dstOffset = 0;

  for (let y = 0; y < height; y++) {
    rawScanlines[dstOffset++] = 0; // Filter byte 0 (None)
    for (let x = 0; x < lineLength; x++) {
      rawScanlines[dstOffset++] = data[srcOffset++] ?? 0;
    }
  }

  const compressed = zlib.deflateSync(rawScanlines);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = channels === 4 ? 6 : 2;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = makePngChunk("IHDR", ihdrData);

  const idatChunk = makePngChunk("IDAT", compressed);
  const iendChunk = makePngChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Extracts embedded raster images from a PDF page and writes deduplicated PNG files to disk.
 */
async function extractPageImages(
  page: any,
  pNum: number,
  pdfBaseName: string,
  outputDir: string,
  savedHashes: Map<string, string>,
): Promise<ExtractedImage[]> {
  const ops = await page.getOperatorList();
  const images: ExtractedImage[] = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (
      fn === pdfjsLib.OPS.paintImageXObject ||
      fn === pdfjsLib.OPS.paintInlineImageXObject
    ) {
      const imgName = ops.argsArray[i][0];
      const pool =
        typeof imgName === "string" && imgName.startsWith("g_")
          ? page.commonObjs
          : page.objs;

      await new Promise<void>((resolve) => {
        pool.get(imgName, (img: any) => {
          if (img && img.width > 25 && img.height > 25 && img.data) {
            const sampleBytes = img.data.slice(0, Math.min(img.data.length, 2048));
            const hash = crypto
              .createHash("md5")
              .update(`${img.width}x${img.height}_`)
              .update(sampleBytes)
              .digest("hex");

            let relPath = savedHashes.get(hash);
            if (!relPath) {
              const fileName = `${pdfBaseName}_p${pNum}_${imgName}.png`.replace(
                /[^a-zA-Z0-9._-]/g,
                "_",
              );
              const fullPath = path.join(outputDir, fileName);
              const channels =
                img.data.length === img.width * img.height * 4 ? 4 : 3;
              const pngBuf = encodeRawToPng(
                img.width,
                img.height,
                img.data,
                channels,
              );
              fs.writeFileSync(fullPath, pngBuf);
              relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
              if (!relPath.startsWith(".")) relPath = `./${relPath}`;
              savedHashes.set(hash, relPath);
            }

            images.push({
              id: imgName,
              pageNum: pNum,
              fileName: path.basename(relPath),
              relativePath: relPath,
              width: img.width,
              height: img.height,
              hash,
            });
          }
          resolve();
        });
      });
    }
  }

  return images;
}

// ==========================================
// 2. Flowchart to Mermaid Converter
// ==========================================
function isFlowchartCandidate(text: string): boolean {
  const arrowRegex = /\s*(?:→|-->|->|⇒|~>)\s*/;
  if (!arrowRegex.test(text)) return false;

  // Exclude currency rate listings e.g. EUR → USD: 2,282,608.70
  if (/\b(?:USD|EUR|GBP|INR|JPY|CAD|AUD|CNY)\b.+:\s*[\d,.]+/i.test(text)) {
    return false;
  }

  // Exclude code declarations
  if (/^(?:const|let|var|import|return|function)\b/.test(text.trim())) {
    return false;
  }

  const parts = text.split(arrowRegex).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;

  if (parts.length === 2) {
    if (parts[0]!.length < 3 || parts[1]!.length < 3) return false;
  }

  return true;
}

export function convertFlowToMermaid(rawText: string): string | null {
  if (!isFlowchartCandidate(rawText)) return null;

  const arrowRegex = /\s*(?:→|-->|->|⇒|~>)\s*/;
  const rawSteps = rawText
    .split(arrowRegex)
    .map((s) => s.trim())
    .filter(Boolean);

  const sanitizeLabel = (txt: string) => {
    return txt.replace(/["\\]/g, "").replace(/\n/g, " ").trim();
  };

  const lines: string[] = ["```mermaid", "flowchart LR"];
  for (let i = 0; i < rawSteps.length - 1; i++) {
    const fromId = `Step${i + 1}`;
    const toId = `Step${i + 2}`;
    const fromLabel = sanitizeLabel(rawSteps[i]!);
    const toLabel = sanitizeLabel(rawSteps[i + 1]!);
    lines.push(`    ${fromId}["${fromLabel}"] --> ${toId}["${toLabel}"]`);
  }
  lines.push("```");

  return lines.join("\n");
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
 * Crucially enforces that headings must start near the left margin or be centered across the page,
 * ensuring indented table cell fragments (like "MACHINE", "WEB", "LEARNING") are never misclassified as headings.
 */
function isHeadingLine(
  line: ProcessedLine,
  prevLine?: ProcessedLine,
  nextLine?: ProcessedLine,
  pageWidth: number = 612,
): boolean {
  const text = line.rawText.trim();
  if (!text || line.cells.length === 0) return false;

  // A heading MUST start near the left margin (X <= 115) OR be centered across the page
  const c0 = line.cells[0]!;
  const isNearLeftMargin = c0.x <= 115;
  const isCentered =
    Math.abs(c0.x + c0.w / 2 - pageWidth / 2) <= 35 && c0.w > 80;
  if (!isNearLeftMargin && !isCentered) return false;

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
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (cellX >= anchors[i]! - 10) {
      return i;
    }
  }
  return 0;
}

/**
 * Assembles table lines into a clean Markdown table with multiline header merging,
 * precise multi-line cell continuation, and column preservation.
 */
function formatTable(
  lines: ProcessedLine[],
  anchors: number[],
  carriedHeader?: string[],
): { markdown: string; headerRow: string[] } {
  const colCount = anchors.length;
  if (colCount < 2 || lines.length === 0) return { markdown: "", headerRow: [] };

  // 1. Separate Header Block vs Data Lines
  let firstPrimaryIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const c0 = l.cells.find((c) => getColumnIndex(c.x, anchors) === 0)?.str.trim();
    if (c0 && i > 0 && !/^(sem|unit|sr|s\.?no|#|no|code|course|sl|item)\b/i.test(c0)) {
      firstPrimaryIdx = i;
      break;
    }
  }

  if (firstPrimaryIdx === -1) {
    firstPrimaryIdx = lines.findIndex((l) => l.cells.length >= Math.min(3, colCount));
    if (firstPrimaryIdx === -1) firstPrimaryIdx = 1;
  }

  // Multi-line header block ends before firstPrimaryIdx
  let headerEndIdx = firstPrimaryIdx;
  if (
    headerEndIdx > 0 &&
    lines[headerEndIdx - 1]!.cells.length === 1 &&
    Math.abs(lines[headerEndIdx]!.y - lines[headerEndIdx - 1]!.y) <= 12
  ) {
    headerEndIdx--;
  }

  // 2. Build Header Row by merging all header lines (0 .. headerEndIdx - 1)
  const headerCells = new Map<number, string>();
  for (let i = 0; i < headerEndIdx; i++) {
    for (const c of lines[i]!.cells) {
      const cIdx = getColumnIndex(c.x, anchors);
      const existing = headerCells.get(cIdx);
      headerCells.set(cIdx, existing ? `${existing} ${c.str}` : c.str);
    }
  }

  const hRow: string[] = Array(colCount).fill("");
  for (const [cIdx, val] of headerCells.entries()) {
    hRow[cIdx] = val.trim();
  }
  if (hRow.every((val) => !val) && carriedHeader && carriedHeader.length === colCount) {
    for (let c = 0; c < colCount; c++) {
      hRow[c] = carriedHeader[c] || "";
    }
  }

  // 3. Identify Primary Rows from data lines (headerEndIdx onwards)
  interface PrimaryRow {
    idx: number;
    y: number;
    cells: Map<number, string>;
  }

  const primaryRows: PrimaryRow[] = [];
  const dataLines = lines.slice(headerEndIdx);

  for (let i = 0; i < dataLines.length; i++) {
    const l = dataLines[i]!;
    const cols = new Map<number, string>();
    for (const c of l.cells) {
      cols.set(getColumnIndex(c.x, anchors), c.str);
    }
    const hasCol0 = cols.has(0);
    const isDense = cols.size >= Math.min(3, colCount);

    if (hasCol0 || isDense) {
      primaryRows.push({ idx: i, y: l.y, cells: cols });
    }
  }

  if (primaryRows.length === 0) {
    for (let i = 0; i < dataLines.length; i++) {
      const l = dataLines[i]!;
      const cols = new Map<number, string>();
      for (const c of l.cells) {
        cols.set(getColumnIndex(c.x, anchors), c.str);
      }
      primaryRows.push({ idx: i, y: l.y, cells: cols });
    }
  }

  // 4. Two-pass Row Assembly:
  // First, check which lines between row r-1 and row r belong to row r as top fragments
  const pulledTopLines = new Set<number>();
  const topFragmentsPerRow = new Map<number, ProcessedLine[]>();

  for (let r = 0; r < primaryRows.length; r++) {
    const curr = primaryRows[r]!;
    const prev = r > 0 ? primaryRows[r - 1] : undefined;
    const startIdx = prev ? prev.idx + 1 : 0;
    const endIdx = curr.idx;

    const topFrags: ProcessedLine[] = [];

    // Check lines immediately above curr in ascending Y distance
    for (let k = endIdx - 1; k >= startIdx; k--) {
      const frag = dataLines[k]!;
      const dyCurr = frag.y - curr.y;
      if (dyCurr > 15 || dyCurr <= 0) break;
      if (frag.cells.length > 2) break;

      const c0 = frag.cells.find((c) => getColumnIndex(c.x, anchors) === 0);
      if (c0) break;

      const str = frag.cells[0]!.str.trim();
      // Top fragments can never start with lowercase or end with sentence punctuation (. or ;)
      if (/^[a-z]/.test(str) || /[.;]$/.test(str)) {
        break;
      }

      // Top title fragments are short (<= 35 chars, <= 160px)
      if (str.length > 35 || frag.cells[0]!.w > 160) {
        break;
      }

      const cIdx = getColumnIndex(frag.cells[0]!.x, anchors);
      const isColEmptyOnCurr = !curr.cells.has(cIdx);
      const currCellStr = curr.cells.get(cIdx)?.trim() || "";

      // If current row already has long text in this column (> 25 chars), it does not take top fragments
      if (currCellStr.length > 25) {
        break;
      }

      const prevLinesCount = k - startIdx;
      const dyPrev = prev ? prev.y - frag.y : Infinity;

      let belongsToCurr = false;
      if (isColEmptyOnCurr) {
        belongsToCurr = true;
      } else if (prevLinesCount > 0 && dyCurr <= 14) {
        belongsToCurr = true;
      } else if (prevLinesCount === 0 && dyCurr < dyPrev) {
        belongsToCurr = true;
      }

      if (belongsToCurr) {
        topFrags.unshift(frag);
        pulledTopLines.add(k);
      } else {
        break;
      }
    }

    if (topFrags.length > 0) {
      topFragmentsPerRow.set(r, topFrags);
    }
  }

  // Second pass: Assemble each row with its top fragments and its continuation lines below
  const assembledRows: Map<number, string>[] = [];

  for (let r = 0; r < primaryRows.length; r++) {
    const p = primaryRows[r]!;
    const rowMap = new Map<number, string>(p.cells);

    // Apply top fragments (prepended)
    const topFrags = topFragmentsPerRow.get(r);
    if (topFrags) {
      for (const frag of topFrags) {
        for (const c of frag.cells) {
          const cIdx = getColumnIndex(c.x, anchors);
          const currentVal = rowMap.get(cIdx);
          rowMap.set(cIdx, currentVal ? `${c.str} ${currentVal}` : c.str);
        }
      }
    }

    // Apply continuation lines below (until next primary row, excluding lines pulled as top frags by next row)
    const nextIdx = r + 1 < primaryRows.length ? primaryRows[r + 1]!.idx : dataLines.length;
    for (let k = p.idx + 1; k < nextIdx; k++) {
      if (pulledTopLines.has(k)) continue;
      const frag = dataLines[k]!;
      for (const c of frag.cells) {
        const cIdx = getColumnIndex(c.x, anchors);
        const currentVal = rowMap.get(cIdx);
        rowMap.set(cIdx, currentVal ? `${currentVal} ${c.str}` : c.str);
      }
    }

    assembledRows.push(rowMap);
  }

  // 5. Build Markdown Table
  const allRows: string[][] = [];
  allRows.push(hRow);

  for (const rMap of assembledRows) {
    const r: string[] = Array(colCount).fill("");
    for (const [cIdx, val] of rMap.entries()) {
      r[cIdx] = val.trim();
    }
    allRows.push(r);
  }

  // Prune completely empty columns
  const activeCols: number[] = [];
  for (let c = 0; c < colCount; c++) {
    if (allRows.some((r) => r[c]?.trim().length! > 0)) {
      activeCols.push(c);
    }
  }
  if (activeCols.length < 2) return { markdown: "", headerRow: [] };

  const header = activeCols.map((c) => allRows[0]![c]?.trim() || " ");
  const mdLines: string[] = [];
  mdLines.push(`| ${header.join(" | ")} |`);
  mdLines.push(`| ${header.map(() => "---").join(" | ")} |`);

  for (let r = 1; r < allRows.length; r++) {
    const cells = activeCols.map((c) => {
      const txt = allRows[r]![c]?.trim() || "";
      return txt ? txt.replace(/\|/g, "\\|") : " ";
    });
    mdLines.push(`| ${cells.join(" | ")} |`);
  }

  return {
    markdown: mdLines.join("\n"),
    headerRow: activeCols.map((c) => allRows[0]![c]?.trim() || ""),
  };
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
  pageWidth: number = 612,
  carriedHeader?: string[],
  pageImages: ExtractedImage[] = [],
  seenHeaderHashes: Set<string> = new Set(),
  pageNum: number = 1,
  pdfBaseName: string = "document",
): { text: string; carriedCaption: string; carriedHeader?: string[] } {
  // 1. Group items into visual lines by matching Y coordinates
  items.sort((a, b) => (Math.abs(b.y - a.y) > 2.5 ? b.y - a.y : a.x - b.x));
  const rawLines: ProcessedLine[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    let l = rawLines.find((line) => Math.abs(line.y - it.y) <= 2.5);
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
  let lastActiveHeader = carriedHeader;
  const tableCaptionRegex =
    /^(Table\s+\d+[\-\.:]\d*|\bTable\b)\s*[:\-\.]?\s*(.+)?/i;

  const claimedImageIds = new Set<string>();

  // Document / Page Header Banner (e.g. university letterhead or book top logo)
  for (const img of pageImages) {
    const isBanner = img.width > 800 && img.height < 350;
    if (isBanner) {
      if (!seenHeaderHashes.has(img.hash)) {
        seenHeaderHashes.add(img.hash);
        outputBlocks.push(`![${pdfBaseName} Header](${img.relativePath})`);
      }
      claimedImageIds.add(img.id);
    }
  }

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

    // 3. Figure Caption Detection (Vector diagrams / Figures / Images)
    if (isFigureCaptionLine(line)) {
      const unclaimedImg = pageImages.find((img) => !claimedImageIds.has(img.id));
      if (unclaimedImg) {
        outputBlocks.push(
          `![${line.rawText}](${unclaimedImg.relativePath})\n\n**${line.rawText}**`,
        );
        claimedImageIds.add(unclaimedImg.id);
      } else {
        outputBlocks.push(`\n**${line.rawText}**\n`);
      }
      i++;
      continue;
    }

    // 4. Standalone Vector Diagram / Process Flow (Mermaid flowchart)
    if (isFlowchartCandidate(line.rawText)) {
      const mermaid = convertFlowToMermaid(line.rawText);
      if (mermaid) {
        outputBlocks.push(mermaid);
        i++;
        continue;
      }
    }

    // 5. Heading Detection (passes pageWidth to verify margin/centering)
    const prevLine = i > 0 ? rawLines[i - 1] : undefined;
    const nextLine = i + 1 < rawLines.length ? rawLines[i + 1] : undefined;
    if (isHeadingLine(line, prevLine, nextLine, pageWidth)) {
      outputBlocks.push(`\n### ${line.rawText}\n`);
      i++;
      continue;
    }

    // 6. Bullet / List Item (NOT a table)
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

    // 7. Check for Table Block
    // Starts if line has >= 2 cells OR if line is indented cell continuation of upcoming table
    const isCandidateStart =
      line.cells.length >= 2 ||
      (line.cells.length === 1 &&
        line.cells[0]!.x > 115 &&
        i + 1 < rawLines.length &&
        rawLines[i + 1]!.cells.length >= 2 &&
        Math.abs(line.y - rawLines[i + 1]!.y) <= 12);

    if (isCandidateStart) {
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
        if (isHeadingLine(next, undefined, undefined, pageWidth)) break;
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
        if (candidateLines.length > 0 && next.cells.length === 1) {
          const c0 = next.cells[0]!;
          const isAtLeftMargin = c0.x <= 115 && c0.x <= tableLeft + 20;
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
          const { markdown: mdTable, headerRow } = formatTable(
            candidateLines,
            anchors,
            lastActiveHeader,
          );
          if (mdTable) {
            if (pendingCaption) {
              outputBlocks.push(`\n**${pendingCaption}**\n`);
              pendingCaption = "";
            }
            outputBlocks.push(mdTable);
            lastActiveHeader = headerRow;
            i = k;
            continue;
          }
        }
      } else {
        // If diagram or flow, check if any candidate line can be converted to Mermaid
        const flowLine = candidateLines.find((l) =>
          isFlowchartCandidate(l.rawText),
        );
        if (flowLine) {
          const mermaid = convertFlowToMermaid(flowLine.rawText);
          if (mermaid) {
            outputBlocks.push(mermaid);
            if (pendingCaption) {
              outputBlocks.push(`**${pendingCaption}**`);
              pendingCaption = "";
            }
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

  // Any remaining content images on this page that were not associated with a caption
  for (const img of pageImages) {
    if (!claimedImageIds.has(img.id)) {
      outputBlocks.push(
        `![Figure (${pdfBaseName} page ${pageNum})](${img.relativePath})`,
      );
      claimedImageIds.add(img.id);
    }
  }

  return {
    text: outputBlocks.join("\n\n"),
    carriedCaption: pendingCaption,
    carriedHeader: lastActiveHeader,
  };
}

/**
 * Extracts line-separated text and Markdown-formatted tables from all pages.
 */
async function extractRawPages(
  doc: any,
  pdfBaseName: string = "document",
  options: PdfReaderOptions = {},
): Promise<RawPage[]> {
  const pages: RawPage[] = [];
  let carriedCaption = "";
  let carriedHeader: string[] | undefined = undefined;

  const assetsDir =
    options.imageOutputDir || path.join(process.cwd(), "assets", "images");
  if (options.extractImages !== false) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const savedHashes = new Map<string, string>();
  const seenHeaderHashes = new Set<string>();

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    let pageImages: ExtractedImage[] = [];
    if (options.extractImages !== false) {
      try {
        pageImages = await extractPageImages(
          page,
          i,
          pdfBaseName,
          assetsDir,
          savedHashes,
        );
      } catch {
        // Non-blocking fallback if an image stream fails to decode
      }
    }

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

    const {
      text,
      carriedCaption: nextCaption,
      carriedHeader: nextHeader,
    } = parsePageLayoutAndTables(
      items,
      carriedCaption,
      viewport.height,
      viewport.width,
      carriedHeader,
      pageImages,
      seenHeaderHashes,
      i,
      pdfBaseName,
    );
    carriedCaption = nextCaption;
    carriedHeader = nextHeader;

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
  const pages = await extractRawPages(doc, bookTitle, options);

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
