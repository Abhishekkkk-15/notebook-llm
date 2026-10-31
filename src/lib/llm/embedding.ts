import OpenAI from "openai";
import { AzureOpenAI } from "openai/azure.js";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionUserMessageParam,
  Embedding,
} from "openai/resources";

import { config } from "dotenv";

import { RateLimitRetry } from "../retry.js";
import type { IParentChunkDoc } from "../db/parent_chunk.model.js";
import type { IParentChunk } from "../../types/chunktypes.js";
import { MemoryRegistory } from "./memory_registory.js";

type TProvider = "AZURE" | "NVIDIA";
const MODELS = {
  inv_embedding: "nvidia/nemotron-3.5-embed-1b",
} as const;

config();

export function flat_chunks(chunks: IParentChunkDoc[]) {
  const sections = chunks?.map((c) => {
    return `### Source: ${c.metadata.breadcrumb}\n${c.text}`;
  });
  return sections;
}

export function build_system_prompt(content?: IParentChunkDoc[]): string {
  const sections = content?.map((c) => {
    return `### Source: ${c.metadata.breadcrumb}\n${c.text}`;
  });

  return `You are a helpful assistant for the learning platform Notebook-LLM.
Your task is to answer the user's questions accurately and concisely using ONLY the provided content below. If the answer cannot be found in the content, state that you do not know based on the provided material.
`;
}

export class LLM {
  private az_client: OpenAI;
  private inv_client: OpenAI;
  private memory_store: MemoryRegistory;

  //   private embedding_client :
  constructor() {
    let nvidia_api_key = process.env.NVIDIA_KEY;
    let openai_key = process.env.AZURE_API_KEY || "sdfsdfs";
    let azure_base_url = process.env.AZURE_BASE_URL || "";
    let nvidia_base_url =
      process.env.INVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";

    this.az_client = new OpenAI({
      apiKey: openai_key,
      baseURL: azure_base_url,
    });
    this.inv_client = new OpenAI({
      apiKey: nvidia_api_key,
      baseURL: nvidia_base_url,
    });
    this.memory_store = new MemoryRegistory();
  }

  //   get_client(provider:TProvider = "NVIDIA"):OpenAI{
  //     if(provider == "NVIDIA"){
  //         return this.az_client
  //     }
  //   }
  @RateLimitRetry({ maxRetries: 3, initialDelayMs: 1000 })
  async generate_embedding(
    text: string,
    provider: TProvider = "NVIDIA",
    inputType: "query" | "passage" = "passage", // Default to passage or query depending on your use-case
  ): Promise<number[] | undefined> {
    try {
      if (provider == "NVIDIA") {
        const res = await this.inv_client.embeddings.create({
          model: MODELS.inv_embedding,
          input: text,
          encoding_format: "float",
          ...({ input_type: inputType } as any),
        });
        res.data;
        return res.data[0]?.embedding as number[] | undefined;
      } else if (provider == "AZURE") {
        const res = await this.az_client.embeddings.create({
          model: MODELS.inv_embedding,
          input: text,
          encoding_format: "float",
        });
        return res.data[0]?.embedding;
      }
    } catch (error) {
      console.log("Error in Embeddings ", error);
      throw error;
    }
  }

  @RateLimitRetry({ maxRetries: 3, initialDelayMs: 1000 })
  async generate_completion(
    user_message: string,
  ): Promise<ChatCompletionMessage | undefined> {
    try {
      await this.memory_store.user(user_message);
      const messages = await this.memory_store.get_message();
      let res = await this.az_client.chat.completions.create({
        messages,
        model: "gpt-5.6-luna",
      });

      this.memory_store.assistent(
        res.choices[0]?.message.content as string,
        res.choices[0]?.message.tool_calls,
      );

      return res.choices[0]?.message;
    } catch (error) {
      console.log("Error in Generation ", error);
    }
  }
}

export const llm = new LLM();
