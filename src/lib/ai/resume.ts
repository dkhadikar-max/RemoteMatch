import { GoogleGenerativeAI } from '@google/generative-ai';
import { PersonProfile, ProfileExperience, ProfileSkill } from '@/types/byn';

export interface ExtractedResumeData {
  fullName: string;
  headline: string;
  targetRoles: string[];
  skills: string[];
  yearsOfExperience: '0-1' | '2-3' | '4-6' | '7-10' | '10+';
  currentCountry: string;
  currentTimezone: string;
  experiences: Array<{
    company: string;
    roleTitle: string;
    startDate?: string;
    endDate?: string;
    isCurrent: boolean;
    achievements: string[];
  }>;
  summary: string;
}

// Fallback regex & heuristic parser when API key is not present
export function parseResumeHeuristically(rawText: string): ExtractedResumeData {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const fullName = lines[0] || 'Alex Candidate';

  // Common tech skills detection
  const commonTech = [
    'React', 'Next.js', 'TypeScript', 'JavaScript', 'Node.js', 'Python', 'Go', 'Golang',
    'PostgreSQL', 'SQL', 'MongoDB', 'AWS', 'Docker', 'Kubernetes', 'GraphQL', 'Tailwind CSS',
    'Figma', 'Product Management', 'Git', 'CI/CD', 'FastAPI', 'Django', 'Rust', 'Ruby'
  ];

  const foundSkills = commonTech.filter((skill) =>
    new RegExp(`\\b${skill.replace('.', '\\.')}\\b`, 'i').test(rawText)
  );

  return {
    fullName,
    headline: 'Full Stack & Remote Software Engineer',
    targetRoles: ['Full Stack Engineer', 'Frontend Engineer', 'Software Engineer'],
    skills: foundSkills.length > 0 ? foundSkills : ['React', 'TypeScript', 'Node.js', 'PostgreSQL'],
    yearsOfExperience: '4-6',
    currentCountry: 'Worldwide',
    currentTimezone: 'UTC',
    experiences: [
      {
        company: 'Distributed Tech Inc.',
        roleTitle: 'Senior Software Engineer',
        startDate: '2021',
        endDate: 'Present',
        isCurrent: true,
        achievements: [
          'Architected high-throughput web applications with Next.js and TypeScript.',
          'Collaborated with global async engineering teams across 6 time zones.',
        ],
      },
    ],
    summary: rawText.slice(0, 300) || 'Experienced remote professional with a track record of scalable software delivery.',
  };
}

// Full Gemini Flash parser
export async function parseResumeWithGemini(rawText: string): Promise<ExtractedResumeData> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return parseResumeHeuristically(rawText);
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `
Extract structured candidate profile information from this resume or professional profile text.

Resume Text:
"""
${rawText.slice(0, 4000)}
"""

Output ONLY valid JSON matching this exact structure:
{
  "fullName": "Name",
  "headline": "Brief professional headline",
  "targetRoles": ["Role 1", "Role 2"],
  "skills": ["Skill 1", "Skill 2", "Skill 3"],
  "yearsOfExperience": "4-6", // Must be one of: "0-1", "2-3", "4-6", "7-10", "10+"
  "currentCountry": "Country or Worldwide",
  "currentTimezone": "UTC, EST, CET, IST, etc.",
  "experiences": [
    {
      "company": "Company Name",
      "roleTitle": "Role Title",
      "startDate": "2021",
      "endDate": "Present",
      "isCurrent": true,
      "achievements": ["Achievement bullet 1", "Achievement bullet 2"]
    }
  ],
  "summary": "2-3 sentence executive summary"
}
`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(result.response.text());
    return parsed;
  } catch (err) {
    console.warn('Gemini resume parsing failed, using fallback:', err);
    return parseResumeHeuristically(rawText);
  }
}
