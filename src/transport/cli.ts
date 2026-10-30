import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * ============================================================================
 * INTERACTIVE CLI / TUI FOR NOTEBOOK-LLM / GRAPH-RAG
 * ============================================================================
 *
 * This class provides a standalone, fully featured terminal user interface (CLI/TUI)
 * for interacting with the Notebook-LLM application.
 *
 * It is completely decoupled from your core business logic. You can connect it
 * by passing action handlers (query, search, ingest, status, clear) via its
 * constructor or `setHandlers()` method.
 *
 * ─── USAGE EXAMPLE ──────────────────────────────────────────────────────────
 * ```typescript
 * import { InteractiveCLI } from "./transport/cli.js";
 * import { PinconeStore } from "./lib/db/pc_store.js";
 * import { llm } from "./lib/llm/embedding.js";
 * import { readAndFormatPdf } from "./lib/pdfFormatter.js";
 * import { chunkFormattedBook } from "./lib/chunker.js";
 *
 * const pc = new PinconeStore();
 * const cli = new InteractiveCLI({
 *   appName: "Notebook-LLM Terminal",
 *   defaultNamespace: "child_chunks",
 *   defaultTopK: 5,
 * });
 *
 * // Hook up your application logic:
 * cli.setHandlers({
 *   onSearch: async (query, { topK, namespace }) => {
 *     const vec = await llm.generate_embedding(query, "NVIDIA", "query");
 *     return await pc.search(vec!, { topK, namespace });
 *   },
 *   onQuery: async (prompt, { topK, namespace }) => {
 *     const vec = await llm.generate_embedding(prompt, "NVIDIA", "query");
 *     const matches = await pc.search(vec!, { topK, namespace });
 *     // (Optional) Synthesize answer with LLM
 *     return {
 *       answer: "Synthesized answer...",
 *       sources: matches.map(m => ({
 *         id: m.id,
 *         score: m.score,
 *         breadcrumb: m.metadata?.breadcrumb,
 *         text: m.metadata?.text,
 *       })),
 *     };
 *   },
 * });
 *
 * await cli.start();
 * ```
 */

// ─── ANSI COLORS & FORMATTING UTILITIES ─────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  // Foreground Colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  // Bright Foreground
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  // Background Colors
  bgBlue: "\x1b[44m",
  bgCyan: "\x1b[46m",
  bgMagenta: "\x1b[45m",
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
  /**
   * Handles natural language Q&A queries.
   * If user types plain text or `/ask <question>`, this is invoked.
   */
  onQuery?: (
    query: string,
    options: { topK: number; namespace: string },
  ) => Promise<ICLIQueryResponse | string | void>;

  /**
   * Handles raw semantic vector searches (`/search <query>`).
   */
  onSearch?: (
    query: string,
    options: { topK: number; namespace: string },
  ) => Promise<ICLISourceMatch[]>;

  /**
   * Handles document ingestion (`/ingest <filePath> [optionalTitle]`).
   */
  onIngest?: (
    filePath: string,
    options: { title?: string; childChunkTokenSize?: number; childTokenOverlap?: number },
  ) => Promise<ICLIIngestResult | void>;

  /**
   * Handles `/status` command to display current index/database status.
   */
  onStatus?: () => Promise<Record<string, any> | void>;

  /**
   * Handles `/clear [namespace]` to wipe records.
   */
  onClear?: (namespace?: string) => Promise<string | void>;

  /**
   * Extension point for custom slash commands.
   */
  onCustomCommand?: (command: string, args: string[]) => Promise<string | void>;
}

/** Configuration options for the InteractiveCLI */
export interface ICLIConfig {
  appName?: string;
  version?: string;
  defaultNamespace?: string;
  defaultTopK?: number;
  promptSymbol?: string;
  bannerSubtitle?: string;
}

/**
 * Interactive CLI / Terminal User Interface Controller
 */
export class InteractiveCLI {
  private config: Required<ICLIConfig>;
  private handlers: ICLIHandlers = {};
  private rl: readline.Interface | null = null;
  private isRunning = false;
  private abortController: AbortController | null = null;

