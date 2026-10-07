import { config } from "dotenv";
import { chunkBookHierarchy } from "./lib/tokenizer.js";
import { readAndFormatPdf } from "./lib/pdfFormatter.js";
import { chunkFormattedBook } from "./lib/chunker.js";
config();
// const bookSample = `
// # Thermodynamics and Heat Flow

// ## The Carnot Cycle
// A Carnot cycle consists of four successive steps: two isothermal processes and two adiabatic processes.
// During the first step, gas absorbs heat at constant temperature T_h. The system expands reversibly against the piston.

// In the second step, the gas expands adiabatically without heat exchange. The working substance cools from T_h to T_c. This process produces mechanical work by expending internal energy.

// ## Thermal Efficiency Limitations
// Real heat engines cannot achieve 100% thermal efficiency due to irreversible friction and heat leakage.
// Second law of thermodynamics establishes that entropy generation must always be non-negative in closed thermodynamic cycles.
// `;

// const result = chunkBookHierarchy(bookSample, {
//   bookTitle: "Engineering Thermodynamics",
//   childChunkTokenSize: 50,
//   childTokenOverlap: 10,
// });

// console.log("=== PARENT CHUNK (For Generation) ===");
// console.log(result.parents[0]);

// console.log("\n=== CHILD CHUNK (For Vector Search) ===");
// console.log(result.children[0]);

// async function main() {
//   const result = await readAndFormatPdf(
//     "./AI-Agents-in-Depth-Bojie-Li-v1.2.pdf",
//     {
//       bookTitle: "AI Agents in Depth",
//     },
//   );

//   console.log(`Title: ${result.bookTitle}`);
//   console.log(`Total Pages: ${result.totalPages}`);
//   console.log(`Extracted Sections: ${result.sections.length}\n`);

//   // Inspect the first section
//   const firstSection = result.sections[0];
//   if (!firstSection) return;
//   console.log("Breadcrumb:", firstSection.breadcrumb);
//   console.log(
//     "Page Range:",
//     `${firstSection.pageStart} - ${firstSection.pageEnd}`,
//   );
//   console.log("ALL SECTINION", result.sections);
// }

// main();

async function processPdf(pdfFilePath: string) {
  // 1. Read & Format PDF directly into structured sections
  const formattedBook = await readAndFormatPdf(pdfFilePath, {
    bookTitle: "AI Agents in Depth",
  });

  console.log(
    `Extracted ${formattedBook.sections.length} sections from ${formattedBook.totalPages} pages.`,
  );

  // 2. Feed structured sections into the chunking pipeline
  const { parents, children } = chunkFormattedBook(formattedBook, {
    childChunkTokenSize: 200,
    childTokenOverlap: 40,
  });

  console.log(`Generated:`);
  console.log(`- ${parents.length} Parent Chunks (for Document/KV Store)`);
  console.log(`- ${children.length} Child Chunks (for Vector Database)`);

  return { parents, children };
}

// Example execution
processPdf("./AI-Agents-in-Depth-Bojie-Li-v1.2.pdf").then((p) => {
  console.log(p.parents[p.parents.length]);
});
