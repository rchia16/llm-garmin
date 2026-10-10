import { z } from "zod";
import type { ModelProvider, ModelProviderOptions, StructuredGenerationRequest } from "./provider.js";

const completionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.union([z.string(), z.null()]) }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
});

// This is one transport adapter, not the parser contract. llama-server currently exposes
// an OpenAI-shaped chat-completions API, while other local backends can implement ModelProvider.
export class LlamaServerProvider implements ModelProvider {
  private readonly options: ModelProviderOptions;
  private readonly requestFetch: typeof globalThis.fetch;

  public constructor(options: ModelProviderOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/$/, "") };
    // Browser fetch must retain its global receiver; storing window.fetch unbound causes Illegal invocation.
    this.requestFetch = (options.fetch ?? globalThis.fetch).bind(globalThis);
  }

  public async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    const response = await this.requestFetch(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey === undefined ? {} : { Authorization: `Bearer ${this.options.apiKey}` }),
      },
      body: JSON.stringify({
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        messages: request.messages,
        temperature: request.temperature ?? 0,
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        // Qwen3's reasoning tokens otherwise consume the JSON output budget.
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "workout_interpretation",
            strict: true,
            schema: request.jsonSchema,
          },
        },
      }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (!response.ok) throw new Error(`Llama server returned HTTP ${response.status}.`);
    const payload = completionResponseSchema.parse(await response.json());
    const choice = payload.choices[0];
    const content = choice?.message.content;
    if (content === null || content === undefined) throw new Error("Llama server returned empty content.");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      const endedAtLimit = choice?.finish_reason === "length";
      const excerpt = content.slice(-240).replace(/\s+/g, " ");
      throw new Error(`${endedAtLimit ? "Model reached its output token limit before completing JSON" : "Llama server returned invalid JSON content"}. Response ended with: ${excerpt}`);
    }
  }
}
