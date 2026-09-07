import {
  PersonProfile,
  CanonicalOpportunity,
  ApplicationRecord,
  MaterialTone,
} from '@/types/byn';
import { CuratedProvider, CURATED_JOBS } from '../providers/curated';
import { normalizeOpportunity } from '../ingestion/pipeline';

// Default demo persona for initial launch & preview
export const DEFAULT_DEMO_PROFILE: PersonProfile = {
  id: 'demo-user-1',
  email: 'alex.chen@example.com',
  fullName: 'Alex Chen',
  headline: 'Senior Full Stack & AI Engineer',
  avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop&crop=faces',
  profileStrength: 78,
  planTier: 'free',
  dailyEvaluationsCount: 3,
  dailyRightSwipesCount: 0,
  dailyProposalsCount: 0,
  usageDate: new Date().toISOString().slice(0, 10),
  lastEvaluationResetAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  intent: {
    id: 'intent-1',
    profileId: 'demo-user-1',
    employmentTypes: ['Full-time', 'Contract'],
    targetRoles: ['Full Stack Engineer', 'Senior Frontend Engineer', 'Software Engineer'],
    yearsOfExperience: '4-6',
    minSalary: 110000,
    preferredCurrency: 'USD',
    availabilityStatus: 'immediately',
    updatedAt: new Date().toISOString(),
  },
  skills: [
    { id: 's-1', profileId: 'demo-user-1', skillName: 'React', yearsUsed: 5, isPrimary: true, evidenceLevel: 'strong' },
    { id: 's-2', profileId: 'demo-user-1', skillName: 'TypeScript', yearsUsed: 4, isPrimary: true, evidenceLevel: 'strong' },
    { id: 's-3', profileId: 'demo-user-1', skillName: 'Next.js', yearsUsed: 4, isPrimary: true, evidenceLevel: 'strong' },
    { id: 's-4', profileId: 'demo-user-1', skillName: 'Node.js', yearsUsed: 5, isPrimary: true, evidenceLevel: 'strong' },
    { id: 's-5', profileId: 'demo-user-1', skillName: 'PostgreSQL', yearsUsed: 4, isPrimary: true, evidenceLevel: 'strong' },
    { id: 's-6', profileId: 'demo-user-1', skillName: 'Tailwind CSS', yearsUsed: 3, isPrimary: false, evidenceLevel: 'strong' },
    { id: 's-7', profileId: 'demo-user-1', skillName: 'Docker', yearsUsed: 3, isPrimary: false, evidenceLevel: 'moderate' },
    { id: 's-8', profileId: 'demo-user-1', skillName: 'GraphQL', yearsUsed: 2, isPrimary: false, evidenceLevel: 'moderate' },
  ],
  experiences: [
    {
      id: 'exp-1',
      profileId: 'demo-user-1',
      company: 'TechFlow Cloud',
      roleTitle: 'Senior Full Stack Engineer',
      startDate: '2022',
      endDate: 'Present',
      isCurrent: true,
      achievements: [
        'Built modern high-concurrency web apps with Next.js App Router and TypeScript.',
        'Scaled distributed Postgres architecture supporting 200k+ monthly active users.',
      ],
      industry: 'Developer Tools & SaaS',
    },
    {
      id: 'exp-2',
      profileId: 'demo-user-1',
      company: 'PixelCraft Studio',
      roleTitle: 'Frontend Engineer',
      startDate: '2020',
      endDate: '2022',
      isCurrent: false,
      achievements: [
        'Designed component design systems in Figma and React for 15+ client web platforms.',
      ],
      industry: 'Design Agency',
    },
  ],
  location: {
    id: 'loc-1',
    profileId: 'demo-user-1',
    currentCountry: 'Worldwide',
    currentTimezone: 'UTC',
    workPreference: 'worldwide',
    allowedCountries: ['Worldwide'],
    willingTimezones: ['UTC', 'EST', 'PST', 'CET'],
  },
};

const STORAGE_KEYS = {
  PROFILE: 'remotematch_profile',
  SWIPES: 'remotematch_swipes',
  APPLICATIONS: 'remotematch_applications',
};

