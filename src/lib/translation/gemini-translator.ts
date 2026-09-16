/**
 * RemoteMatch — Free Batch Translator using Gemini 3.5 Flash Lite
 * ==============================================================================
 * Zero-cost, 100% free translation utilizing the existing GEMINI_API_KEY
 * from Google AI Studio.
 *
 * Batches up to 15 jobs per request so the entire 49 non-English catalog
 * is translated in ~3 to 4 API calls total.
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

export async function translateJobBatchWithGemini(
  jobs: BatchJobInput[]
): Promise<BatchTranslationOutput[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[translator] GEMINI_API_KEY is not configured in environment.');
  }

  if (jobs.length === 0) return [];

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL_ID,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1, // High determinism for factual translation
    },
  });

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

  const res = await model.generateContent(prompt);
  const text = res.response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`[translator] Failed to parse JSON response: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('[translator] Expected an array in response from translation model.');
  }

  return parsed as BatchTranslationOutput[];
}
