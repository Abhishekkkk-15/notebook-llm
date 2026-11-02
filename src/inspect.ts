import fs from "fs";
import path from "path";
import { readAndFormatPdf } from "./lib/pdfFormatter.js";
import { chunkFormattedBook } from "./lib/chunker.js";

async function main() {
  const targetPdf = process.argv[2] || "sal.pdf";
  const resolvedPdf = path.resolve(process.cwd(), targetPdf);

  if (!fs.existsSync(resolvedPdf)) {
    console.error(`\n❌ Error: File not found: ${resolvedPdf}`);
    console.log("Usage: pnpm inspect [path-to-pdf] (e.g. pnpm inspect sal.pdf or pnpm inspect ai.pdf)\n");
    process.exit(1);
  }

  console.log(`\n======================================================`);
  console.log(` 🔍 Inspecting PDF: ${path.basename(resolvedPdf)}`);
  console.log(`======================================================\n`);

  console.log(`1. Parsing PDF, extracting images & Mermaid diagrams...`);
  const startTime = Date.now();
  const book = await readAndFormatPdf(resolvedPdf);
  const parseTime = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`   ✓ Parsed in ${parseTime}s`);
  console.log(`   - Book Title:   ${book.bookTitle}`);
  console.log(`   - Total Pages:  ${book.totalPages}`);
  console.log(`   - Sections:     ${book.sections.length}`);
  console.log(`   - Total Images: ${book.images?.length ?? 0}`);

  console.log(`\n2. Verifying Extracted Image Files on Disk:`);
  if (!book.images || book.images.length === 0) {
    console.log(`   (No embedded images found in this document)`);
  } else {
    for (const img of book.images) {
      const fullDiskPath = path.resolve(process.cwd(), img.relativePath);
      const exists = fs.existsSync(fullDiskPath);
      const sizeKB = exists ? (fs.statSync(fullDiskPath).size / 1024).toFixed(1) : "0";
      console.log(`   📸 [${exists ? "EXISTS" : "MISSING"}] ${img.fileName} (${sizeKB} KB)`);
      console.log(`      • Page:       ${img.pageNum}`);
      console.log(`      • Stored URL: ${img.url}`);
      console.log(`      • Size:       ${img.width}x${img.height} px`);
      console.log(`      • Caption:    "${img.caption || "None"}"`);
      console.log(`      • Full Path:  ${fullDiskPath}`);
    }
  }

  console.log(`\n3. Running Chunker (Parent & Child Chunks)...`);
  const { parents, children } = chunkFormattedBook(book);
  console.log(`   ✓ Parents (MongoDB documents):    ${parents.length}`);
  console.log(`   ✓ Children (Pinecone vectors):    ${children.length}`);

  const parentsWithImages = parents.filter((p) => (p.metadata.images?.length ?? 0) > 0);
  const parentsWithDiagrams = parents.filter((p) => p.metadata.hasDiagrams);
  const childrenWithImages = children.filter((c) => (c.metadata.imageUrls?.length ?? 0) > 0);
  const childrenWithDiagrams = children.filter((c) => c.metadata.hasDiagrams);

  console.log(`   - Parents with image metadata:   ${parentsWithImages.length}`);
  console.log(`   - Parents with Mermaid diagrams: ${parentsWithDiagrams.length}`);
  console.log(`   - Children with image URLs:      ${childrenWithImages.length}`);
  console.log(`   - Children with Mermaid diagram: ${childrenWithDiagrams.length}`);

  // Create complete JSON inspection payload
  const inspectionOutput = {
    summary: {
      pdfFile: path.basename(resolvedPdf),
      bookTitle: book.bookTitle,
      totalPages: book.totalPages,
      sectionsCount: book.sections.length,
      totalExtractedImages: book.images?.length ?? 0,
      parentChunksCount: parents.length,
      childChunksCount: children.length,
      parentsWithImagesCount: parentsWithImages.length,
      parentsWithDiagramsCount: parentsWithDiagrams.length,
      childrenWithImagesCount: childrenWithImages.length,
      childrenWithDiagramsCount: childrenWithDiagrams.length,
    },
    images: (book.images || []).map((img) => {
      const fullPath = path.resolve(process.cwd(), img.relativePath);
      return {
        ...img,
        fullDiskPath: fullPath,
        fileExists: fs.existsSync(fullPath),
        fileSizeBytes: fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0,
      };
    }),
    sampleParentWithImage: parentsWithImages[0] ?? null,
    sampleParentWithDiagram: parentsWithDiagrams[0] ?? null,
    sampleChildWithImage: childrenWithImages[0] ?? null,
    sampleChildWithDiagram: childrenWithDiagrams[0] ?? null,
    sections: book.sections.map((s) => ({
      title: s.title,
      parentTitle: s.parentTitle,
      breadcrumb: s.breadcrumb,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      images: s.images || [],
      diagramCount: (s.content.match(/```mermaid/g) || []).length,
      contentLength: s.content.length,
      contentPreview: s.content.slice(0, 300) + (s.content.length > 300 ? "..." : ""),
    })),
  };

  const outputFileName = `${path.basename(resolvedPdf, path.extname(resolvedPdf))}_inspection.json`;
  const outputFilePath = path.resolve(process.cwd(), outputFileName);
  fs.writeFileSync(outputFilePath, JSON.stringify(inspectionOutput, null, 2), "utf-8");

  console.log(`\n======================================================`);
  console.log(` ✅ Full JSON written to: ${outputFileName}`);
  console.log(`    Absolute Path: ${outputFilePath}`);
  console.log(`======================================================\n`);
}

main().catch(console.error);
