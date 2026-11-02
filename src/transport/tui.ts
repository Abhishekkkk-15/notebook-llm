import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import terminalImage from "terminal-image";
import { RAGPipeline } from "../service/rag_pipeline.js";
import type { IProjectDoc } from "../lib/db/project.model.js";
import { pickPdfFile } from "./file_picker.js";
import {
  printAnswerCard,
  renderMarkdown,
  renderChunkWithImages,
  renderMermaidDiagram,
  openImageInSystemViewer,
  c,
} from "./markdown.js";

export class InteractiveTUI {
  private activeProject: IProjectDoc | null = null;
  private isRunning = true;

  constructor(private ragPipeline: RAGPipeline) {}

  public async start(): Promise<void> {
    console.clear();

    // Fetch existing projects
    const projects = await this.ragPipeline.listProjects();
    if (projects.length > 0) {
      this.activeProject = projects[0]!;
    } else {
      console.clear();
      p.intro("\x1b[36m◆ Notebook-LLM: Project-Based Multimodal RAG CLI\x1b[0m");
      p.log.warn(
        "No projects found in database. Let's create your first project from a PDF file.",
      );
      await this.handleCreateProject();
    }

    while (this.isRunning) {
      this.renderHeader();
      await this.showMainMenu();
    }

    console.clear();
    p.outro("\x1b[36mSession ended. Have a great day!\x1b[0m");
  }

  /**
   * Cleans the screen and renders a minimal, modern header with active project info.
   */
  private renderHeader(): void {
    console.clear();
    const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);
    const projName = this.activeProject ? this.activeProject.name : "None (Select a project)";
    const projStats = this.activeProject
      ? `\x1b[90m(${this.activeProject.fileName} • ${this.activeProject.totalPages} pgs • ${this.activeProject.totalChildren} chunks • ${this.activeProject.totalImages} imgs)\x1b[0m`
      : "";

