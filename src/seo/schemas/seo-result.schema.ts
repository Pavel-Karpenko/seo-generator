import { z } from 'zod';

// ---- Zod schema ----

export const SeoResultSchema = z.object({
  title: z
    .string()
    .min(1, 'title must not be empty')
    .max(60, 'title must be at most 60 characters'),

  meta_description: z
    .string()
    .min(1, 'meta_description must not be empty')
    .max(160, 'meta_description must be at most 160 characters'),

  h1: z
    .string()
    .min(1, 'h1 must not be empty')
    .max(70, 'h1 must be at most 70 characters'),

  description: z
    .string()
    .min(150, 'description must be at least 150 characters')
    .max(250, 'description must be at most 250 characters'),

  bullets: z
    .array(z.string().min(1, 'bullet must not be empty'))
    .min(4, 'bullets must contain at least 4 items')
    .max(6, 'bullets must contain at most 6 items'),
});

export type SeoResult = z.infer<typeof SeoResultSchema>;

// ---- Custom error class ----

export class SeoParseError extends Error {
  readonly code = 'SEO_PARSE_ERROR';

  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SeoParseError';
  }
}

// ---- Regex for extracting JSON from LLM markdown output ----
// Matches the outermost `{...}` block, including nested braces.
// Using a greedy match that handles nested structures.
const JSON_BLOCK_REGEX = /\{[\s\S]*\}/;

/**
 * Attempts to extract and validate a SeoResult from raw LLM output.
 *
 * Strategy:
 * 1. Try direct JSON.parse of the raw string (happy path)
 * 2. Extract first `{...}` block via regex (handles markdown fences)
 * 3. Validate the parsed object against SeoResultSchema
 *
 * @throws SeoParseError if extraction or validation fails
 */
export function extractAndValidate(raw: string): SeoResult {
  if (!raw || raw.trim().length === 0) {
    throw new SeoParseError('LLM returned an empty string');
  }

  const trimmed = raw.trim();

  // Step 1: Try direct parse
  let parsed: unknown;
  let parseError: string | null = null;

  try {
    parsed = JSON.parse(trimmed);
  } catch (err: unknown) {
    parseError = err instanceof Error ? err.message : String(err);

    // Step 2: Extract JSON block from markdown/prose
    const match = JSON_BLOCK_REGEX.exec(trimmed);
    if (!match) {
      throw new SeoParseError(
        `Failed to parse LLM output as JSON and no JSON block found. Parse error: ${parseError}`,
        { raw: trimmed.slice(0, 500) },
      );
    }

    try {
      parsed = JSON.parse(match[0]);
    } catch (regexParseErr: unknown) {
      throw new SeoParseError(
        `Found JSON block via regex but could not parse it. ` +
          `Original error: ${parseError}. ` +
          `Regex block parse error: ${regexParseErr instanceof Error ? regexParseErr.message : String(regexParseErr)}`,
        { extracted: match[0].slice(0, 500) },
      );
    }
  }

  // Step 3: Validate against Zod schema
  const result = SeoResultSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');

    throw new SeoParseError(
      `LLM JSON output failed schema validation: ${issues}`,
      { issues: result.error.issues, parsed },
    );
  }

  return result.data;
}
