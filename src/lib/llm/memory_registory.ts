import type {
  ChatCompletionContentPart,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources";
import { build_system_prompt } from "./embedding.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

export async function toBase64(imagesPaths?: string[]): Promise<string[]> {
  const base64Strings: string[] = [];
  if (!imagesPaths || !Array.isArray(imagesPaths)) return base64Strings;
  for (let imagePath of imagesPaths) {
    if (!imagePath || !existsSync(imagePath)) continue;
    try {
      const ext = path.extname(imagePath).toLowerCase().replace(".", "");
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const imageBase64 = readFileSync(imagePath, { encoding: "base64" });
      base64Strings.push(`data:${mime};base64,${imageBase64}`);
    } catch {}

  }
  return base64Strings;
}

export class MemoryRegistory {
  private memory_history: ChatCompletionMessageParam[];
  //   private db_client: Mong;

  constructor() {
    this.memory_history = [];
    let system_prompt = build_system_prompt();
    const system_message: ChatCompletionMessageParam = {
      role: "system",
      content: system_prompt,
    };
    this.memory_history.push(system_message);
  }

  async get_message(limit: number = -1, offset: number = -1) {
    if (limit === -1 && offset === -1) {
      return this.memory_history;
    }
    const startOffset = offset === -1 ? 0 : offset;
    const endLimit =
      limit === -1 ? this.memory_history.length : startOffset + limit;
    return this.memory_history.slice(startOffset, endLimit);
  }

  async user(user_query: string, imagesPath?: string[]) {
    try {
      const images = await toBase64(imagesPath);
      const imagesMap: ChatCompletionContentPart[] = images.map((img) => {
        return {
          type: "image_url",
          image_url: {
            url: img,
          },
        };
      });
      let user_message: ChatCompletionMessageParam = {
        role: "user",
        content: [{ type: "text", text: user_query }, ...imagesMap],
      };

      this.memory_history.push(user_message);
    } catch (error) {
      console.log("[Memory Registory Error]", error);
      throw error;
    }
  }

  async assistent(
    assistent_response: string,
    tool_calls?: ChatCompletionMessageToolCall[],
  ) {
    try {
      let assistent_message: ChatCompletionMessageParam = {
        role: "assistant",
        content: assistent_response,
        tool_calls,
      };

      this.memory_history.push(assistent_message);
    } catch (error) {
      console.log("[Memory Registory Error for Assistent message]", error);
      throw error;
    }
  }
}
