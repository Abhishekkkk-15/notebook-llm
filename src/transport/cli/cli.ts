import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * ============================================================================
 * INTERACTIVE CLI / TUI FOR NOTEBOOK-LLM / GRAPH-RAG
 * ============================================================================
 *
 * Clean, minimal, modern terminal interface.
 * Decoupled from core logic via ICLIHandlers.
 */

// ─── MINIMAL ANSI PALETTE (Subtle & Modern) ─────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Modern soft palette
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

// ─── TYPE DEFINITIONS ───────────────────────────────────────────────────────

/** Source reference item displayed after a RAG query or similarity search */
export interface ICLISourceMatch {
  id: string;
  score: number;
  breadcrumb?: string;
  text?: string;
  metadata?: Record<string, any>;
}

/** Result returned by the `onQuery` handler */
export interface ICLIQueryResponse {
  answer?: string;
  sources?: ICLISourceMatch[];
  raw?: any;
}

/** Result returned by the `onIngest` handler */
export interface ICLIIngestResult {
  bookTitle?: string;
  totalPages?: number;
  sectionsCount?: number;
  parentCount: number;
  childCount: number;
  message?: string;
}

/** Configurable hooks for linking the CLI to the underlying application */
export interface ICLIHandlers {
  onQuery?: (
    query: string,
    options: { topK: number; namespace: string },
  ) => Promise<ICLIQueryResponse | string | void>;

  onSearch?: (
    query: string,
    options: { topK: number; namespace: string },
  ) => Promise<ICLISourceMatch[]>;

  onIngest?: (
    filePath: string,
    options: { title?: string; childChunkTokenSize?: number; childTokenOverlap?: number },
  ) => Promise<ICLIIngestResult | void>;

  onStatus?: () => Promise<Record<string, any> | void>;

  onClear?: (namespace?: string) => Promise<string | void>;

  onCustomCommand?: (command: string, args: string[]) => Promise<string | void>;
}

/** Configuration options for InteractiveCLI */
export interface ICLIConfig {
  appName?: string;
  version?: string;
  defaultNamespace?: string;
  defaultTopK?: number;
  promptSymbol?: string;
  bannerSubtitle?: string;
}

/**
 * Modern Minimal Interactive CLI / TUI Controller
 */
export class InteractiveCLI {
  private config: Required<ICLIConfig>;
  private handlers: ICLIHandlers = {};
  private rl: readline.Interface | null = null;
  private isRunning = false;
  private abortController: AbortController | null = null;

  private state: {
    namespace: string;
    topK: number;
  };

  // Spinner state
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrameIndex = 0;
  private readonly spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  constructor(config?: ICLIConfig, handlers?: ICLIHandlers) {
    this.config = {
      appName: config?.appName ?? "notebook-llm",
      version: config?.version ?? "1.0.0",
      defaultNamespace: config?.defaultNamespace ?? "child_chunks",
      defaultTopK: config?.defaultTopK ?? 5,
      promptSymbol: config?.promptSymbol ?? "›",
      bannerSubtitle: config?.bannerSubtitle ?? "Hierarchical Parent-Document RAG",
    };

    this.state = {
      namespace: this.config.defaultNamespace,
      topK: this.config.defaultTopK,
    };

    if (handlers) {
      this.handlers = handlers;
    }
  }

  public setHandlers(handlers: Partial<ICLIHandlers>): this {
    this.handlers = { ...this.handlers, ...handlers };
    return this;
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("CLI is already running.");
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.printBanner();

    this.rl = readline.createInterface({
      input,
      output,
      terminal: input.isTTY ?? false,
    });

    this.rl.on("SIGINT", () => {
      this.printInfo("Interrupt signal caught (Ctrl+C). Type /exit to quit.");
      this.prompt();
    });

    this.rl.on("close", () => {
      if (this.isRunning) {
        this.stop();
      }
    });

    await this.replLoop();
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.stopSpinner();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    console.log(`\n${c.muted}Session ended. Bye!${c.reset}\n`);
  }

