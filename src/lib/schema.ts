import { zodResponseFormat } from "openai/helpers/zod.mjs";
import z from "zod";
export let keyword_schema = z.object({
  keywords: z.array(z.string().describe("keyword for full text search")),
});
