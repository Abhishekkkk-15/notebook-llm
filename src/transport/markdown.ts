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

export function renderMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const formatted: string[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Code block fences: ```lang
    const codeFenceMatch = line.match(/^```(\w+)?/);
    if (codeFenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = (codeFenceMatch[1] || "").toLowerCase();
        const isMermaid = codeLanguage === "mermaid";
        const badge = isMermaid
          ? "📊 Mermaid Flowchart"
          : codeLanguage
            ? codeLanguage.toUpperCase()
            : "CODE";
        formatted.push(
          `\n${c.muted}  ┌─ ${isMermaid ? c.amberBright : c.cyan}[${badge}]${c.muted} ${"─".repeat(35)}${c.reset}`,
        );
      } else {
        inCodeBlock = false;
        codeLanguage = "";
        formatted.push(`${c.muted}  └${"─".repeat(50)}${c.reset}\n`);
      }
      continue;
    }

    if (inCodeBlock) {
      if (codeLanguage === "mermaid") {
        const styled = line
          .replace(/-->|->|→/g, `${c.amberBright}──▶${c.reset}`)
          .replace(/\["?(.*?)"?\]/g, `${c.cyanBright}[$1]${c.reset}`);
        formatted.push(`  ${c.muted}│${c.reset}   ${styled}`);
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

  return formatted.join("\n");
}

export function printAnswerCard(title: string, markdownContent: string): void {
  const rendered = renderMarkdown(markdownContent);
  console.log(`\n${c.muted}╭─ ${c.bold}${c.cyanBright}${title}${c.reset} ${c.muted}${"─".repeat(45)}╮${c.reset}\n`);
  console.log(rendered);
  console.log(`\n${c.muted}╰${"─".repeat(60)}╯${c.reset}\n`);
}
