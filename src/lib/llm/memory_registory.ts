import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources";
import { build_system_prompt } from "./embedding.js";

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

  async user(user_query: string) {
    try {
      let user_message: ChatCompletionMessageParam = {
        role: "user",
        content: user_query,
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