  // ─── REPL LOOP ────────────────────────────────────────────────────────────

  private async replLoop(): Promise<void> {
    while (this.isRunning && this.rl) {
      try {
        // Minimal prompt: [namespace] ›
        const promptLabel = `${c.muted}[${c.cyan}${this.state.namespace}${c.muted}]${c.reset} ${c.cyanBright}${this.config.promptSymbol}${c.reset} `;
        const rawInput = await this.rl.question(promptLabel, {
          signal: this.abortController?.signal,
        });
        const line = rawInput.trim();

        if (!line) {
          continue;
        }

        await this.handleInput(line);
      } catch (err: any) {
        if (!this.isRunning || err?.name === "AbortError") break;
        this.printError("Unexpected terminal loop error", err);
      }
    }
  }

  private async handleInput(inputStr: string): Promise<void> {
    if (inputStr.startsWith("/")) {
      const parts = inputStr.slice(1).trim().split(/\s+/);
      const command = parts[0]?.toLowerCase() ?? "";
      const args = parts.slice(1);

      switch (command) {
        case "help":
        case "?":
          this.printHelp();
          break;

        case "exit":
        case "quit":
        case "q":
          this.stop();
          break;

        case "clear":
        case "cls":
          if (args.length === 0 || args[0] === "screen") {
            console.clear();
            this.printBanner();
          } else {
            await this.executeClear(args[0]);
          }
          break;

        case "ask":
        case "query": {
          const queryText = args.join(" ").trim();
          if (!queryText) {
            this.printWarn("Usage: /ask <question>");
            return;
          }
          await this.executeQuery(queryText);
          break;
        }

        case "search": {
          const searchText = args.join(" ").trim();
          if (!searchText) {
            this.printWarn("Usage: /search <terms>");
            return;
          }
          await this.executeSearch(searchText);
          break;
        }

        case "ingest": {
          const filePath = args[0];
          if (!filePath) {
            this.printWarn("Usage: /ingest <path-to-pdf> [title]");
            return;
          }
          const title = args.slice(1).join(" ") || undefined;
          await this.executeIngest(filePath, title);
          break;
        }

        case "status":
          await this.executeStatus();
          break;

        case "set":
          this.executeSet(args);
          break;

        default:
          if (this.handlers.onCustomCommand) {
            this.startSpinner(`Executing /${command}...`);
            try {
              const res = await this.handlers.onCustomCommand(command, args);
              this.stopSpinner(true);
              if (res) console.log(res);
            } catch (err) {
              this.stopSpinner(false);
              this.printError(`Command /${command} failed`, err);
            }
          } else {
            this.printWarn(`Unknown command /${command}. Type ${c.bold}/help${c.reset} for list.`);
          }
          break;
      }
    } else {
      await this.executeQuery(inputStr);
    }
  }

  // ─── ACTIONS ──────────────────────────────────────────────────────────────