  // Runtime state adjustable via commands like `/set topK 10`
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
      appName: config?.appName ?? "Notebook-LLM RAG CLI",
      version: config?.version ?? "1.0.0",
      defaultNamespace: config?.defaultNamespace ?? "child_chunks",
      defaultTopK: config?.defaultTopK ?? 5,
      promptSymbol: config?.promptSymbol ?? "❯",
      bannerSubtitle: config?.bannerSubtitle ?? "Hierarchical Parent-Document & Graph-RAG Terminal",
    };

    this.state = {
      namespace: this.config.defaultNamespace,
      topK: this.config.defaultTopK,
    };

    if (handlers) {
      this.handlers = handlers;
    }
  }

  /**
   * Register or update operational handlers.
   */
  public setHandlers(handlers: Partial<ICLIHandlers>): this {
    this.handlers = { ...this.handlers, ...handlers };
    return this;
  }

  /**
   * Start the interactive terminal loop.
   */
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

    // Handle Ctrl+C gracefully
    this.rl.on("SIGINT", () => {
      this.printInfo("\nCaught interrupt signal (Ctrl+C). Type /exit to quit.");
      this.prompt();
    });

    // Handle stream closure / EOF gracefully
    this.rl.on("close", () => {
      if (this.isRunning) {
        this.stop();
      }
    });

    await this.replLoop();
  }

  /**
   * Stop the CLI and close the terminal interface.
   */
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
    console.log(`\n${c.dim}Session ended. Goodbye!${c.reset}\n`);
  }

  // ─── REPL LOOP ────────────────────────────────────────────────────────────

  private async replLoop(): Promise<void> {
    while (this.isRunning && this.rl) {
      try {
        const promptLabel = `${c.dim}[${c.cyan}${this.state.namespace}${c.dim}|k=${c.yellow}${this.state.topK}${c.dim}]${c.reset} ${c.brightCyan}${this.config.promptSymbol}${c.reset} `;
        const rawInput = await this.rl.question(promptLabel, {
          signal: this.abortController?.signal,
        });
        const line = rawInput.trim();

        if (!line) {
          continue;
        }

        await this.handleInput(line);
      } catch (err: any) {
        // If aborted or readline was closed
        if (!this.isRunning || err?.name === "AbortError") break;
        this.printError("Unexpected terminal loop error", err);
      }
    }
  }

  /**
   * Dispatches input to corresponding slash command or default query handler.
   */
  private async handleInput(inputStr: string): Promise<void> {
    // Check if input is a slash command
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
        case "q":
        case "query": {
          const queryText = args.join(" ").trim();
          if (!queryText) {
            this.printWarn("Usage: /ask <your question or query>");
            return;
          }
          await this.executeQuery(queryText);
          break;
        }

        case "search": {
          const searchText = args.join(" ").trim();
          if (!searchText) {
            this.printWarn("Usage: /search <semantic search terms>");
            return;
          }
          await this.executeSearch(searchText);
          break;
        }

        case "ingest": {
          const filePath = args[0];
          if (!filePath) {
            this.printWarn("Usage: /ingest <path-to-pdf> [optional-book-title]");
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
          // Try delegate custom command handler
          if (this.handlers.onCustomCommand) {
            this.startSpinner(`Executing custom command /${command}...`);
            try {
              const res = await this.handlers.onCustomCommand(command, args);
              this.stopSpinner(true);
              if (res) console.log(res);
            } catch (err) {
              this.stopSpinner(false);
              this.printError(`Command /${command} failed`, err);
            }
          } else {
            this.printWarn(`Unknown command: /${command}. Type ${c.bold}/help${c.reset} for available commands.`);
          }
          break;
      }
    } else {
      // Default: Bare text is treated as a natural language query / ask
      await this.executeQuery(inputStr);
    }
  }

  // ─── COMMAND ACTIONS ──────────────────────────────────────────────────────

  private async executeQuery(query: string): Promise<void> {
    if (!this.handlers.onQuery) {
      this.printWarn("No 'onQuery' handler registered. Connect your LLM/RAG pipeline using cli.setHandlers({ onQuery: ... }).");
      return;
    }

    this.startSpinner(`Retrieving context and generating response for: "${query}"...`);
    const startTime = Date.now();

    try {
      const response = await this.handlers.onQuery(query, {
        topK: this.state.topK,
        namespace: this.state.namespace,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      this.stopSpinner(true, `Answer completed in ${elapsed}s`);

      if (!response) {
        this.printInfo("Query completed with no text returned.");
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
      this.printWarn("No 'onSearch' handler registered. Connect your vector search using cli.setHandlers({ onSearch: ... }).");
      return;
    }

    this.startSpinner(`Searching vector index [${this.state.namespace}] (topK=${this.state.topK})...`);
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
      this.printWarn("No 'onIngest' handler registered. Connect your PDF pipeline using cli.setHandlers({ onIngest: ... }).");
      return;
    }

    this.startSpinner(`Ingesting document: ${filePath}...`);
    const startTime = Date.now();

    try {
      const res = await this.handlers.onIngest(filePath, { title });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      this.stopSpinner(true, `Ingestion complete in ${elapsed}s`);

      if (res) {
        this.printBox("Ingestion Summary", [
          `Title:         ${c.cyan}${res.bookTitle ?? title ?? "N/A"}${c.reset}`,
          `Total Pages:   ${c.yellow}${res.totalPages ?? "N/A"}${c.reset}`,
          `Sections:      ${c.magenta}${res.sectionsCount ?? "N/A"}${c.reset}`,
          `Parent Chunks: ${c.green}${res.parentCount}${c.reset}`,
          `Child Chunks:  ${c.brightCyan}${res.childCount}${c.reset}`,
          res.message ? `Note:          ${c.dim}${res.message}${c.reset}` : "",
        ].filter(Boolean));
      }
    } catch (err) {
      this.stopSpinner(false, "Ingestion failed");
      this.printError(`Failed to ingest "${filePath}"`, err);
    }
  }

  private async executeStatus(): Promise<void> {
    console.log(`\n${c.bold}${c.brightBlue}─── APPLICATION & RUNTIME STATUS ───${c.reset}`);
    console.log(`  ${c.dim}Active Namespace:${c.reset} ${c.cyan}${this.state.namespace}${c.reset}`);
    console.log(`  ${c.dim}Default Top-K:${c.reset}    ${c.yellow}${this.state.topK}${c.reset}`);
    console.log(`  ${c.dim}App Name:${c.reset}         ${this.config.appName} v${this.config.version}`);

    if (this.handlers.onStatus) {
      this.startSpinner("Fetching database & backend status...");
      try {
        const stats = await this.handlers.onStatus();
        this.stopSpinner(true);
        if (stats && typeof stats === "object") {
          console.log(`\n${c.bold}Remote Index Stats:${c.reset}`);
          for (const [key, val] of Object.entries(stats)) {
            console.log(`  ${c.dim}${key}:${c.reset} ${typeof val === "object" ? JSON.stringify(val) : val}`);
          }
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
      this.printWarn("No 'onClear' handler registered. Connect via cli.setHandlers({ onClear: ... }).");
      return;
    }

    if (!this.rl) return;

    // Safety confirmation prompt
    const answer = await this.rl.question(
      `${c.brightRed}⚠ CAUTION: Are you sure you want to wipe all records in namespace "${targetNs}"? (yes/no): ${c.reset}`,
    );

    if (answer.trim().toLowerCase() !== "yes") {
      this.printInfo("Clear operation cancelled.");
      return;
    }

    this.startSpinner(`Wiping namespace "${targetNs}"...`);
    try {
      const msg = await this.handlers.onClear(targetNs);
      this.stopSpinner(true, `Namespace "${targetNs}" cleared.`);
      if (msg) console.log(msg);
    } catch (err) {
      this.stopSpinner(false);
      this.printError(`Failed to clear namespace "${targetNs}"`, err);
    }
  }

  private executeSet(args: string[]): void {
    const key = args[0]?.toLowerCase();
    const val = args[1];

    if (!key || !val) {
      this.printWarn("Usage: /set <namespace|topk> <value>");
      return;
    }

    if (key === "topk" || key === "k") {
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed <= 0) {
        this.printWarn("topK must be a positive integer.");
        return;
      }
      this.state.topK = parsed;
      this.printSuccess(`topK updated to ${this.state.topK}`);
    } else if (key === "namespace" || key === "ns") {
      this.state.namespace = val;
      this.printSuccess(`Active namespace updated to "${this.state.namespace}"`);
    } else {
      this.printWarn(`Unknown setting: "${key}". Available settings: topK, namespace.`);
    }
  }

  // ─── SPINNER / LOADING UTILITY ─────────────────────────────────────────────

  public startSpinner(message: string): void {
    this.stopSpinner();
    output.write("\x1b[?25l"); // Hide cursor

    this.spinnerTimer = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerFrameIndex] ?? "⠋";
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % this.spinnerFrames.length;
      output.write(`\r${c.cyan}${frame}${c.reset} ${message} `);
    }, 80);
  }

  public stopSpinner(success = true, finalMessage?: string): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      output.write("\r\x1b[2K"); // Clear current line
      output.write("\x1b[?25h"); // Restore cursor

      if (finalMessage) {
        const symbol = success ? `${c.brightGreen}✔${c.reset}` : `${c.brightRed}✖${c.reset}`;
        console.log(`${symbol} ${finalMessage}`);
      }
    }
  }

  // ─── FORMATTING & RENDERING HELPERS ───────────────────────────────────────

  public printBanner(): void {
    const title = `   ⚡ ${this.config.appName} v${this.config.version} ⚡   `;
    const line = "═".repeat(title.length);

    console.log(`\n${c.brightCyan}╔${line}╗`);
    console.log(`║${c.bold}${c.white}${title}${c.reset}${c.brightCyan}║`);
    console.log(`╚${line}╝${c.reset}`);
    console.log(`${c.dim}   ${this.config.bannerSubtitle}${c.reset}`);
    console.log(`${c.dim}   Type ${c.bold}/help${c.reset}${c.dim} for commands, or type any prompt to ask a question.${c.reset}\n`);
  }

  public printHelp(): void {
    console.log(`\n${c.bold}${c.brightYellow}AVAILABLE COMMANDS:${c.reset}`);
    const commands: Array<[string, string]> = [
      ["<question>", "Type natural language question directly to query the RAG pipeline"],
      ["/ask <question>", "Explicitly ask a question to retrieve context & generate answer"],
      ["/search <terms>", "Perform raw vector similarity search without LLM generation"],
      ["/ingest <file> [title]", "Ingest, outline-parse, and chunk a PDF document into Pinecone"],
      ["/set topk <num>", "Change the number of chunks retrieved (current: " + this.state.topK + ")"],
      ["/set ns <name>", "Change the active vector namespace (current: " + this.state.namespace + ")"],
      ["/status", "Display current configuration and database status"],
      ["/clear [namespace]", "Wipe all records in the specified or current namespace"],
      ["/cls, /clear", "Clear the terminal screen"],
      ["/help, /?", "Show this help screen"],
      ["/exit, /quit", "Exit the interactive CLI session"],
    ];

    for (const [cmd, desc] of commands) {
      console.log(`  ${c.cyan}${cmd.padEnd(25)}${c.reset} ${c.dim}${desc}${c.reset}`);
    }
    console.log("");
  }

  public printSources(sources: ICLISourceMatch[]): void {
    if (sources.length === 0) {
      console.log(`\n${c.dim}No matching chunks found.${c.reset}\n`);
      return;
    }

    console.log(`\n${c.bold}${c.magenta}📚 RETRIEVED SOURCES (${sources.length}):${c.reset}`);
    sources.forEach((s, idx) => {
      const scoreStr = `(Score: ${(s.score * 100).toFixed(1)}%)`;
      const breadcrumb = s.breadcrumb || s.metadata?.breadcrumb || "No breadcrumb";
      const snippet = s.text || s.metadata?.text || "";
      const truncated = snippet.length > 250 ? snippet.slice(0, 250).replace(/\n/g, " ") + "..." : snippet.replace(/\n/g, " ");

      console.log(`  ${c.brightYellow}[${idx + 1}]${c.reset} ${c.bold}${breadcrumb}${c.reset} ${c.dim}${scoreStr}${c.reset}`);
      console.log(`      ${c.dim}ID:${c.reset} ${c.gray}${s.id}${c.reset}`);
      if (truncated) {
        console.log(`      ${c.dim}"${truncated}"${c.reset}`);
      }
    });
    console.log("");
  }

  public printResponseBox(title: string, content: string): void {
    const width = Math.min(output.columns || 80, 80);
    const border = "─".repeat(width - 4);

    console.log(`\n${c.cyan}┌─ ${c.bold}${title}${c.reset}${c.cyan} ${border.slice(title.length + 1)}┐${c.reset}`);
    const lines = content.split("\n");
    for (const l of lines) {
      console.log(`${c.cyan}│${c.reset} ${l}`);
    }
    console.log(`${c.cyan}└${border}─┘${c.reset}\n`);
  }

  public printBox(title: string, lines: string[]): void {
    console.log(`\n${c.brightCyan}┌─ ${c.bold}${title}${c.reset}${c.brightCyan} ─────────────────────────────┐${c.reset}`);
    for (const line of lines) {
      console.log(`${c.brightCyan}│${c.reset}  ${line}`);
    }
    console.log(`${c.brightCyan}└────────────────────────────────────────────────┘${c.reset}\n`);
  }

  public printSuccess(msg: string): void {
    console.log(`${c.brightGreen}✔${c.reset} ${msg}`);
  }

  public printWarn(msg: string): void {
    console.log(`${c.brightYellow}⚠${c.reset} ${msg}`);
  }

  public printError(msg: string, error?: any): void {
    console.log(`${c.brightRed}✖ ${msg}${c.reset}`);
    if (error) {
      const errMsg = error?.message || String(error);
      console.log(`  ${c.dim}${errMsg}${c.reset}`);
    }
  }

  public printInfo(msg: string): void {
    console.log(`${c.brightBlue}ℹ${c.reset} ${msg}`);
  }

  private prompt(): void {
    if (this.rl && this.isRunning) {
      this.rl.prompt();
    }
  }
}
