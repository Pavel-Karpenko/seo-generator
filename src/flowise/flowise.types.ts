export interface FlowiseConfig {
  baseUrl: string;
  chatflowId: string;
  apiKey: string;
  timeoutMs: number;
}

export interface FlowisePredictionRequest {
  question: string;
  overrideConfig?: {
    sessionId?: string;
    [key: string]: unknown;
  };
  streaming: true;
}

/** Token event — partial LLM output chunk */
export interface FlowiseTokenEvent {
  type: 'token';
  data: string;
}

/** End event — stream completed normally */
export interface FlowiseEndEvent {
  type: 'end';
  data?: string;
}

/** Error event — Flowise reported an error */
export interface FlowiseErrorEvent {
  type: 'error';
  data: string;
}

export type FlowiseSseEvent =
  | FlowiseTokenEvent
  | FlowiseEndEvent
  | FlowiseErrorEvent;

// ---- Custom error classes ----

export class FlowiseTimeoutError extends Error {
  readonly code = 'FLOWISE_TIMEOUT';
  constructor(timeoutMs: number) {
    super(`Flowise request timed out after ${timeoutMs}ms`);
    this.name = 'FlowiseTimeoutError';
  }
}

export class FlowiseApiError extends Error {
  readonly code = 'FLOWISE_API_ERROR';
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`Flowise API error ${statusCode}: ${message}`);
    this.name = 'FlowiseApiError';
  }
}

export class FlowiseEmptyResponseError extends Error {
  readonly code = 'FLOWISE_EMPTY_RESPONSE';
  constructor() {
    super('Flowise returned an empty or too-short response');
    this.name = 'FlowiseEmptyResponseError';
  }
}
