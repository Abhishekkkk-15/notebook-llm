import OpenAI from "openai";
import { AzureOpenAI } from "openai/azure.js";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionUserMessageParam,
  Embedding,
  FunctionDefinition,
  FunctionParameters,
} from "openai/resources";

import { config } from "dotenv";

import { RateLimitRetry } from "../retry.js";
import type { IParentChunkDoc } from "../db/parent_chunk.model.js";
import type { IParentChunk } from "../../types/chunktypes.js";
import { MemoryRegistory } from "./memory_registory.js";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { keyword_schema } from "../schema.js";
import { executeTool, tools } from "./tools.js";

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

// {
//     type: "function",
//     name: "get_horoscope",
//     description: "Get today's horoscope for an astrological sign.",
//     parameters: {
//       type: "object",
//       properties: {
//         sign: {
//           type: "string",
//           description: "An astrological sign like Taurus or Aquarius",
//         },
//       },
//       required: ["sign"],
//       additionalProperties: false,
//     },
//     strict: true,
//   },

function getTools() {
  const tools: ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "hybrid_search",
        description: "Run hybrid search over MongoDB.",
        parameters: {
          type: "object",
          properties: {
            options: {
              type: "object",
              description: "Configuration options for the hybrid search.",
              properties: {
                query: {
                  type: "string",
                  description:
                    "Query string or terms to search for in hybrid_search",
                },
                topK: {
                  type: "integer",
                  description: "Number of records to return. Default is 5.",
                  default: 5,
                },
              },
              required: ["query"],
            },
          },
          required: ["options"],
        },
      },
    },
  ];
  return tools;
}

export class LLM {
  private az_client: OpenAI;
  private inv_client: OpenAI;
  private memory_store: MemoryRegistory;
  private tools: ChatCompletionTool[];
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
    this.tools = getTools();
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

  async generate_completion(option: {
    user_message: string;
    images?: string[];
  }): Promise<ChatCompletionMessage | undefined> {
    try {
      await this.memory_store.user(option.user_message, option.images);
      const messages = await this.memory_store.get_message();
      let res = await this.completion({
        messages,
        model: "gpt-5.6-luna",
        tools: this.tools,
      });
      if (!res) {
        return undefined;
      }
      this.memory_store.assistent(res.content as string, res.tool_calls);

      return res;
    } catch (error) {
      console.log("Error in Generation ", error);
    }
  }

  @RateLimitRetry({ maxRetries: 3, initialDelayMs: 1000 })
  async completion(
    options: ChatCompletionCreateParamsNonStreaming,
  ): Promise<ChatCompletionMessage | undefined> {
    return (await this.az_client.chat.completions.create({ ...options }))
      .choices[0]?.message;
  }

  async agentRunTime(
    options: TAgentRunTimeOptions,
  ): Promise<IAgentResponse> {
    this.memory_store.user(options.user_query);
    const executedSteps: IAgentStep[] = [];
    let currentIteration = 0;
    while (true) {
      if (currentIteration >= options.iterationLimit) {
        await this.memory_store.developer(
          "Reached iteration limit. Please synthesize a final answer based on all gathered evidence so far.",
        );
        const messages = await this.memory_store.get_message();
        const finalRes = await this.completion({
          model: "gpt-5.6-luna",
          messages,
        });
        return {
          answer:
            finalRes?.content ||
            "Reached maximum iteration limit without concluding.",
          steps: executedSteps,
        };

      }
      currentIteration++;
      try {
        const messages = await this.memory_store.get_message();
        const res = await this.completion({
          model: "gpt-5.6-luna",
          tools: tools,
          messages,
        });

        const tool_calls = res?.tool_calls;
        this.memory_store.assistent(res?.content || null, tool_calls);
        if (tool_calls) {
          for (let idx = 0; idx < tool_calls.length; idx++) {
            const item = tool_calls[idx];
            if (item == undefined) continue;
            if (item.type !== "function") continue;
            const parsedArguments = JSON.parse(item?.function.arguments!);
            const fnName = item?.function.name as string;

            let toolResult = await executeTool(fnName, {
              ...parsedArguments,
              projectId: options.projectId,
            });
            const step: IAgentStep = {
              iteration: currentIteration,
              tool: fnName,
              args: parsedArguments,
              result: toolResult,
            };
            options.onSteps?.(step);
            executedSteps.push(step);
            this.memory_store.tool({
              tool_id: item.id as string,
              content: toolResult,
            });
          }
          continue;
        }
        return {
          answer: res?.content || "",
          steps: executedSteps,
        };
      } catch (error: any) {
        throw Error(`Error in Agent Loop ${error.message}`);
      }
    }
  }

  async get_keyword(query: string): Promise<string[]> {
    try {
      const messages: ChatCompletionMessageParam[] = [
        {
          role: "system",
          content:
            "Extract high-quality keywords for full-text search from the user query.",
        },
        {
          role: "user",
          content: query,
        },
      ];

      const res = await this.az_client.chat.completions.parse({
        messages,
        model: "gpt-5.6-luna",
        response_format: zodResponseFormat(keyword_schema, "keyword"),
      });
      return res.choices[0]?.message.parsed?.keywords || [];
    } catch (error) {
      console.log("[Error in get_keywordfunciton]");
      throw error;
    }
  }
}

export interface IAgentStep {
  iteration: number;
  tool: string;
  args: Record<string, any>;
  result: any;
}

export interface IAgentResponse {
  answer: string;
  steps: IAgentStep[];
}

type TAgentRunTimeOptions = {
  user_query: string;
  iterationLimit: number;
  projectId: string;
  onSteps?: (step: IAgentStep) => void;
};

export const llm = new LLM();
