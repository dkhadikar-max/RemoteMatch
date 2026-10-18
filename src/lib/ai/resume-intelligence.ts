/**
 * Job-specific resume hints for Match Detail — deterministic, no AI.
 *
 * This module used to also hold analyzeResumeHeuristically / analyzeResumeWithAI, a client-side "resume analysis"
 * whose output was largely hard-coded and whose AI path could never run in production (audit R-P0-1, R-P1-1/2/5).
 * Both were removed in resume PR A (docs/resume-intelligence-design.md §1); the replacement is the server-side,
 * evidence-validated Resume Intelligence service (PR B). Do not reintroduce a client-side analyser here.
 */
import { skillAppearsInText } from '@/lib/resume/skill-evidence';
import { PersonProfile, CanonicalOpportunity, JobSpecificResumeImprovement } from '@/types/byn';

/**
 * Job-specific resume suggestions — DERIVED FROM DATA, never invented (P1b; audit R-P2-2).
 *
 * The only inputs are the job's required skills, the user's DECLARED skills and the user's resume text. Every
 * suggestion states a fact it can check and what to do about it; nothing describes the user's bullets, employers or
 * metrics, and there is no template text:
 *   - evidence: the skill is on the profile but the resume text does not mention it → make it visible
 *   - evidence: the job requires a skill that is not on the profile → add it if you have used it
 *   - reorder : the resume text mentions a skill the job requires → keep it easy to find
 * With no resume text (or one too short to judge) no claim about the resume is made. At most 3 are returned; an
 * empty list is a valid answer (the view says so honestly).
 */
const MIN_RESUME_WORDS_FOR_SUGGESTIONS = 8;

export function generateJobSpecificResumeAnalysis(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity
): JobSpecificResumeImprovement[] {
  const required: string[] = [];
  for (const raw of opportunity.requiredSkills ?? []) {
    const skill = typeof raw === 'string' ? raw.trim() : '';
    if (skill && !required.some((r) => r.toLowerCase() === skill.toLowerCase())) required.push(skill);
    if (required.length >= 8) break;
  }
  const declared = (profile.skills ?? []).map((s) => s.skillName).filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  const resumeText = typeof profile.rawResumeText === 'string' ? profile.rawResumeText : '';
  const resumeUsable = resumeText.trim().split(/\s+/).filter(Boolean).length >= MIN_RESUME_WORDS_FOR_SUGGESTIONS;

  const listedNotInResume: string[] = [];
  const notOnProfile: string[] = [];
  const inResume: string[] = [];
  for (const skill of required) {
    const onProfile = declared.some((d) => skillAppearsInText(skill, d));
    const inResumeText = resumeUsable && skillAppearsInText(skill, resumeText);
    if (inResumeText) inResume.push(skill);
    else if (onProfile && resumeUsable) listedNotInResume.push(skill);
    if (!onProfile) notOnProfile.push(skill);
  }

  const improvements: JobSpecificResumeImprovement[] = [];
  for (const skill of listedNotInResume.slice(0, 2)) {
    improvements.push({
      title: `Make ${skill} visible on your resume`,
      currentContext: 'Listed on your profile; not found in your resume text.',
      recommendation: `This role asks for ${skill}. If you have used it, make sure your resume shows where.`,
      actionType: 'evidence',
    });
  }
  for (const skill of notOnProfile.slice(0, 1)) {
    improvements.push({
      title: `Add ${skill} to your profile if you have used it`,
      currentContext: 'Required by this listing; not on your profile.',
      recommendation: `This role asks for ${skill}, which isn't on your profile. If you have experience with it, add it to your skills.`,
      actionType: 'evidence',
    });
  }
  for (const skill of inResume.slice(0, 1)) {
    improvements.push({
      title: `Keep ${skill} easy to find on your resume`,
      currentContext: 'Found in your resume text.',
      recommendation: `This role asks for ${skill} and your resume text mentions it — keep it near the top so it is easy to spot.`,
      actionType: 'reorder',
    });
  }
  return improvements.slice(0, 3);
}
