import fs from "fs";
import path from "path";
import { exec } from "child_process";
import terminalImage from "terminal-image";
import { renderMermaidASCII } from "beautiful-mermaid";

export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  text: "\x1b[37m",
  muted: "\x1b[90m",
  cyan: "\x1b[36m",
  cyanBright: "\x1b[96m",
  emerald: "\x1b[32m",
  emeraldBright: "\x1b[92m",
  amber: "\x1b[33m",
  amberBright: "\x1b[93m",
  rose: "\x1b[31m",
  roseBright: "\x1b[91m",
  violet: "\x1b[35m",
  violetBright: "\x1b[95m",
  blue: "\x1b[34m",
};

export function formatInline(text: string): string {
  return text
    // Image: ![alt](url) -> 📸 [Figure: alt] (url)
    .replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      `📸 ${c.emeraldBright}[Figure: $1]${c.reset} ${c.muted}($2)${c.reset}`,
    )
    // Link: [title](url) -> title (url)
    .replace(
      /(?<!\!)\[([^\]]+)\]\(([^)]+)\)/g,
      `${c.underline}$1${c.reset} ${c.muted}($2)${c.reset}`,
    )
    // Bold: **text** or __text__
    .replace(/\*\*(.+?)\*\*/g, `${c.bold}$1${c.reset}`)
    .replace(/__(.+?)__/g, `${c.bold}$1${c.reset}`)
    // Italic: *text* or _text_
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, `${c.italic}$1${c.reset}`)
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, `${c.italic}$1${c.reset}`)
    // Inline code: `code`
    .replace(/`([^`\n]+)`/g, `${c.cyanBright}$1${c.reset}`);
}

/**
 * Renders a Mermaid flowchart / architecture diagram into clean ASCII/Unicode art.
 * Automatically falls back to syntax-highlighted code block if diagram syntax fails.
 */
export function renderMermaidDiagram(code: string): string {
  const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);
  const cleanCode = code.trim();

  try {
    const ascii = renderMermaidASCII(cleanCode, {
      useAscii: false,
      colorMode: "truecolor",
    });

    const lines = ascii.split("\n");
    const out: string[] = [
      `\n\x1b[36m╭── 📊 Flowchart / Architecture Diagram ${"─".repeat(Math.max(4, termWidth - 36))}╮\x1b[0m`,
    ];
    for (const l of lines) {
      out.push(`\x1b[36m│\x1b[0m  ${l}`);
    }
    out.push(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);
    return out.join("\n");
  } catch {
    // Fallback if diagram parsing fails
    const out: string[] = [
      `\n${c.muted}  ┌─ ${c.amberBright}[📊 Mermaid Flowchart]${c.muted} ${"─".repeat(Math.max(10, termWidth - 30))}${c.reset}`,
    ];
    for (const l of cleanCode.split("\n")) {
      const styled = l
        .replace(/-->|->|→/g, `${c.amberBright}──▶${c.reset}`)
        .replace(/\["?(.*?)"?\]/g, `${c.cyanBright}[$1]${c.reset}`);
      out.push(`  ${c.muted}│${c.reset}   ${styled}`);
    }
    out.push(`${c.muted}  └${"─".repeat(Math.max(20, termWidth - 10))}${c.reset}\n`);
    return out.join("\n");
  }
}

export function renderMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const formatted: string[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";
  let mermaidBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Code block fences: ```lang
    const codeFenceMatch = line.match(/^```(\w+)?/);
    if (codeFenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = (codeFenceMatch[1] || "").toLowerCase();
        const isMermaid =
          codeLanguage === "mermaid" ||
          codeLanguage === "flowchart" ||
          codeLanguage === "graph";
        if (isMermaid) {
          codeLanguage = "mermaid";
          mermaidBuffer = [];
        } else {
          const badge = codeLanguage ? codeLanguage.toUpperCase() : "CODE";
          formatted.push(
            `\n${c.muted}  ┌─ ${c.cyan}[${badge}]${c.muted} ${"─".repeat(35)}${c.reset}`,
          );
        }
      } else {
        if (codeLanguage === "mermaid") {
          formatted.push(renderMermaidDiagram(mermaidBuffer.join("\n")));
          mermaidBuffer = [];
        } else {
          formatted.push(`${c.muted}  └${"─".repeat(50)}${c.reset}\n`);
        }
        inCodeBlock = false;
        codeLanguage = "";
      }
      continue;
    }

    if (inCodeBlock) {
      if (codeLanguage === "mermaid") {
        mermaidBuffer.push(line);
      } else {
        formatted.push(
          `  ${c.muted}│${c.reset}   ${c.cyanBright}${line}${c.reset}`,
        );
      }
      continue;
    }

    // Headings
    if (line.startsWith("# ")) {
      formatted.push(
        `\n${c.bold}${c.cyanBright}# ${line.slice(2).trim()}${c.reset}`,
      );
      continue;
    }
    if (line.startsWith("## ")) {
      formatted.push(
        `\n${c.bold}${c.cyan}## ${line.slice(3).trim()}${c.reset}`,
      );
      continue;
    }
    if (line.startsWith("### ")) {
      formatted.push(
        `\n${c.bold}${c.text}### ${line.slice(4).trim()}${c.reset}`,
      );
      continue;
    }

    // Horizontal rules
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      formatted.push(`${c.muted}${"─".repeat(50)}${c.reset}`);
      continue;
    }

    // Blockquotes
    if (line.startsWith("> ") || line === ">") {
      const quoteText = line.startsWith("> ") ? line.slice(2) : "";
      formatted.push(
        `${c.muted}▎ ${c.italic}${formatInline(quoteText)}${c.reset}`,
      );
      continue;
    }

    // Table rows
    if (/^\|(.+)\|$/.test(line.trim())) {
      // Separator row
      if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(line.trim())) {
        const colCount = line
          .split("|")
          .filter((s) => s.trim().length > 0).length;
        formatted.push(
          `${c.muted}  ${"─".repeat(Math.max(25, colCount * 18))}${c.reset}`,
        );
        continue;
      }
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      const formattedRow = cells
        .map((cell) => formatInline(cell).padEnd(16))
        .join(`${c.muted} │ ${c.reset}`);
      formatted.push(`  ${formattedRow}`);
      continue;
    }

    // Unordered lists
    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1] || "";
      const bulletIcon = indent.length > 0 ? "◦" : "•";
      const bulletColor = indent.length > 0 ? c.muted : c.cyan;
      formatted.push(
        `${indent}${bulletColor}${bulletIcon}${c.reset} ${formatInline(bulletMatch[3]!)}`,
      );
      continue;
    }

    // Numbered lists
    const numMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (numMatch) {
      const indent = numMatch[1] || "";
      const num = numMatch[2];
      formatted.push(
        `${indent}${c.cyan}${num}.${c.reset} ${formatInline(numMatch[3]!)}`,
      );
      continue;
    }

    formatted.push(formatInline(line));
  }

  // Handle unclosed code block at EOF
  if (inCodeBlock) {
    if (codeLanguage === "mermaid" && mermaidBuffer.length > 0) {
      formatted.push(renderMermaidDiagram(mermaidBuffer.join("\n")));
    } else {
      formatted.push(`${c.muted}  └${"─".repeat(50)}${c.reset}\n`);
    }
  }

  return formatted.join("\n");
}