    console.log(`\x1b[36m╭─ \x1b[1m\x1b[37mNotebook-LLM\x1b[0m \x1b[90m• Interactive Multimodal RAG CLI\x1b[0m`);
    console.log(`\x1b[36m│\x1b[0m  \x1b[90mActive Project:\x1b[0m \x1b[33m\x1b[1m${projName}\x1b[0m ${projStats}`);
    console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);
  }

  /**
   * Utility to pause for user acknowledgement before clearing the screen.
   */
  private async pressEnterToContinue(
    promptMsg = "Press Enter to return to main menu...",
  ): Promise<void> {
    await p.text({
      message: `\x1b[90m${promptMsg}\x1b[0m`,
      placeholder: "↵ Enter",
    });
  }

  private async showMainMenu(): Promise<void> {
    const action = await p.select({
      message: "What would you like to do?",
      options: [
        {
          value: "QUERY",
          label: "💬  Ask a Question (RAG Query)",
          hint: "Ask natural language questions scoped to active project",
        },
        {
          value: "SEARCH",
          label: "🔎  Semantic Vector Search",
          hint: "Search chunks by similarity score",
        },
        {
          value: "GALLERY",
          label: "📸  Book Image & Diagram Gallery",
          hint: "Browse extracted figures & flowcharts with 4K viewer",
        },
        {
          value: "READER",
          label: "📑  Table of Contents & Section Reader",
          hint: "Browse chapters and read full parent sections",
        },
        {
          value: "OPEN",
          label: "📂  Open Existing Project",
          hint: "Switch to another ingested PDF project",
        },
        {
          value: "CREATE",
          label: "➕  Create New Project from PDF",
          hint: "Interactive PDF file picker & ingestion",
        },
        {
          value: "OVERVIEW",
          label: "📊  Active Project Stats & Details",
          hint: "View pages, chunks, images & diagram counts",
        },
        {
          value: "DELETE",
          label: "🗑️   Delete a Project",
          hint: "Remove a single project from MongoDB and Pinecone",
        },
        {
          value: "RESET_ALL",
          label: "🔥  Delete ALL Data (MongoDB & Pinecone)",
          hint: "Completely wipe all projects, chunks, and Pinecone vectors",
        },
        {
          value: "EXIT",
          label: "🚪  Exit",
        },
      ],
    });

    if (p.isCancel(action) || action === "EXIT") {
      this.isRunning = false;
      return;
    }

    switch (action) {
      case "QUERY":
        await this.handleQueryFlow();
        break;
      case "SEARCH":
        await this.handleSearchFlow();
        break;
      case "GALLERY":
        await this.handleGalleryFlow();
        break;
      case "READER":
        await this.handleSectionReaderFlow();
        break;
      case "OPEN":
        await this.handleOpenProject();
        break;
      case "CREATE":
        await this.handleCreateProject();
        break;
      case "OVERVIEW":
        await this.handleProjectOverview();
        break;
      case "DELETE":
        await this.handleDeleteProject();
        break;
      case "RESET_ALL":
        await this.handleResetAllData();
        break;
    }
  }

  /**
   * Continuous Q&A conversation loop in the active project
   */
  private async handleQueryFlow(): Promise<void> {
    if (!this.activeProject) {
      p.log.warn("Please select or create a project first.");
      await this.handleOpenProject();
      if (!this.activeProject) return;
    }

    console.clear();
    const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);
    console.log(`\x1b[36m╭─ 💬 Q&A Mode: \x1b[1m\x1b[33m${this.activeProject.name}\x1b[0m`);
    console.log(`\x1b[36m│\x1b[0m  \x1b[90mType your question below. Press Enter on an empty line or type '/menu' to exit.\x1b[0m`);
    console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);

    while (true) {
      const question = await p.text({
        message: `\x1b[1m[${this.activeProject.name}]\x1b[0m Ask:`,
        placeholder: "e.g. What are the key topics or orchestration patterns?",
      });

      if (
        p.isCancel(question) ||
        !question ||
        !question.trim() ||
        question.trim() === "/menu" ||
        question.trim() === "/back" ||
        question.trim() === "/exit"
      ) {
        break;
      }

      const s = p.spinner();
      s.start("Retrieving relevant sections & generating answer...");
      const startTime = Date.now();

      try {
        const response = await this.ragPipeline.query({
          query: question.trim(),
          projectId: this.activeProject.projectId,
          topK: 5,
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        s.stop(`Synthesized answer in ${elapsed}s`);

        printAnswerCard("Synthesized Answer", response.answer || "No response generated.");

        if (response.sources && response.sources.length > 0) {
          console.log(`\x1b[90m📚 Retrieved Sources (${response.sources.length}):\x1b[0m`);
          response.sources.forEach((source, idx) => {
            console.log(
              `  \x1b[33m[${idx + 1}]\x1b[0m \x1b[1m${source.breadcrumb || source.id}\x1b[0m \x1b[90m(RRF Score: ${source.score.toFixed(4)})\x1b[0m`,
            );
            if (source.imageUrls && source.imageUrls.length > 0) {
              console.log(
                `      📸 \x1b[32mImages (${source.imageUrls.length}):\x1b[0m ${source.imageUrls.join(", ")}`,
              );
            }
          });
          console.log("\n" + "─".repeat(60) + "\n");

          await this.inspectSourceChunks(response.sources);
        }
      } catch (err: any) {
        s.stop("Query failed");
        p.log.error(`Query Error: ${err.message || String(err)}`);
      }
    }
  }

  /**
   * Raw semantic similarity search
   */
  private async handleSearchFlow(): Promise<void> {
    if (!this.activeProject) {
      p.log.warn("Please select or create a project first.");
      return;
    }

    console.clear();
    const query = await p.text({
      message: `\x1b[1m[${this.activeProject.name}]\x1b[0m Enter search query:`,
      placeholder: "e.g. attention mechanism or database schema",
    });

    if (p.isCancel(query) || !query || !query.trim()) {
      return;
    }

    const s = p.spinner();
    s.start("Running semantic search in Pinecone & MongoDB...");

    try {
      const results = await this.ragPipeline.hybrid_search({
        query: query.trim(),
        projectId: this.activeProject.projectId,
        topK: 5,
      });

      s.stop(`Found ${results.length} matches`);

      console.log(`\n\x1b[36mSearch Results for: "${query.trim()}"\x1b[0m\n`);
      results.forEach((doc, idx) => {
        const preview = renderMarkdown(doc.text.slice(0, 300));
        console.log(`\x1b[33m[${idx + 1}]\x1b[0m \x1b[1m${doc.metadata.breadcrumb}\x1b[0m`);
        console.log(`    ${preview.split("\n").join("\n    ")}`);
        if (doc.metadata.imageUrls && doc.metadata.imageUrls.length > 0) {
          console.log(`    📸 Images: ${doc.metadata.imageUrls.join(", ")}`);
        }
        console.log("");
      });

      if (results && results.length > 0) {
        await this.inspectSourceChunks(
          results.map((r) => ({
            id: r.chunkId,
            breadcrumb: r.metadata.breadcrumb,
            text: r.text,
            score: (r as any).rrfScore || 0,
            images: r.metadata.images || [],
            imageUrls: r.metadata.imageUrls || [],
          })),
        );
      } else {
        await this.pressEnterToContinue();
      }
    } catch (err: any) {
      s.stop("Search failed");
      p.log.error(`Search Error: ${err.message || String(err)}`);
      await this.pressEnterToContinue();
    }
  }

  /**
   * Lets user interactively choose and view individual retrieved source chunks
   * in complete detail, rendering full text, tables, and live terminal images.
   */
  private async inspectSourceChunks(
    sources: Array<{
      id: string;
      breadcrumb?: string;
      text?: string;
      score: number;
      images?: any[];
      imageUrls?: string[];
    }>,
  ): Promise<void> {
    if (!sources || sources.length === 0) return;

    while (true) {
      const options = [
        {
          value: "skip",
          label: "⬅️  Continue (Skip inspection)",
          hint: "Return",
        },
        ...sources.map((s, idx) => ({
          value: String(idx),
          label: `[${idx + 1}] ${s.breadcrumb || s.id}`,
          hint: `Score: ${s.score.toFixed(4)}${s.imageUrls && s.imageUrls.length > 0 ? ` • 📸 ${s.imageUrls.length} img` : ""}`,
        })),
      ];

      const selected = await p.select({
        message: "Inspect a retrieved section in detail?",
        options,
      });

      if (p.isCancel(selected) || selected === "skip") {
        break;
      }

      const chunk = sources[Number(selected)];
      if (!chunk) continue;

      const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);

      console.clear();
      console.log(`\x1b[36m╭─ \x1b[1m\x1b[33m${chunk.breadcrumb || chunk.id}\x1b[0m`);
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mChunk ID: ${chunk.id} • RRF Score: ${chunk.score.toFixed(4)}\x1b[0m`,
      );
      console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);

      // Render full parent chunk text, tables, and live terminal images!
      await renderChunkWithImages(
        chunk.text || "No content available for this section.",
      );

      console.log(`\x1b[90m${"─".repeat(termWidth)}\x1b[0m\n`);

      // If the chunk has images, offer to launch in native 4K viewer
      const chunkImages = chunk.imageUrls || [];
      if (chunkImages.length > 0) {
        const nextAction = await p.select({
          message: "Actions for this section:",
          options: [
            { value: "back", label: "⬅️  Return to chunk list", hint: "Back" },
            ...chunkImages.map((img, i) => ({
              value: `open_${i}`,
              label: `🖼️  Open Image ${i + 1} in System Viewer (Full 4K Clarity)`,
              hint: path.basename(img),
            })),
          ],
        });

        if (
          !p.isCancel(nextAction) &&
          typeof nextAction === "string" &&
          nextAction.startsWith("open_")
        ) {
          const imgIndex = Number(nextAction.replace("open_", ""));
          const targetImg = chunkImages[imgIndex];
          if (targetImg) {
            openImageInSystemViewer(targetImg);
            p.log.success(
              `Opened ${path.basename(targetImg)} in system image viewer!`,
            );
            await this.pressEnterToContinue();
          }
        }
      } else {
        await this.pressEnterToContinue("Press Enter to return to chunk list...");
      }
      console.clear();
    }
  }

  /**
   * Interactive Visual Gallery: Browse all diagrams, figures, and charts in the book
   */
  private async handleGalleryFlow(): Promise<void> {
    if (!this.activeProject) {
      p.log.warn("Please select or create a project first.");
      await this.handleOpenProject();
      if (!this.activeProject) return;
    }

    const s = p.spinner();
    s.start(`Loading visuals & diagrams from "${this.activeProject.name}"...`);

    let parents: any[] = [];
    try {
      parents = await this.ragPipeline.getProjectParents(
        this.activeProject.projectId,
      );
      s.stop(`Loaded ${parents.length} sections`);
    } catch (err: any) {
      s.stop("Failed to load project sections");
      p.log.error(err.message || String(err));
      await this.pressEnterToContinue();
      return;
    }

    interface IGalleryItem {
      id: string;
      type: "image" | "mermaid";
      title: string;
      caption?: string;
      breadcrumb: string;
      chapterNumber?: number;
      chapterTitle?: string;
      page?: number;
      imagePath?: string;
      mermaidCode?: string;
      parentText: string;
    }

    const galleryItems: IGalleryItem[] = [];
    const seenImagePaths = new Set<string>();

    for (const parent of parents) {
      // 1. Collect images from metadata.images
      if (Array.isArray(parent.metadata?.images)) {
        for (const img of parent.metadata.images) {
          const imgPath = img.relativePath || img.url;
          if (imgPath && !seenImagePaths.has(imgPath)) {
            seenImagePaths.add(imgPath);
            galleryItems.push({
              id: `img_${galleryItems.length + 1}`,
              type: "image",
              title: img.caption || img.fileName || "Figure",
              caption: img.caption,
              breadcrumb: parent.metadata?.breadcrumb || parent.chunkId,
              chapterNumber: parent.metadata?.chapterNumber,
              chapterTitle: parent.metadata?.chapterTitle,
              page: img.pageNum,
              imagePath: imgPath,
              parentText: parent.text,
            });
          }
        }
      }

      // 2. Collect any markdown image tags in parent text
      const mdImgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let imgMatch: RegExpExecArray | null;
      while ((imgMatch = mdImgRegex.exec(parent.text)) !== null) {
        const caption = imgMatch[1] || "Figure";
        const imgPath = imgMatch[2]!;
        if (!seenImagePaths.has(imgPath)) {
          seenImagePaths.add(imgPath);
          galleryItems.push({
            id: `img_${galleryItems.length + 1}`,
            type: "image",
            title: caption,
            caption,
            breadcrumb: parent.metadata?.breadcrumb || parent.chunkId,
            chapterNumber: parent.metadata?.chapterNumber,
            chapterTitle: parent.metadata?.chapterTitle,
            imagePath: imgPath,
            parentText: parent.text,
          });
        }
      }

      // 3. Collect Mermaid diagrams
      const mermaidRegex = /```(?:mermaid|flowchart|graph)\s*([\s\S]*?)```/gi;
      let mmMatch: RegExpExecArray | null;
      let diagIndex = 1;
      while ((mmMatch = mermaidRegex.exec(parent.text)) !== null) {
        const mermaidCode = mmMatch[1]!.trim();
        const firstNodeMatch = mermaidCode.match(/\["?(.*?)"?\]/);
        const diagTitle = firstNodeMatch
          ? `Flowchart: ${firstNodeMatch[1]?.slice(0, 45)}`
          : `Process Flowchart ${diagIndex++}`;

        galleryItems.push({
          id: `diag_${galleryItems.length + 1}`,
          type: "mermaid",
          title: diagTitle,
          breadcrumb: parent.metadata?.breadcrumb || parent.chunkId,
          chapterNumber: parent.metadata?.chapterNumber,
          chapterTitle: parent.metadata?.chapterTitle,
          mermaidCode,
          parentText: parent.text,
        });
      }
    }

    if (galleryItems.length === 0) {
      p.log.warn("No extracted images or diagrams found in this project.");
      await this.pressEnterToContinue();
      return;
    }

    let currentFilter: "ALL" | "IMAGE" | "MERMAID" = "ALL";

    while (true) {
      console.clear();
      const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);
      console.log(
        `\x1b[36m╭─ 📸 Book Visual & Diagram Gallery: \x1b[1m\x1b[33m${this.activeProject.name}\x1b[0m`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mBrowse extracted figures, screenshots, and Mermaid flowcharts.\x1b[0m`,
      );
      console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);

      const filtered = galleryItems.filter((item) => {
        if (currentFilter === "IMAGE") return item.type === "image";
        if (currentFilter === "MERMAID") return item.type === "mermaid";
        return true;
      });

      const imgCount = galleryItems.filter((g) => g.type === "image").length;
      const diagCount = galleryItems.filter((g) => g.type === "mermaid").length;

      const filterLabel =
        currentFilter === "ALL"
          ? `Showing All (${filtered.length})`
          : currentFilter === "IMAGE"
            ? `Showing Images & Figures (${filtered.length})`
            : `Showing Mermaid Diagrams (${filtered.length})`;

      const options = [
        {
          value: "exit",
          label: "⬅️  Return to Main Menu",
          hint: "Exit gallery",
        },
        {
          value: "FILTER",
          label: `🔍  Change Filter [${filterLabel}]`,
          hint: `Images: ${imgCount} • Diagrams: ${diagCount}`,
        },
        ...filtered.map((item, idx) => {
          const typeIcon = item.type === "image" ? "🖼️ " : "📊 ";
          const locHint = item.page
            ? `Page ${item.page}${item.chapterNumber ? ` • Ch ${item.chapterNumber}` : ""}`
            : item.chapterNumber
              ? `Chapter ${item.chapterNumber}`
              : item.breadcrumb.split(">").pop()?.trim() || "";
          return {
            value: String(idx),
            label: `${typeIcon}[${idx + 1}] ${item.title.length > 55 ? item.title.slice(0, 52) + "..." : item.title}`,
            hint: locHint,
          };
        }),
      ];

      const selected = await p.select({
        message: "Select an image or diagram to view:",
        options,
      });

      if (p.isCancel(selected) || selected === "exit") {
        break;
      }

      if (selected === "FILTER") {
        const nextFilter = await p.select({
          message: "Select view filter:",
          options: [
            {
              value: "ALL",
              label: `🌟  All Visuals (${galleryItems.length})`,
            },
            {
              value: "IMAGE",
              label: `🖼️   Extracted Figures & Screenshots (${imgCount})`,
            },
            {
              value: "MERMAID",
              label: `📊  Mermaid Flowcharts & Diagrams (${diagCount})`,
            },
          ],
        });
        if (!p.isCancel(nextFilter)) {
          currentFilter = nextFilter as any;
        }
        continue;
      }

      const item = filtered[Number(selected)];
      if (!item) continue;

      // Item viewing loop
      while (true) {
        console.clear();
        console.log(`\x1b[36m╭─ \x1b[1m\x1b[33m${item.title}\x1b[0m`);
        console.log(
          `\x1b[36m│\x1b[0m  \x1b[90mSection: ${item.breadcrumb}${item.page ? ` • Page: ${item.page}` : ""}\x1b[0m`,
        );
        console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);

        if (item.type === "image" && item.imagePath) {
          const resolvedPath = path.isAbsolute(item.imagePath)
            ? item.imagePath
            : path.resolve(process.cwd(), item.imagePath);

          if (fs.existsSync(resolvedPath)) {
            try {
              const imgWidth = Math.min(termWidth - 8, 120);
              const renderedImg = await terminalImage.file(resolvedPath, {
                width: imgWidth,
                preferNativeRender: false,
              });
              if (renderedImg) {
                console.log(renderedImg);
              }
            } catch (err: any) {
              p.log.warn(`Image preview error: ${err.message}`);
            }
          } else {
            p.log.warn(`Image file not found on disk: ${resolvedPath}`);
          }
        } else if (item.type === "mermaid" && item.mermaidCode) {
          console.log(renderMermaidDiagram(item.mermaidCode));
        }

        console.log(`\x1b[90m${"─".repeat(termWidth)}\x1b[0m\n`);

        const actionOptions = [
          { value: "back", label: "⬅️  Return to Gallery List", hint: "Back" },
        ];

        if (item.type === "image" && item.imagePath) {
          actionOptions.push({
            value: "open_system",
            label: "🖼️  Open in OS 4K Viewer (Full Clarity)",
            hint: path.basename(item.imagePath),
          });
        }

        actionOptions.push({
          value: "view_section",
          label: "📖 View Complete Containing Section Text",
          hint: item.breadcrumb,
        });

        const action = await p.select({
          message: "Actions:",
          options: actionOptions,
        });

        if (p.isCancel(action) || action === "back") {
          break;
        }

        if (action === "open_system" && item.imagePath) {
          openImageInSystemViewer(item.imagePath);
          p.log.success(
            `Opened ${path.basename(item.imagePath)} in system image viewer!`,
          );
          await this.pressEnterToContinue("Press Enter to continue...");
        } else if (action === "view_section") {
          console.clear();
          console.log(
            `\x1b[36m╭─ 📖 Containing Section: \x1b[1m\x1b[33m${item.breadcrumb}\x1b[0m`,
          );
          console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);
          await renderChunkWithImages(item.parentText);
          console.log(`\x1b[90m${"─".repeat(termWidth)}\x1b[0m\n`);
          await this.pressEnterToContinue("Press Enter to return to visual...");
        }
      }
    }
  }

  /**
   * Interactive Table of Contents & Section Reader:
   * Browse the book's sections & chapters and read full parent chunks with tables and figures.
   */
  private async handleSectionReaderFlow(): Promise<void> {
    if (!this.activeProject) {
      p.log.warn("Please select or create a project first.");
      await this.handleOpenProject();
      if (!this.activeProject) return;
    }

    const s = p.spinner();
    s.start(`Loading Table of Contents for "${this.activeProject.name}"...`);

    let parents: any[] = [];
    try {
      parents = await this.ragPipeline.getProjectParents(
        this.activeProject.projectId,
      );
      s.stop(`Loaded ${parents.length} sections`);
    } catch (err: any) {
      s.stop("Failed to load project sections");
      p.log.error(err.message || String(err));
      await this.pressEnterToContinue();
      return;
    }

    if (parents.length === 0) {
      p.log.warn("No sections found in this project.");
      await this.pressEnterToContinue();
      return;
    }

    let currentIndex = 0;

    while (true) {
      console.clear();
      const termWidth = Math.max(40, (process.stdout.columns || 80) - 2);
      console.log(
        `\x1b[36m╭─ 📑 Table of Contents: \x1b[1m\x1b[33m${this.activeProject.name}\x1b[0m`,
      );
      console.log(
        `\x1b[36m│\x1b[0m  \x1b[90mSelect a chapter or section to read in full.\x1b[0m`,
      );
      console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);

      const options = [
        {
          value: "exit",
          label: "⬅️  Return to Main Menu",
          hint: "Exit reader",
        },
        ...parents.map((parent, idx) => {
          const chNum = parent.metadata?.chapterNumber;
          const chPrefix = chNum ? `[Ch ${chNum}] ` : "";
          const title =
            parent.metadata?.subtopicTitle ||
            parent.metadata?.chapterTitle ||
            parent.metadata?.breadcrumb ||
            parent.chunkId;
          const imgCount =
            parent.metadata?.imageUrls?.length ||
            parent.metadata?.images?.length ||
            0;
          const hasDiag =
            parent.metadata?.hasDiagrams || parent.text.includes("```mermaid");
          const badges = [
            `${parent.tokenCount} tokens`,
            imgCount > 0 ? `📸 ${imgCount} img` : null,
            hasDiag ? `📊 diag` : null,
          ]
            .filter(Boolean)
            .join(" • ");

          return {
            value: String(idx),
            label: `${chPrefix}${title.length > 55 ? title.slice(0, 52) + "..." : title}`,
            hint: badges,
          };
        }),
      ];

      const selected = await p.select({
        message: "Choose a section to read:",
        options,
      });

      if (p.isCancel(selected) || selected === "exit") {
        break;
      }

      currentIndex = Number(selected);

      // Section reader loop (supports Next / Previous navigation!)
      while (true) {
        const currentParent = parents[currentIndex];
        if (!currentParent) break;

        console.clear();
        console.log(
          `\x1b[36m╭─ 📑 [${currentIndex + 1}/${parents.length}] \x1b[1m\x1b[33m${currentParent.metadata?.breadcrumb || currentParent.chunkId}\x1b[0m`,
        );
        console.log(
          `\x1b[36m│\x1b[0m  \x1b[90mChapter: ${currentParent.metadata?.chapterTitle || currentParent.metadata?.chapterNumber || "General"} • Length: ${currentParent.tokenCount} tokens\x1b[0m`,
        );
        console.log(`\x1b[36m╰${"─".repeat(termWidth)}\x1b[0m\n`);

        await renderChunkWithImages(currentParent.text);

        console.log(`\x1b[90m${"─".repeat(termWidth)}\x1b[0m\n`);

        const readerActions: Array<{
          value: string;
          label: string;
          hint?: string;
        }> = [];

        if (currentIndex + 1 < parents.length) {
          readerActions.push({
            value: "next",
            label: "➡️  Next Section",
            hint:
              parents[currentIndex + 1]?.metadata?.subtopicTitle || "Next",
          });
        }

        if (currentIndex > 0) {
          readerActions.push({
            value: "prev",
            label: "⬅️  Previous Section",
            hint:
              parents[currentIndex - 1]?.metadata?.subtopicTitle || "Previous",
          });
        }

        const chunkImages = currentParent.metadata?.imageUrls || [];
        chunkImages.forEach((img: string, i: number) => {
          readerActions.push({
            value: `open_img_${i}`,
            label: `🖼️  Open Image ${i + 1} in 4K Viewer`,
            hint: path.basename(img),
          });
        });

        readerActions.push({
          value: "toc",
          label: "📑 Back to Table of Contents",
          hint: "Pick another section",
        });

        readerActions.push({
          value: "menu",
          label: "🚪 Return to Main Menu",
          hint: "Exit reader",
        });

        const action = await p.select({
          message: "Reader Navigation:",
          options: readerActions,
        });

        if (p.isCancel(action) || action === "toc") {
          break;
        }

        if (action === "menu") {
          return;
        }

        if (action === "next") {
          currentIndex++;
          continue;
        }

        if (action === "prev") {
          currentIndex--;
          continue;
        }

        if (typeof action === "string" && action.startsWith("open_img_")) {
          const imgIndex = Number(action.replace("open_img_", ""));
          const targetImg = chunkImages[imgIndex];
          if (targetImg) {
            openImageInSystemViewer(targetImg);
            p.log.success(
              `Opened ${path.basename(targetImg)} in system image viewer!`,
            );
            await this.pressEnterToContinue();
          }
        }
      }
    }
  }

  /**
   * Open / switch to an existing project
   */
  private async handleOpenProject(): Promise<void> {
    console.clear();
    const s = p.spinner();
    s.start("Fetching projects from MongoDB...");
    const projects = await this.ragPipeline.listProjects();
    s.stop(`Found ${projects.length} project(s)`);

    if (projects.length === 0) {
      p.log.info("No existing projects found. Let's create one!");
      await this.handleCreateProject();
      return;
    }

    const choices: Array<{ value: string; label: string; hint?: string }> =
      projects.map((proj) => ({
        value: proj.projectId,
        label: `${proj.name}`,
        hint: `${proj.fileName} • ${proj.totalPages} pgs • ${proj.totalChildren} vectors • ${proj.totalImages} imgs`,
      }));

    choices.push({
      value: "CANCEL",
      label: "🔙 Back to Main Menu",
    });

    const chosenId = await p.select({
      message: "Choose a project to activate:",
      options: choices,
    });

    if (p.isCancel(chosenId) || chosenId === "CANCEL") {
      return;
    }

    const selected = projects.find((p) => p.projectId === chosenId);
    if (selected) {
      this.activeProject = selected;
    }
  }

  /**
   * Interactive creation of a new project using TUI file picker & ingestion
   */
  private async handleCreateProject(): Promise<void> {
    const pdfPath = await pickPdfFile();
    if (!pdfPath) {
      return;
    }

    console.clear();
    const defaultName = path.basename(pdfPath, path.extname(pdfPath));
    const cleanDefault = defaultName
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const projectName = await p.text({
      message: "Enter Project Name:",
      placeholder: cleanDefault,
      initialValue: cleanDefault,
      validate: (v) => (!v || !v.trim() ? "Project name cannot be empty" : undefined),
    });

    if (p.isCancel(projectName) || !projectName) {
      return;
    }

    const s = p.spinner();
    s.start("Initializing project ingestion...");

    try {
      const result = await this.ragPipeline.ingestDocument({
        filePath: pdfPath,
        projectName: projectName.trim(),
        onProgress: (status) => {
          s.message(status);
        },
      });

      s.stop("Ingestion complete!");
      this.activeProject = result.project;

      console.clear();
      p.note(
        `• Project ID:        ${result.projectId}\n• Book Title:        ${result.bookTitle}\n• Total Pages:       ${result.totalPages}\n• Total Sections:    ${result.sectionsCount}\n• MongoDB Parents:   ${result.parentCount}\n• Pinecone Vectors:  ${result.childCount}\n• Extracted Images:  ${result.totalImages}\n• Flowchart Diagrams: ${result.totalDiagrams}`,
        `Project Created: ${result.project.name}`,
      );

      await this.pressEnterToContinue("Press Enter to return to main menu with this project active...");
    } catch (err: any) {
      s.stop("Ingestion failed");
      p.log.error(`Failed to ingest project: ${err.message || String(err)}`);
      await this.pressEnterToContinue();
    }
  }

  /**
   * Detailed overview of active project
   */
  private async handleProjectOverview(): Promise<void> {
    if (!this.activeProject) {
      p.log.warn("No active project.");
      return;
    }

    console.clear();
    const proj = this.activeProject;
    const mb = (proj.fileSizeBytes / (1024 * 1024)).toFixed(2);

    p.note(
      `• Project Name:       ${proj.name}
• Project ID:         ${proj.projectId}
• PDF File:           ${proj.fileName} (${mb} MB)
• Full Path:          ${proj.filePath}
• Status:             ${proj.status}
• Total Pages:        ${proj.totalPages}
• Sections / Topics:  ${proj.totalSections}
• MongoDB Parents:    ${proj.totalParents} documents
• Pinecone Vectors:   ${proj.totalChildren} child vectors
• Extracted Images:   ${proj.totalImages} images (in assets/images/)
• Mermaid Diagrams:   ${proj.totalDiagrams} flowcharts
• Created At:         ${new Date(proj.createdAt).toLocaleString()}
• Last Updated:       ${new Date(proj.updatedAt).toLocaleString()}`,
      `Overview: ${proj.name}`,
    );

    await this.pressEnterToContinue();
  }

  /**
   * Delete a project with interactive confirmation
   */
  private async handleDeleteProject(): Promise<void> {
    console.clear();
    const projects = await this.ragPipeline.listProjects();
    if (projects.length === 0) {
      p.log.info("No projects available to delete.");
      await this.pressEnterToContinue();
      return;
    }

    const choices: Array<{ value: string; label: string; hint?: string }> =
      projects.map((proj) => ({
        value: proj.projectId,
        label: `${proj.name} (${proj.fileName})`,
        hint: `ID: ${proj.projectId}`,
      }));

    choices.push({
      value: "CANCEL",
      label: "🔙 Back",
    });

    const chosenId = await p.select({
      message: "Select a project to permanently delete:",
      options: choices,
    });

    if (p.isCancel(chosenId) || chosenId === "CANCEL") {
      return;
    }

    const confirm = await p.confirm({
      message: `Are you sure you want to delete project '${chosenId}'? This will delete all parent chunks in MongoDB and vector embeddings in Pinecone!`,
      initialValue: false,
    });

    if (p.isCancel(confirm) || !confirm) {
      return;
    }

    const s = p.spinner();
    s.start(`Deleting project ${chosenId}...`);

    try {
      await this.ragPipeline.deleteProject(chosenId);
      s.stop("Project deleted successfully");

      if (this.activeProject?.projectId === chosenId) {
        const remaining = await this.ragPipeline.listProjects();
        this.activeProject = remaining.length > 0 ? remaining[0]! : null;
      }
      await this.pressEnterToContinue("Press Enter to return to main menu...");
    } catch (err: any) {
      s.stop("Deletion failed");
      p.log.error(`Error deleting project: ${err.message || String(err)}`);
      await this.pressEnterToContinue();
    }
  }

  /**
   * Reset / delete ALL data from MongoDB and Pinecone
   */
  private async handleResetAllData(): Promise<void> {
    console.clear();
    p.log.warn("\x1b[31m\x1b[1m⚠️   DANGER ZONE: DELETE ALL DATA ⚠️\x1b[0m");
    console.log(
      "\x1b[90mThis will permanently wipe:\n" +
        "  • All projects from MongoDB\n" +
        "  • All parent sections from MongoDB\n" +
        "  • All vector embeddings from Pinecone\n" +
        "  • All locally extracted images\x1b[0m\n",
    );

    const confirm = await p.confirm({
      message:
        "Are you ABSOLUTELY sure you want to delete ALL data from DB and Pinecone?",
      initialValue: false,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.log.info("Reset cancelled. No data was deleted.");
      await this.pressEnterToContinue();
      return;
    }

    // Safety confirmation text
    const doubleConfirm = await p.text({
      message: "Type 'DELETE ALL' to confirm permanent wipe:",
      placeholder: "DELETE ALL",
      validate: (val) => {
        if (val !== "DELETE ALL") {
          return "You must type 'DELETE ALL' exactly (or Ctrl+C to cancel)";
        }
      },
    });

    if (p.isCancel(doubleConfirm) || doubleConfirm !== "DELETE ALL") {
      p.log.info("Reset cancelled.");
      await this.pressEnterToContinue();
      return;
    }

    const s = p.spinner();
    s.start("Wiping all data from MongoDB and Pinecone...");

    try {
      const result = await this.ragPipeline.resetAllData({
        deleteLocalImages: true,
        onProgress: (msg) => s.message(msg),
      });

      this.activeProject = null;
      s.stop("All databases wiped successfully");

      console.log(`\n\x1b[32m✔ Reset Summary:\x1b[0m`);
      console.log(`  • Deleted Projects:      ${result.deletedProjects}`);
      console.log(`  • Deleted Parent Chunks: ${result.deletedParents}`);
      console.log(
        `  • Pinecone Cleared:      ${result.pineconeCleared ? "Yes" : "Failed"}`,
      );
      if (result.imagesDeleted !== undefined) {
        console.log(`  • Image Dirs Cleaned:    ${result.imagesDeleted}`);
      }
      console.log();

      await this.pressEnterToContinue("Press Enter to return to main menu...");
    } catch (err: any) {
      s.stop("Reset operation failed");
      p.log.error(`Error deleting database data: ${err.message || String(err)}`);
      await this.pressEnterToContinue();
    }
  }
}