// In-memory data store with browser localStorage synchronization
class LocalRepository {
  private profile: PersonProfile = DEFAULT_DEMO_PROFILE;
  private opportunities: CanonicalOpportunity[] = CURATED_JOBS.map(normalizeOpportunity);
  private swipes: Array<{ opportunityId: string; action: 'interested' | 'passed'; date: string }> = [];
  private applications: Map<string, ApplicationRecord> = new Map();
  private isLoadedFromStorage = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this.loadFromStorage();
    }
  }

  private loadFromStorage() {
    try {
      const storedProfile = localStorage.getItem(STORAGE_KEYS.PROFILE);
      if (storedProfile) {
        this.profile = JSON.parse(storedProfile);
      }

      const storedSwipes = localStorage.getItem(STORAGE_KEYS.SWIPES);
      if (storedSwipes) {
        this.swipes = JSON.parse(storedSwipes);
      }

      const storedApps = localStorage.getItem(STORAGE_KEYS.APPLICATIONS);
      if (storedApps) {
        const parsedApps = JSON.parse(storedApps) as ApplicationRecord[];
        this.applications.clear();
        parsedApps.forEach((app) => this.applications.set(app.opportunityId, app));
      }

      this.isLoadedFromStorage = true;
    } catch (err) {
      console.warn('Could not load from localStorage:', err);
    }
  }

  private syncToStorage() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(this.profile));
      localStorage.setItem(STORAGE_KEYS.SWIPES, JSON.stringify(this.swipes));
      localStorage.setItem(
        STORAGE_KEYS.APPLICATIONS,
        JSON.stringify(Array.from(this.applications.values()))
      );
    } catch (err) {
      console.warn('Could not sync to localStorage:', err);
    }
  }

  private checkAndResetDailyUsage() {
    const today = new Date().toISOString().slice(0, 10);
    if (!this.profile.usageDate) {
      this.profile.usageDate = today;
      this.profile.dailyRightSwipesCount = this.profile.dailyRightSwipesCount || 0;
      this.profile.dailyProposalsCount = this.profile.dailyProposalsCount || 0;
      this.syncToStorage();
    } else if (this.profile.usageDate !== today) {
      this.profile.usageDate = today;
      this.profile.dailyRightSwipesCount = 0;
      this.profile.dailyProposalsCount = 0;
      this.profile.dailyEvaluationsCount = 0;
      this.profile.lastEvaluationResetAt = new Date().toISOString();
      this.syncToStorage();
    }
  }

  canRightSwipe(): boolean {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    this.checkAndResetDailyUsage();
    return this.profile.planTier === 'pro' || (this.profile.dailyRightSwipesCount || 0) < 15;
  }

  canRewind(): boolean {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    return this.profile.planTier === 'pro';
  }

  canGenerateProposal(): boolean {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    this.checkAndResetDailyUsage();
    return this.profile.planTier === 'pro' || (this.profile.dailyProposalsCount || 0) < 5;
  }

  canApplyAdvancedFilters(): boolean {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    return this.profile.planTier === 'pro';
  }

  incrementProposalsCount(): boolean {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    this.checkAndResetDailyUsage();
    if (!this.canGenerateProposal()) {
      return false;
    }
    this.profile.dailyProposalsCount = (this.profile.dailyProposalsCount || 0) + 1;
    this.syncToStorage();
    return true;
  }

  getProfile(): PersonProfile {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    this.checkAndResetDailyUsage();
    return this.profile;
  }

  updateProfile(updated: Partial<PersonProfile>): PersonProfile {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    this.profile = { ...this.profile, ...updated, updatedAt: new Date().toISOString() };
    this.syncToStorage();
    return this.profile;
  }

  getOpportunities(): CanonicalOpportunity[] {
    return this.opportunities;
  }

  getOpportunityById(id: string): CanonicalOpportunity | undefined {
    return this.opportunities.find((o) => o.id === id);
  }

  recordSwipe(opportunityId: string, action: 'interested' | 'passed'): boolean {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    this.checkAndResetDailyUsage();

    if (action === 'interested') {
      if (this.profile.planTier === 'free' && (this.profile.dailyRightSwipesCount || 0) >= 15) {
        return false;
      }
      this.profile.dailyRightSwipesCount = (this.profile.dailyRightSwipesCount || 0) + 1;
    }

    this.swipes = this.swipes.filter((s) => s.opportunityId !== opportunityId);
    this.swipes.push({ opportunityId, action, date: new Date().toISOString() });
    this.profile.dailyEvaluationsCount = (this.profile.dailyEvaluationsCount || 0) + 1;
    this.syncToStorage();
    return true;
  }

  rewindLastSwipe(): string | null {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    if (this.swipes.length === 0) return null;
    const last = this.swipes.pop();
    if (last) {
      this.profile.dailyEvaluationsCount = Math.max((this.profile.dailyEvaluationsCount || 1) - 1, 0);
      if (last.action === 'interested') {
        this.applications.delete(last.opportunityId);
        this.profile.dailyRightSwipesCount = Math.max((this.profile.dailyRightSwipesCount || 1) - 1, 0);
      }
      this.syncToStorage();
      return last.opportunityId;
    }
    return null;
  }

  getSwipes() {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    return this.swipes;
  }

  // saveApplication / updateApplicationStatus / recordFeedback / getApplication
  // / addEvent / getEvents were removed as part of the outcome-lifecycle
  // migration (supabase/migrations/006_outcome_lifecycle.sql) — the
  // application lifecycle (status transitions, notes, feedback, and their
  // durable event history) is now server-authoritative via
  // transition_application_status() / record_application_feedback() /
  // update_application_notes(), reached through /api/applications/*. This
  // class's local `applications` cache and getAllApplications() below are
  // kept only because src/app/api/staging/metrics/route.ts (an unrelated,
  // pre-existing demo/staging dashboard, out of this migration's scope)
  // still reads from them.

  getAllApplications(): ApplicationRecord[] {
    if (typeof window !== 'undefined' && !this.isLoadedFromStorage) {
      this.loadFromStorage();
    }
    return Array.from(this.applications.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
}

// Global singleton for local runtime
export const localStore = new LocalRepository();
