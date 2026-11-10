/**
 * Resume Intelligence — deterministic authenticity coaching.
 *
 * Finds vague wording and generic self-description without rewriting the
 * candidate's experience. Every finding points to the exact source text.
 * Questions are deliberately limited: ask only when an answer can materially
 * improve the description. No metrics or achievements are inferred.
 */
import type { EvidenceRef, Finding } from '@/types/resume-intelligence';
import type { ResumeBullet } from './rubric';

export interface AuthenticityReview {
  findings: Array<Finding & { severity: 'high' | 'medium' | 'low'; priority: number }>;
  questions: Array<{ id: string; question: string; why: string; refs: string[] }>;
}

interface Detector {
  code: string;
  pattern: RegExp;
  message: string;
  question: string;
  why: string;
}

const BULLET_DETECTORS: Detector[] = [
  {
    code: 'responsibility_only',
    pattern: /\b(?:responsible for|duties included|tasked with)\b/i,
    message: 'This describes an assigned responsibility, but does not show what you personally did. Add the action you took and the part you owned.',
    question: 'What did you personally do in this responsibility? Which part did you own, and which parts did others handle?',
    why: 'Clarifies your actual contribution without overstating ownership.',
  },
  {
    code: 'vague_participation',
    pattern: /\b(?:worked on|involved in|helped with|assisted with|participated in)\b/i,
    message: 'This wording does not make your contribution clear. Replace it with the specific work you completed or supported.',
    question: 'What specific task or deliverable did you complete? If you supported someone else, what part did you handle?',
    why: 'Distinguishes direct ownership from collaboration or support.',
  },
  {
    code: 'generic_activity',
    pattern: /\b(?:handled various|worked across multiple|contributed to several|provided support for)\b/i,
    message: 'This phrase is broad. Name the work, process, customer group or deliverable so a reader can understand the scope.',
    question: 'Which work, process or customer group are you referring to? Give one concrete example.',
    why: 'Adds context without requiring an invented metric.',
  },
];

const GENERIC_CLICHE = /\b(?:results[- ]driven professional|dynamic professional|highly motivated individual|team player|proven track record|go[- ]getter|self[- ]starter|hard[- ]working professional|detail[- ]oriented professional)\b/i;

function makeEvidence(text: string, start: number): EvidenceRef {
  return { doc: 'resume', quote: text, start, end: start + text.length };
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Detects language that needs clarification. It does not assume that the
 * candidate lacks impact; it asks for missing context and preserves neutral
 * descriptions when no further facts are available.
 */
export function buildAuthenticityReview(resumeText: string, bullets: ResumeBullet[]): AuthenticityReview {
  const findings: AuthenticityReview['findings'] = [];
  const questions: AuthenticityReview['questions'] = [];
  const questionByKey = new Map<string, AuthenticityReview['questions'][number]>();

  for (const bullet of bullets) {
    const detector = BULLET_DETECTORS.find((item) => item.pattern.test(bullet.text));
    if (!detector) continue;

    const localIndex = resumeText.indexOf(bullet.text, Math.max(0, bullet.start));
    if (localIndex < 0) continue;

    const id = `auth-${bullet.id}-${detector.code}`;
    const matchedPhrase = bullet.text.match(detector.pattern)?.[0] ?? bullet.text;
    const phraseOffset = bullet.text.toLowerCase().indexOf(matchedPhrase.toLowerCase());
    findings.push({
      id,
      text: detector.message,
      criterion: 'R4',
      evidence: [makeEvidence(matchedPhrase, localIndex + Math.max(0, phraseOffset))],
      source: 'rules',
      severity: detector.code === 'responsibility_only' ? 'high' : 'medium',
      priority: detector.code === 'responsibility_only' ? 1 : 2,
    });

    const key = normalise(detector.question);
    const existingQuestion = questionByKey.get(key);
    if (existingQuestion) {
      existingQuestion.refs.push(id);
    } else if (questions.length < 3) {
      const question = {
        id: `question-${id}`,
        question: detector.question,
        why: detector.why,
        refs: [id],
      };
      questions.push(question);
      questionByKey.set(key, question);
    }
  }

  // Generic profile language is often detached from evidence. Flag the exact
  // line and ask for one example rather than generating a replacement claim.
  let offset = 0;
  const lines = resumeText.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const match = line.match(GENERIC_CLICHE);
    if (match && findings.length < 8) {
      const id = `auth-summary-${lineIndex + 1}-generic`;
      const phrase = match[0];
      findings.push({
        id,
        text: 'This is a broad self-description. Replace it with a concrete example of the work or result that demonstrates the quality.',
        criterion: 'R9',
        evidence: [makeEvidence(phrase, offset + line.indexOf(phrase))],
        source: 'rules',
        severity: 'low',
        priority: 6,
      });
      const question = {
        id: `question-${id}`,
        question: 'Which specific example from your work best demonstrates this description?',
        why: 'A concrete example is more credible than a general personal label.',
        refs: [id],
      };
      if (questions.length < 3) questions.push(question);
    }
    offset += line.length + 1;
  }

  return { findings: findings.slice(0, 8), questions };
}
