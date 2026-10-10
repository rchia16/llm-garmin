export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export type StructuredGenerationRequest = {
  messages: ChatMessage[];
  jsonSchema: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal | undefined;
};

export type ModelProvider = {
  generateStructured(request: StructuredGenerationRequest): Promise<unknown>;
};

export type ModelProviderOptions = {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
};