  private async executeQuery(query: string): Promise<void> {
    if (!this.handlers.onQuery) {
      this.printWarn("No 'onQuery' handler registered. Connect via cli.setHandlers({ onQuery: ... })");
      return;
    }

    this.startSpinner("Thinking & retrieving context...");
    const startTime = Date.now();

    try {
      const response = await this.handlers.onQuery(query, {
        topK: this.state.topK,
        namespace: this.state.namespace,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      this.stopSpinner(true, `Done in ${elapsed}s`);

      if (!response) {
        this.printInfo("No response returned.");
        return;
      }

      if (typeof response === "string") {
        this.printResponseBox("Answer", response);
      } else {
        if (response.answer) {
          this.printResponseBox("Answer", response.answer);
        }
        if (response.sources && response.sources.length > 0) {
          this.printSources(response.sources);
        }
      }
    } catch (err) {
      this.stopSpinner(false, "Query failed");
      this.printError("Failed to process query", err);
    }
  }

  private async executeSearch(query: string): Promise<void> {
    if (!this.handlers.onSearch) {
      this.printWarn("No 'onSearch' handler registered. Connect via cli.setHandlers({ onSearch: ... })");
      return;
    }

    this.startSpinner(`Searching vector index...`);
    const startTime = Date.now();

    try {
      const results = await this.handlers.onSearch(query, {
        topK: this.state.topK,
        namespace: this.state.namespace,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      this.stopSpinner(true, `Found ${results.length} matches in ${elapsed}s`);

      this.printSources(results);
    } catch (err) {
      this.stopSpinner(false, "Search failed");
      this.printError("Vector search error", err);
    }
  }

  private async executeIngest(filePath: string, title?: string): Promise<void> {
    if (!this.handlers.onIngest) {
      this.printWarn("No 'onIngest' handler registered. Connect via cli.setHandlers({ onIngest: ... })");
      return;
    }

    this.startSpinner(`Ingesting ${filePath}...`);
    const startTime = Date.now();

    try {
      const res = await this.handlers.onIngest(filePath, { title });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      this.stopSpinner(true, `Ingestion finished in ${elapsed}s`);

      if (res) {
        const entries: Array<[string, string]> = [
          ["Title", res.bookTitle ?? title ?? "N/A"],
          ["Total Pages", String(res.totalPages ?? "N/A")],
          ["Sections", String(res.sectionsCount ?? "N/A")],
          ["Parent Chunks", `${c.emerald}${res.parentCount}${c.reset}`],
          ["Child Chunks", `${c.cyan}${res.childCount}${c.reset}`],
        ];
        if (res.message) {
          entries.push(["Note", `${c.muted}${res.message}${c.reset}`]);
        }
        this.printCard("Ingestion Summary", entries);
      }
    } catch (err) {
      this.stopSpinner(false, "Ingestion failed");
      this.printError(`Failed to ingest "${filePath}"`, err);
    }
  }

  private async executeStatus(): Promise<void> {
    console.log(`\n${c.bold}System Status${c.reset}`);
    this.printKeyValueList([
      ["Namespace", `${c.cyan}${this.state.namespace}${c.reset}`],
      ["Top-K", `${c.amber}${this.state.topK}${c.reset}`],
      ["App Version", `${this.config.appName} v${this.config.version}`],
    ]);

    if (this.handlers.onStatus) {
      this.startSpinner("Querying database stats...");
      try {
        const stats = await this.handlers.onStatus();
        this.stopSpinner(true);
        if (stats && typeof stats === "object") {
          console.log(`\n${c.muted}Remote Backend:${c.reset}`);
          const entries: Array<[string, string]> = Object.entries(stats).map(([k, v]) => [
            k,
            typeof v === "object" ? JSON.stringify(v) : String(v),
          ]);
          this.printKeyValueList(entries);
        }
      } catch (err) {
        this.stopSpinner(false);
        this.printError("Could not retrieve remote status", err);
      }
    }
    console.log("");
  }

  private async executeClear(namespaceTarget?: string): Promise<void> {
    const targetNs = namespaceTarget ?? this.state.namespace;
    if (!this.handlers.onClear) {
      this.printWarn("No 'onClear' handler registered.");
      return;
    }

    if (!this.rl) return;

    const answer = await this.rl.question(
      `\n${c.rose}Wipe all vectors in "${targetNs}"? (yes/no): ${c.reset}`,
    );

    if (answer.trim().toLowerCase() !== "yes") {
      this.printInfo("Clear cancelled.");
      return;
    }

    this.startSpinner(`Wiping namespace "${targetNs}"...`);
    try {
      const msg = await this.handlers.onClear(targetNs);
      this.stopSpinner(true, `Cleared "${targetNs}"`);
      if (msg) console.log(`  ${c.muted}${msg}${c.reset}`);
    } catch (err) {
      this.stopSpinner(false);
      this.printError(`Failed to clear namespace "${targetNs}"`, err);
    }
  }

  private executeSet(args: string[]): void {
    const key = args[0]?.toLowerCase();
    const val = args[1];

    if (!key || !val) {
      this.printWarn("Usage: /set <topk|ns> <value>");
      return;
    }

    if (key === "topk" || key === "k") {
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed <= 0) {
        this.printWarn("topK must be a positive integer.");
        return;
      }
      this.state.topK = parsed;
      this.printSuccess(`topK set to ${this.state.topK}`);
    } else if (key === "namespace" || key === "ns") {
      this.state.namespace = val;
      this.printSuccess(`Namespace set to "${this.state.namespace}"`);
    } else {
      this.printWarn(`Unknown setting: "${key}". Available: topk, ns`);
    }
  }

  // ─── SPINNER ──────────────────────────────────────────────────────────────

  public startSpinner(message: string): void {
    this.stopSpinner();
    output.write("\x1b[?25l");

    this.spinnerTimer = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerFrameIndex] ?? "⠋";
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % this.spinnerFrames.length;
      output.write(`\r${c.cyan}${frame}${c.reset} ${c.muted}${message}${c.reset} `);
    }, 80);
  }