export function printAnswerCard(title: string, markdownContent: string): void {
  const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);
  const rendered = renderMarkdown(markdownContent);
  console.log(`\n\x1b[36m╭─ \x1b[1m\x1b[96m${title}\x1b[0m`);
  console.log(rendered);
  console.log(`\x1b[90m╰${"─".repeat(termWidth)}\x1b[0m\n`);
}

/**
 * Opens a local image in the user's OS native image viewer (Preview on macOS,
 * eog/feh on Linux, Photos on Windows) in full resolution.
 */
export function openImageInSystemViewer(imagePath: string): boolean {
  const absPath = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(process.cwd(), imagePath);

  if (!fs.existsSync(absPath)) return false;

  const cmd =
    process.platform === "darwin"
      ? `open "${absPath}"`
      : process.platform === "win32"
        ? `start "" "${absPath}"`
        : `xdg-open "${absPath}"`;

  try {
    exec(cmd, () => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Renders full markdown text, dynamically replacing image placeholders
 * like `![Figure caption](assets/images/...)` with real terminal graphics.
 */
export async function renderChunkWithImages(rawText: string): Promise<void> {
  const lines = rawText.split("\n");
  const textBuffer: string[] = [];
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/;
  const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(imageRegex);

    if (match) {
      // 1. Flush and render any preceding text before the image
      if (textBuffer.length > 0) {
        console.log(renderMarkdown(textBuffer.join("\n")));
        textBuffer.length = 0;
      }

      const caption = match[1] || "Figure";
      const imgPath = match[2]!;
      const resolvedPath = path.isAbsolute(imgPath)
        ? imgPath
        : path.resolve(process.cwd(), imgPath);

      // Check if next lines contain duplicate caption (e.g. **Figure 1-6...**)
      while (
        i + 1 < lines.length &&
        (!lines[i + 1]!.trim() ||
          lines[i + 1]!.toLowerCase().includes(caption.toLowerCase()))
      ) {
        i++;
      }

      // 2. Print Figure Card with sleek Left-Rail styling
      console.log(`\n\x1b[32m╭── 📸 Figure: \x1b[1m${caption}\x1b[0m`);
      console.log(`\x1b[32m│\x1b[0m   \x1b[90mSource File: file://${resolvedPath}\x1b[0m`);

      if (fs.existsSync(resolvedPath)) {
        try {
          const imgWidth = Math.min(termWidth - 8, 120);
          const renderedImg = await terminalImage.file(resolvedPath, {
            width: imgWidth,
            preferNativeRender: false, // Ensures consistent ANSI TrueColor RGB rendering across all terminals
          });
          if (renderedImg) {
            console.log(`\x1b[32m│\x1b[0m`);
            console.log(renderedImg);
          }
          console.log(`\x1b[32m│\x1b[0m`);
          console.log(`\x1b[32m│\x1b[0m   \x1b[36m💡 Select this chunk in inspector to open in 4K native viewer\x1b[0m`);
        } catch (err: any) {
          console.log(`\x1b[32m│\x1b[0m   \x1b[90m(Preview unavailable: ${err.message})\x1b[0m`);
        }
      } else {
        console.log(`\x1b[32m│\x1b[0m   \x1b[90m(Image file not found at: ${resolvedPath})\x1b[0m`);
      }

      console.log(`\x1b[32m╰${"─".repeat(termWidth)}\x1b[0m\n`);
    } else {
      textBuffer.push(line);
    }
  }

  // 3. Flush any remaining text at the end of the chunk
  if (textBuffer.length > 0) {
    console.log(renderMarkdown(textBuffer.join("\n")));
  }
}
