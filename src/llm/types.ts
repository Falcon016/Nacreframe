/** Provider-neutral conversation and streaming types. */

export interface ImageData {
  mediaType: string;
  /** base64 payload */
  data: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; images?: ImageData[] };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface StreamRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Omitted = the server's own default (usually: until the context is full). */
  maxTokens?: number;
  temperature?: number;
  /** Extended-thinking token budget (Anthropic). 0 or undefined disables. */
  thinkingBudget?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'signature'; signature: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; json: string }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'done'; stopReason: StopReason };

export interface ModelInfo {
  id: string;
  aliases?: string[];
  /** Context window in tokens, when the server reports it. */
  contextWindow?: number;
  /** llama.cpp router / LM Studio: whether the model is currently loaded in memory. */
  loaded?: boolean;
}

export interface Provider {
  readonly id: string;
  /**
   * Whether earlier reasoning is sent back to the model with the conversation. OpenAI-compatible servers drop it,
   * so it takes no room in the context there (context accounting must not count it).
   */
  readonly keepsThinking?: boolean;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
