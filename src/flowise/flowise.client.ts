import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  FlowiseSseEvent,
  FlowisePredictionRequest,
} from './flowise.types';
import {
  FlowiseTimeoutError,
  FlowiseApiError,
  FlowiseEmptyResponseError,
} from './flowise.types';
import type { FlowiseConfig } from './flowise.types';

/** SSE field prefixes per the spec */
const DATA_PREFIX = 'data:';
const EVENT_PREFIX = 'event:';

interface ParsedSseLine {
  event?: string;
  data?: string;
}

@Injectable()
export class FlowiseClient {
  private readonly logger = new Logger(FlowiseClient.name);
  private readonly config: FlowiseConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      baseUrl: this.configService.getOrThrow<string>('flowise.baseUrl'),
      chatflowId: this.configService.getOrThrow<string>('flowise.chatflowId'),
      apiKey: this.configService.get<string>('flowise.apiKey', ''),
      timeoutMs: this.configService.get<number>('flowise.timeoutMs', 90_000),
    };
  }

  /**
   * Streams prediction from Flowise using SSE.
   * Yields FlowiseSseEvent objects until the stream ends.
   * Throws FlowiseTimeoutError | FlowiseApiError | FlowiseEmptyResponseError on failure.
   */
  async *streamPrediction(
    question: string,
    sessionId: string,
    correlationId: string,
  ): AsyncGenerator<FlowiseSseEvent> {
    const url = `${this.config.baseUrl}/api/v1/prediction/${this.config.chatflowId}`;

    const body: FlowisePredictionRequest = {
      question,
      streaming: true,
      overrideConfig: { sessionId },
    };

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, this.config.timeoutMs);

    this.logger.debug(
      { correlationId, sessionId, url },
      'Starting Flowise stream prediction',
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
          'X-Correlation-ID': correlationId,
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      if (isAbortError(err)) {
        throw new FlowiseTimeoutError(this.config.timeoutMs);
      }
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timeoutHandle);
      const errorText = await response.text().catch(() => '(unreadable body)');
      throw new FlowiseApiError(response.status, errorText);
    }

    if (!response.body) {
      clearTimeout(timeoutHandle);
      throw new FlowiseEmptyResponseError();
    }

    let tokenCount = 0;

    try {
      yield* this.parseSseStream(response.body, correlationId, (count) => {
        tokenCount = count;
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    this.logger.debug(
      { correlationId, sessionId, tokenCount },
      'Flowise stream prediction completed',
    );

    if (tokenCount === 0) {
      throw new FlowiseEmptyResponseError();
    }
  }

  /**
   * Reads an SSE response body stream, splits on double-newlines,
   * and yields parsed FlowiseSseEvents.
   */
  private async *parseSseStream(
    body: ReadableStream<Uint8Array>,
    correlationId: string,
    onTokenCount: (count: number) => void,
  ): AsyncGenerator<FlowiseSseEvent> {
    const decoder = new TextDecoder('utf-8');
    const reader = body.getReader();
    let buffer = '';
    let tokenCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Process any remaining buffer content
          if (buffer.trim()) {
            const event = parseBlock(buffer);
            if (event) yield event;
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // SSE blocks are delimited by double newlines
        const blocks = buffer.split(/\r?\n\r?\n/);
        // Keep the last (potentially incomplete) block in buffer
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          if (!block.trim()) continue;

          const event = parseBlock(block);
          if (!event) continue;

          if (event.type === 'token' && event.data) {
            tokenCount++;
            onTokenCount(tokenCount);
            this.logger.verbose(
              { correlationId, tokenCount },
              'SSE token received',
            );
            yield event;
          } else if (event.type === 'end') {
            yield event;
            return; // Stream is done
          } else if (event.type === 'error') {
            this.logger.warn(
              { correlationId, data: event.data },
              'Flowise SSE error event',
            );
            yield event;
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ---- Helpers ----

/**
 * Parses a single SSE block (lines separated by \n) into a FlowiseSseEvent.
 * Flowise emits: event: token\ndata: <text> or data: {"event":"token","data":"..."}
 */
function parseBlock(block: string): FlowiseSseEvent | null {
  const lines = block.split(/\r?\n/);
  const parsed: ParsedSseLine = {};

  for (const line of lines) {
    if (line.startsWith(EVENT_PREFIX)) {
      parsed.event = line.slice(EVENT_PREFIX.length).trim();
    } else if (line.startsWith(DATA_PREFIX)) {
      parsed.data = line.slice(DATA_PREFIX.length).trim();
    }
  }

  if (!parsed.data) return null;

  // Attempt to parse data as JSON (Flowise wraps events in JSON)
  try {
    const json = JSON.parse(parsed.data) as {
      event?: string;
      data?: unknown;
      message?: string;
    };

    const eventType = (json.event ?? parsed.event ?? 'token').toLowerCase();
    const data =
      typeof json.data === 'string'
        ? json.data
        : JSON.stringify(json.data ?? '');

    if (eventType === 'token') return { type: 'token', data };
    if (eventType === 'end') return { type: 'end', data };
    if (eventType === 'error') {
      return { type: 'error', data: data || (json.message ?? 'Unknown error') };
    }

    // Unknown event types — treat as token data if there is data
    if (data) return { type: 'token', data };
    return null;
  } catch {
    // Non-JSON data: treat as raw token
    if (parsed.event === 'end') return { type: 'end' };
    if (parsed.event === 'error') return { type: 'error', data: parsed.data };
    return { type: 'token', data: parsed.data };
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('aborted'))
  );
}

