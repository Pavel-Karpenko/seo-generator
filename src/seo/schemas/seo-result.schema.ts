import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';

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
    .min(1, 'description must not be empty')
    .max(2000, 'description must be at most 2000 characters'),

  bullets: z
    .array(z.string().min(1, 'bullet must not be empty'))
    .min(3, 'bullets must contain at least 3 items')
    .max(8, 'bullets must contain at most 8 items'),
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
const JSON_BLOCK_REGEX = /\{[\s\S]*\}/;

/** Truncate string to maxLen, breaking at the last word boundary */
function truncateAtWord(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const cut = str.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

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
    const candidate = match ? match[0] : trimmed;

    // Step 3: Repair malformed JSON (unescaped quotes, trailing commas, etc.)
    try {
      parsed = JSON.parse(jsonrepair(candidate));
    } catch (repairErr: unknown) {
      throw new SeoParseError(
        `Failed to parse or repair LLM JSON output. ` +
          `Original error: ${parseError}. ` +
          `Repair error: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`,
        { candidate: candidate.slice(0, 500) },
      );
    }
  }

  // Step 3: Normalise fields that small models reliably exceed
  // Truncate at word boundary to avoid cutting mid-word
  if (typeof (parsed as Record<string, unknown>)['title'] === 'string') {
    (parsed as Record<string, unknown>)['title'] = truncateAtWord(
      (parsed as Record<string, string>)['title'], 60,
    );
  }
  if (typeof (parsed as Record<string, unknown>)['meta_description'] === 'string') {
    (parsed as Record<string, unknown>)['meta_description'] = truncateAtWord(
      (parsed as Record<string, string>)['meta_description'], 160,
    );
  }
  if (typeof (parsed as Record<string, unknown>)['h1'] === 'string') {
    (parsed as Record<string, unknown>)['h1'] = truncateAtWord(
      (parsed as Record<string, string>)['h1'], 70,
    );
  }

  // Step 4: Validate against Zod schema
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