  public stopSpinner(success = true, finalMessage?: string): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      output.write("\r\x1b[2K");
      output.write("\x1b[?25h");

      if (finalMessage) {
        const symbol = success ? `${c.emerald}✔${c.reset}` : `${c.rose}✖${c.reset}`;
        console.log(`${symbol} ${c.muted}${finalMessage}${c.reset}`);
      }
    }
  }

  // ─── CLEAN & MINIMAL TUI RENDERING ────────────────────────────────────────

  /**
   * Minimal header banner
   */
  public printBanner(): void {
    console.log(`\n${c.bold}${this.config.appName}${c.reset} ${c.muted}v${this.config.version}${c.reset}`);
    console.log(`${c.muted}${this.config.bannerSubtitle}${c.reset}`);
    console.log(`${c.muted}───────────────────────────────────────────${c.reset}`);
    console.log(`${c.muted}Type ${c.text}/help${c.muted} for commands, or type any prompt to ask.${c.reset}\n`);
  }

  /**
   * Minimal clean command reference
   */
  public printHelp(): void {
    console.log(`\n${c.bold}Commands${c.reset}`);
    const commands: Array<[string, string]> = [
      ["<question>", "Ask question directly to query the RAG pipeline"],
      ["/ask <query>", "Explicitly query context & generate answer"],
      ["/search <terms>", "Perform raw vector similarity search"],
      ["/ingest <file>", "Parse & chunk a PDF into vector/doc stores"],
      ["/set topk <n>", `Set retrieved chunk count (now: ${this.state.topK})`],
      ["/set ns <name>", `Set active namespace (now: ${this.state.namespace})`],
      ["/status", "Display current configuration and database status"],
      ["/clear [ns]", "Wipe all records in specified namespace"],
      ["/cls", "Clear terminal screen"],
      ["/help", "Show this help screen"],
      ["/exit", "Exit session"],
    ];

    for (const [cmd, desc] of commands) {
      console.log(`  ${c.cyan}${cmd.padEnd(20)}${c.reset} ${c.muted}${desc}${c.reset}`);
    }
    console.log("");
  }

  /**
   * Clean source citation list
   */
  public printSources(sources: ICLISourceMatch[]): void {
    if (sources.length === 0) {
      console.log(`\n${c.muted}No sources found.${c.reset}\n`);
      return;
    }

    console.log(`\n${c.bold}Sources${c.reset} ${c.muted}(${sources.length})${c.reset}`);
    sources.forEach((s, idx) => {
      const pct = (s.score * 100).toFixed(1);
      const scoreBadge = s.score >= 0.85
        ? `${c.emerald}${pct}%${c.reset}`
        : `${c.amber}${pct}%${c.reset}`;

      const rawBreadcrumb = s.breadcrumb || s.metadata?.breadcrumb || "Document";
      // Format breadcrumb cleanly: [Book > Ch > Sec] -> Book › Ch › Sec
      const cleanBreadcrumb = rawBreadcrumb
        .replace(/^\[|\]$/g, "")
        .replace(/\s*>\s*/g, ` ${c.muted}›${c.reset} `);

      const snippet = s.text || s.metadata?.text || "";
      const cleanSnippet = snippet.length > 200
        ? snippet.slice(0, 200).replace(/\s+/g, " ").trim() + "..."
        : snippet.replace(/\s+/g, " ").trim();

      console.log(`  ${c.cyan}${idx + 1}.${c.reset} ${c.text}${cleanBreadcrumb}${c.reset}  ${c.muted}(${scoreBadge}${c.muted})${c.reset}`);
      console.log(`     ${c.muted}id:${s.id}${c.reset}`);
      if (cleanSnippet) {
        console.log(`     ${c.dim}${cleanSnippet}${c.reset}`);
      }
    });
    console.log("");
  }

  /**
   * Parses markdown and converts it to ANSI-styled terminal output.
   */
  public formatMarkdown(raw: string): string[] {
    const lines = raw.split("\n");
    const formatted: string[] = [];
    let inCodeBlock = false;
    let codeLanguage = "";

    const formatInline = (text: string): string => {
      return text
        // Bold: **text** or __text__
        .replace(/\*\*(.+?)\*\*/g, `${c.bold}$1${c.reset}`)
        .replace(/__(.+?)__/g, `${c.bold}$1${c.reset}`)
        // Italic: *text* or _text_
        .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, `${c.italic}$1${c.reset}`)
        .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, `${c.italic}$1${c.reset}`)
        // Inline code: `code`
        .replace(/`([^`\n]+)`/g, `${c.cyanBright}$1${c.reset}`)
        // Links: [title](url)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${c.underline}$1${c.reset} ${c.muted}($2)${c.reset}`);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Code block fences: ```lang
      const codeFenceMatch = line.match(/^```(\w+)?/);
      if (codeFenceMatch) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLanguage = codeFenceMatch[1] || "";
          const header = codeLanguage ? ` [${codeLanguage}]` : "";
          formatted.push(`${c.muted}  ┌─${c.cyan}${header}${c.muted} ────────────────────────${c.reset}`);
        } else {
          inCodeBlock = false;
          formatted.push(`${c.muted}  └────────────────────────────────${c.reset}`);
        }
        continue;
      }

      if (inCodeBlock) {
        formatted.push(`${c.cyanBright}  │  ${line}${c.reset}`);
        continue;
      }

      // Headings
      if (line.startsWith("# ")) {
        formatted.push(`${c.bold}${c.cyanBright}${line.slice(2).trim()}${c.reset}`);
        continue;
      }
      if (line.startsWith("## ")) {
        formatted.push(`${c.bold}${c.cyan}${line.slice(3).trim()}${c.reset}`);
        continue;
      }
      if (line.startsWith("### ")) {
        formatted.push(`${c.bold}${c.text}${line.slice(4).trim()}${c.reset}`);
        continue;
      }

      // Horizontal rules
      if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
        formatted.push(`${c.muted}${"─".repeat(40)}${c.reset}`);
        continue;
      }

      // Blockquotes
      if (line.startsWith("> ") || line === ">") {
        const quoteText = line.startsWith("> ") ? line.slice(2) : "";
        formatted.push(`${c.muted}▎ ${c.italic}${formatInline(quoteText)}${c.reset}`);
        continue;
      }

      // Table separator row |---|---|
      if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(line.trim())) {
        const colCount = line.split("|").filter((s) => s.trim().length > 0).length;
        formatted.push(`${c.muted}  ${"─".repeat(Math.max(20, colCount * 16))}${c.reset}`);
        continue;
      }

      // Table row | col1 | col2 |
      if (/^\|(.+)\|$/.test(line.trim())) {
        const cells = line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
        const formattedRow = cells
          .map((cell) => formatInline(cell).padEnd(16))
          .join(`${c.muted} │ ${c.reset}`);
        formatted.push(`  ${formattedRow}`);
        continue;
      }

      // Unordered lists (- item, * item, + item)
      const bulletMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
      if (bulletMatch) {
        const indent = bulletMatch[1] || "";
        const bulletIcon = indent.length > 0 ? "◦" : "•";
        const bulletColor = indent.length > 0 ? c.muted : c.cyan;
        formatted.push(`${indent}${bulletColor}${bulletIcon}${c.reset} ${formatInline(bulletMatch[3]!)}`);
        continue;
      }

      // Numbered lists (1. item)
      const numMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
      if (numMatch) {
        const indent = numMatch[1] || "";
        const num = numMatch[2];
        formatted.push(`${indent}${c.cyan}${num}.${c.reset} ${formatInline(numMatch[3]!)}`);
        continue;
      }

      // Standard text line with inline formatting
      formatted.push(formatInline(line));
    }

    return formatted;
  }

  /**
   * Clean minimal response card with thin rounded borders and markdown rendering
   */
  public printResponseBox(title: string, content: string): void {
    const width = Math.min(output.columns || 80, 80);
    const innerWidth = width - 4;
    const borderLine = "─".repeat(Math.max(10, innerWidth - title.length - 3));

    console.log(`\n${c.muted}╭─ ${c.bold}${c.text}${title}${c.reset} ${c.muted}${borderLine}╮${c.reset}`);
    const lines = this.formatMarkdown(content);
    for (const line of lines) {
      console.log(`${c.muted}│${c.reset}  ${line}`);
    }
    console.log(`${c.muted}╰${"─".repeat(width - 2)}╯${c.reset}\n`);
  }

  /**
   * Generic key-value card with rounded borders
   */
  public printCard(title: string, entries: Array<[string, string]>): void {
    const width = Math.min(output.columns || 80, 70);
    const borderLine = "─".repeat(Math.max(10, width - title.length - 6));

    console.log(`\n${c.muted}╭─ ${c.bold}${c.text}${title}${c.reset} ${c.muted}${borderLine}╮${c.reset}`);
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length), 10);

    for (const [key, val] of entries) {
      console.log(`${c.muted}│${c.reset}  ${c.muted}${key.padEnd(maxKeyLen)}${c.reset}  ${val}`);
    }
    console.log(`${c.muted}╰${"─".repeat(width - 2)}╯${c.reset}\n`);
  }

  /**
   * Generic box wrapper kept for backwards-compatibility
   */
  public printBox(title: string, lines: string[]): void {
    const entries: Array<[string, string]> = lines.map((line) => {
      const parts = line.split(/:\s+/);
      const k = parts[0] ?? "";
      const v = parts.slice(1).join(": ") || "";
      return [k, v] as [string, string];
    });
    this.printCard(title, entries);
  }

  private printKeyValueList(entries: Array<[string, string]>): void {
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length), 12);
    for (const [k, v] of entries) {
      console.log(`  ${c.muted}${k.padEnd(maxKeyLen)}${c.reset}  ${v}`);
    }
  }

  public printSuccess(msg: string): void {
    console.log(`${c.emerald}✔${c.reset} ${msg}`);
  }

  public printWarn(msg: string): void {
    console.log(`${c.amber}!${c.reset} ${c.muted}${msg}${c.reset}`);
  }

  public printError(msg: string, error?: any): void {
    console.log(`${c.rose}✖${c.reset} ${msg}`);
    if (error) {
      const errMsg = error?.message || String(error);
      console.log(`  ${c.muted}${errMsg}${c.reset}`);
    }
  }

  public printInfo(msg: string): void {
    console.log(`${c.cyan}ℹ${c.reset} ${c.muted}${msg}${c.reset}`);
  }

  private prompt(): void {
    if (this.rl && this.isRunning) {
      this.rl.prompt();
    }
  }
}
