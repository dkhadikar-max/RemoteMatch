/**
 * RemoteMatch — Free Batch Translator using Gemini 3.5 Flash Lite
 * ==============================================================================
 * Zero-cost, 100% free translation utilizing the existing GEMINI_API_KEY
 * from Google AI Studio.
 *
 * Batches up to 15 jobs per request so the entire 49 non-English catalog
 * is translated in ~3 to 4 API calls total.
 *
 * RESPONSE-SHAPE CONTRACT. A model response is untrusted input. It used to be
 * cast straight to BatchTranslationOutput[] after `Array.isArray`, so a single
 * element missing `translatedTitle` (or carrying `null`, a number, …) reached
 * `.trim()` further down and threw a TypeError that escaped the whole
 * translation pass. parseTranslationResponse() now validates EVERY element:
 * a malformed element is rejected on its own (its row is then recorded as an
 * error by the caller) and never costs the well-formed elements beside it.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_MODEL_ID } from '@/lib/ai/gemini-config';

export interface BatchJobInput {
  id: string;
  title: string;
  description: string;
}

export interface BatchTranslationOutput {
  id: string;
  detectedLanguage: string;
  translatedTitle: string;
  translatedDescription: string;
}

/** One response element that failed shape validation. Carries NO model text —
 *  only where it was and why — so it is safe to log. */
export interface RejectedTranslationResult {
  /** Position of the element in the response array. */
  index: number;
  /** The element's `id` when it had a usable one, else null. */
  id: string | null;
  reason: string;
}

export interface ParsedTranslationResponse {
  outputs: BatchTranslationOutput[];
  rejected: RejectedTranslationResult[];
}

const REQUIRED_STRING_FIELDS = ['id', 'detectedLanguage', 'translatedTitle', 'translatedDescription'] as const;

/**
 * Turns the raw model text into validated outputs.
 *
 * Throws (whole response unusable — the caller retries, then records every row
 * of the batch as an error) when the text is not a string, is not valid JSON,
 * or is not a JSON array. Otherwise never throws: each element is checked on its
 * own and either lands in `outputs` or in `rejected`.
 *
 * An element is valid only if it is a plain object whose `id`,
 * `detectedLanguage`, `translatedTitle` and `translatedDescription` are all
 * strings and `id`/`detectedLanguage` are non-empty. (An empty translated
 * string is a VALID shape — validateTranslationPair() later rejects it for
 * being too short — so it is recorded as a validation failure, not a shape one.)
 * A repeated `id` keeps its first valid element.
 */
export function parseTranslationResponse(text: unknown): ParsedTranslationResponse {
  if (typeof text !== 'string') {
    throw new Error('[translator] Response text is not a string.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`[translator] Failed to parse JSON response: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('[translator] Expected an array in response from translation model.');
  }

  const outputs: BatchTranslationOutput[] = [];
  const rejected: RejectedTranslationResult[] = [];
  const seen = new Set<string>();

  parsed.forEach((el: unknown, index: number) => {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      rejected.push({ index, id: null, reason: `element is ${el === null ? 'null' : Array.isArray(el) ? 'an array' : typeof el}, not an object` });
      return;
    }
    const rec = el as Record<string, unknown>;
    const id = typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : null;

    for (const field of REQUIRED_STRING_FIELDS) {
      const v = rec[field];
      if (typeof v !== 'string') {
        rejected.push({ index, id, reason: `"${field}" is ${v === undefined ? 'missing' : v === null ? 'null' : `a ${Array.isArray(v) ? 'array' : typeof v}`}, expected a string` });
        return;
      }
    }
    if (rec.id === '' || (rec.detectedLanguage as string).trim() === '') {
      rejected.push({ index, id, reason: `"${rec.id === '' ? 'id' : 'detectedLanguage'}" is empty` });
      return;
    }
    if (seen.has(rec.id as string)) {
      rejected.push({ index, id, reason: 'duplicate id (first valid element kept)' });
      return;
    }
    seen.add(rec.id as string);
    outputs.push({
      id: rec.id as string,
      detectedLanguage: rec.detectedLanguage as string,
      translatedTitle: rec.translatedTitle as string,
      translatedDescription: rec.translatedDescription as string,
    });
  });

  return { outputs, rejected };
}

/** Sends the prompt to the model and returns its raw text. Replaced in tests so
 *  no live Gemini call (and no free-tier quota) is ever spent on them. */
export type GenerateText = (prompt: string) => Promise<string>;

async function generateWithGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[translator] GEMINI_API_KEY is not configured in environment.');
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL_ID,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1, // High determinism for factual translation
    },
  });
  const res = await model.generateContent(prompt);
  return res.response.text();
}

export async function translateJobBatchWithGemini(
  jobs: BatchJobInput[],
  generate: GenerateText = generateWithGemini
): Promise<BatchTranslationOutput[]> {
  if (jobs.length === 0) return [];

  const prompt = `You are an accurate, professional job translation engine.
Translate the following job postings into professional English.
Preserve all technical terms, programming languages, and industry frameworks accurately.
Do NOT invent salary, location restrictions, or experience requirements.
Return ONLY a valid JSON array where each object has these exact keys:
[
  {
    "id": "matching the input id",
    "detectedLanguage": "lowercase BCP-47 code (e.g. de, es, fr, pt, it, ja, zh, ko)",
    "translatedTitle": "translated English title",
    "translatedDescription": "translated English description"
  }
]

Input jobs:
${JSON.stringify(jobs, null, 2)}
`;

  const text = await generate(prompt);
  const { outputs, rejected } = parseTranslationResponse(text);

  if (rejected.length > 0) {
    // Ids and reasons only — never model text. The affected rows are absent from
    // `outputs`, so the caller records each of them as a translation error.
    console.warn(
      `[translator] ${rejected.length} malformed element(s) in the model response were rejected: ` +
        rejected.map((r) => `#${r.index}${r.id ? `(${r.id})` : ''}: ${r.reason}`).join('; ')
    );
  }

  return outputs;
}
