import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";

export interface FilePickerOptions {
  startingDir?: string;
  extension?: string; // e.g. ".pdf"
}

/**
 * Interactive TUI file picker using @clack/prompts.
 * Allows navigating directories, viewing PDF files with sizes,
 * and selecting a file or entering a custom path.
 */
export async function pickPdfFile(
  options: FilePickerOptions = {},
): Promise<string | null> {
  let currentDir = path.resolve(options.startingDir || process.cwd());
  const ext = (options.extension || ".pdf").toLowerCase();

  while (true) {
    console.clear();

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err: any) {
      p.log.error(`Cannot read directory: ${currentDir} (${err.message})`);
      currentDir = path.resolve(currentDir, "..");
      continue;
    }

    // Separate matching files and subdirectories
    const pdfFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext))
      .sort((a, b) => a.name.localeCompare(b.name));

    const subDirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        // Ignore hidden or massive dependency folders
        if (
          e.name.startsWith(".") ||
          e.name === "node_modules" ||
          e.name === "dist"
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const choices: Array<{ value: string; label: string; hint?: string }> = [];

    // 1. Matching PDF files at top
    for (const file of pdfFiles) {
      const fullPath = path.join(currentDir, file.name);
      let sizeStr = "";
      try {
        const stats = fs.statSync(fullPath);
        const mb = stats.size / (1024 * 1024);
        sizeStr =
          mb >= 1
            ? `${mb.toFixed(1)} MB`
            : `${(stats.size / 1024).toFixed(1)} KB`;
      } catch {
        sizeStr = "unknown size";
      }

      choices.push({
        value: `FILE:${fullPath}`,
        label: `📄 ${file.name}`,
        hint: sizeStr,
      });
    }

    // 2. Directory Navigation
    for (const dir of subDirs) {
      choices.push({
        value: `DIR:${path.join(currentDir, dir.name)}`,
        label: `📁 ${dir.name}/`,
        hint: "Open folder",
      });
    }

    // 3. Parent Directory
    const parentDir = path.resolve(currentDir, "..");
    if (parentDir !== currentDir) {
      choices.push({
        value: `DIR:${parentDir}`,
        label: `⬆️  .. (Go up one folder)`,
        hint: path.basename(parentDir) || parentDir,
      });
    }

    // 4. Manual path entry option
    choices.push({
      value: "MANUAL",
      label: `✏️  Enter custom file path manually...`,
    });

    // 5. Cancel option
    choices.push({
      value: "CANCEL",
      label: `❌ Cancel and return to menu`,
    });

    const displayRelDir = path.relative(process.cwd(), currentDir) || ".";
    const selected = await p.select({
      message: `Select a PDF file (Current folder: ./${displayRelDir.replace(/\\/g, "/")})`,
      options: choices,
    });

    if (p.isCancel(selected) || selected === "CANCEL") {
      return null;
    }

    if (typeof selected === "string") {
      if (selected.startsWith("FILE:")) {
        const filePath = selected.slice(5);
        return filePath;
      }

      if (selected.startsWith("DIR:")) {
        currentDir = selected.slice(4);
        continue;
      }

      if (selected === "MANUAL") {
        const manualInput = await p.text({
          message: "Enter the relative or absolute path to the PDF file:",
          placeholder: "e.g. ./sal.pdf or D:/docs/paper.pdf",
          validate: (val) => {
            if (!val || !val.trim()) return "Path cannot be empty";
            const resolved = path.resolve(process.cwd(), val.trim());
            if (!fs.existsSync(resolved))
              return `File does not exist: ${resolved}`;
            if (!resolved.toLowerCase().endsWith(ext))
              return `File must end with ${ext}`;
            return undefined;
          },
        });

        if (p.isCancel(manualInput)) {
          continue;
        }

        return path.resolve(process.cwd(), manualInput.trim());
      }
    }
  }
}
