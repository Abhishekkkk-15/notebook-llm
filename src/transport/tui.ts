import path from "path";
import * as p from "@clack/prompts";
import { RAGPipeline } from "../service/rag_pipeline.js";
import type { IProjectDoc } from "../lib/db/project.model.js";
import { pickPdfFile } from "./file_picker.js";
import { printAnswerCard, renderMarkdown, c } from "./markdown.js";

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
    const projName = this.activeProject ? this.activeProject.name : "None (Select a project)";
    const projStats = this.activeProject
      ? `[${this.activeProject.fileName} • ${this.activeProject.totalPages} pgs • ${this.activeProject.totalChildren} vectors • ${this.activeProject.totalImages} imgs]`
      : "";

    console.log(`\x1b[36m╭──────────────────────────────────────────────────────────────────────────╮\x1b[0m`);
    console.log(`\x1b[36m│\x1b[0m  \x1b[1m\x1b[37mNotebook-LLM\x1b[0m \x1b[90m| Interactive Multimodal RAG CLI\x1b[0m                            \x1b[36m│\x1b[0m`);
    console.log(`\x1b[36m│\x1b[0m  \x1b[90mActive Project:\x1b[0m \x1b[33m\x1b[1m${projName}\x1b[0m \x1b[90m${projStats}\x1b[0m`);
    console.log(`\x1b[36m╰──────────────────────────────────────────────────────────────────────────╯\x1b[0m\n`);
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
          hint: "Remove project from MongoDB and Pinecone",
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
    console.log(`\x1b[36m╭─ 💬 Q&A Mode: \x1b[1m\x1b[33m${this.activeProject.name}\x1b[0m \x1b[36m────────────────────────────╮\x1b[0m`);
    console.log(`\x1b[36m│\x1b[0m  \x1b[90mType your question below. Press Enter on an empty line or type '/menu' to exit.\x1b[0m \x1b[36m│\x1b[0m`);
    console.log(`\x1b[36m╰──────────────────────────────────────────────────────────────────────╯\x1b[0m\n`);

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

      await this.pressEnterToContinue();
    } catch (err: any) {
      s.stop("Search failed");
      p.log.error(`Search Error: ${err.message || String(err)}`);
      await this.pressEnterToContinue();
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
}
