import type { SupabaseClient } from '@supabase/supabase-js';
import { CanonicalOpportunity } from '@/types/byn';
import { getActiveOpportunities, getOpportunityBySourceIdAnyStatus } from '../ingestion/catalog-read';

export interface SeoFaqItem {
  q: string;
  directAnswer: string;
  explanation: string;
  linkHref: string;
  linkText: string;
}

export interface SeoCategory {
  slug: string;
  title: string;
  h1: string;
  metaTitle: string;
  metaDescription: string;
  directAnswer: string;
  intro: string;
  tags: string[];
  type: 'role' | 'seniority' | 'location';
  faqs: SeoFaqItem[];
}

export const SEO_CATEGORIES: SeoCategory[] = [
  {
    slug: 'software-engineering',
    title: 'Software Engineering',
    h1: 'Remote Software Engineering Jobs',
    metaTitle: 'Remote Software Engineering Jobs — Matched to Your Tech Stack | RemoteMatch',
    metaDescription: 'Discover vetted remote software engineering roles across React, TypeScript, Node.js, Go, and Python. Know your match score before you apply.',
    directAnswer: 'RemoteMatch helps software engineers discover remote opportunities matched to their specific programming languages, frameworks, and architecture experience. You can see why each engineering role fits, verify salary ranges upfront, and identify any missing prerequisites before applying.',
    intro: 'Explore vetted remote software engineering positions with transparent compensation, clear tech stack requirements, and objective match insights.',
    tags: ['React', 'TypeScript', 'Node.js', 'Go', 'Python', 'Kubernetes', 'Distributed Systems'],
    type: 'role',
    faqs: [
      {
        q: 'How does RemoteMatch match software engineering jobs to experience?',
        directAnswer: 'RemoteMatch evaluates your declared languages, frameworks, and production scale against each job\'s technical requirements.',
        explanation: 'Rather than keyword-counting, our evaluation compares your architecture depth, seniority level, and async remote collaboration history against the team\'s actual stack.',
        linkHref: '/guide/how-remote-matching-works',
        linkText: 'Read our guide on how remote matching works',
      },
      {
        q: 'Are these remote software engineering jobs open worldwide?',
        directAnswer: 'Each engineering listing states its geographic hiring scope directly on the card.',
        explanation: 'Opportunities indicate whether they are open worldwide, restricted to US/Canada timezones, or require European/UK tax residency.',
        linkHref: '/remote-jobs/worldwide',
        linkText: 'Browse worldwide remote jobs',
      },
      {
        q: 'How often are remote software engineering listings updated?',
        directAnswer: 'RemoteMatch updates listings continuously and validates active openings every 24 hours.',
        explanation: 'Positions confirmed closed by employers are retired immediately to ensure candidates never waste time applying to expired roles.',
        linkHref: '/remote-jobs',
        linkText: 'View the active remote jobs directory',
      },
    ],
  },
  {
    slug: 'product-management',
    title: 'Product Management',
    h1: 'Remote Product Management Jobs',
    metaTitle: 'Remote Product Management Jobs — Fit Score & Requirements | RemoteMatch',
    metaDescription: 'Find high-impact remote Product Manager and Lead PM roles. Understand team scope, product stage, and compensation before applying.',
    directAnswer: 'RemoteMatch matches Product Managers with distributed teams seeking strategic leadership in B2B SaaS, developer tools, and marketplaces. You can evaluate scope, roadmap ownership, and team timezones upfront.',
    intro: 'Browse remote product leadership roles at high-growth startups and remote-first companies with clear scope and compensation.',
    tags: ['Product Management', 'Roadmapping', 'User Research', 'SaaS', 'Developer Tools'],
    type: 'role',
    faqs: [
      {
        q: 'What makes a remote product manager profile competitive?',
        directAnswer: 'Distributed product roles prioritize written communication clarity and autonomous roadmap execution.',
        explanation: 'Employers look for demonstrated experience authoring PRDs/RFCs, conducting asynchronous user research, and coordinating cross-timezone engineering sprints.',
        linkHref: '/guide/build-remote-first-profile',
        linkText: 'Learn how to build a remote-first profile',
      },
      {
        q: 'Can I see why a product management job matches me?',
        directAnswer: 'Yes, RemoteMatch provides a breakdown comparing your domain background, product maturity, and skills against the opening.',
        explanation: 'We highlight specific strengths (e.g. enterprise B2B experience) and flag any missing elements (e.g. technical API product management).',
        linkHref: '/onboarding',
        linkText: 'Check your personalized match score',
      },
    ],
  },
  {
    slug: 'design',
    title: 'Design & UX',
    h1: 'Remote Product Design & UX Jobs',
    metaTitle: 'Remote Product Design & UX Jobs — Design Systems & UI | RemoteMatch',
    metaDescription: 'Explore remote Product Design, UX, and Design Systems roles. See team structure, design maturity, and salary ranges upfront.',
    directAnswer: 'RemoteMatch curates remote UI/UX, product design, and design system positions at design-conscious technology companies. Candidates can evaluate design maturity, tooling, and team culture before submitting a portfolio.',
    intro: 'Discover remote product design opportunities that value craft, user empathy, design systems, and cross-functional async collaboration.',
    tags: ['Figma', 'Product Design', 'Design Systems', 'User Research', 'UI/UX'],
    type: 'role',
    faqs: [
      {
        q: 'Do remote design roles require synchronous working hours?',
        directAnswer: 'Most distributed design teams require 3 to 4 hours of core timezone overlap for critique and design sprints.',
        explanation: 'Day-to-day workflow occurs primarily in Figma comments, Loom recordings, and written specs, allowing significant schedule flexibility.',
        linkHref: '/guide/timezone-overlap-remote-hiring',
        linkText: 'Read about timezone overlap in remote hiring',
      },
    ],
  },
  {
    slug: 'data',
    title: 'Data & Analytics',
    h1: 'Remote Data Engineering & Analytics Jobs',
    metaTitle: 'Remote Data Engineering & Analytics Jobs | RemoteMatch',
    metaDescription: 'Find remote Data Engineer, Analytics Engineer, and Data Science roles with modern stacks like Snowflake, dbt, SQL, and Python.',
    directAnswer: 'RemoteMatch helps data professionals find verified remote positions in data warehousing, analytics engineering, and streaming pipelines. Review cloud data architectures and salary bands before applying.',
    intro: 'Browse remote data opportunities modeling high-volume transaction feeds, real-time analytics, and modern cloud warehouses.',
    tags: ['Python', 'SQL', 'dbt', 'Snowflake', 'ETL', 'PostgreSQL'],
    type: 'role',
    faqs: [
      {
        q: 'Which data stacks are in demand for remote teams?',
        directAnswer: 'Modern remote data teams frequently hire for SQL, dbt, Snowflake, Python, and Kafka streaming architectures.',
        explanation: 'Experience operating production ETL pipelines with automated testing and data observability receives high match weighting.',
        linkHref: '/remote-jobs/software-engineering',
        linkText: 'Explore related engineering positions',
      },
    ],
  },
  {
    slug: 'marketing',
    title: 'Marketing & Content',
    h1: 'Remote Marketing & Growth Jobs',
    metaTitle: 'Remote Marketing, Content & Growth Jobs | RemoteMatch',
    metaDescription: 'Find remote Product Marketing, Content Strategy, and Growth roles at top remote-first tech companies.',
    directAnswer: 'RemoteMatch connects marketing specialists, copywriters, and growth strategists with remote-first software companies. Evaluate product positioning, organic growth milestones, and compensation upfront.',
    intro: 'Explore remote marketing roles focused on product messaging, organic growth, copywriting, and developer adoption.',
    tags: ['Product Marketing', 'Copywriting', 'Content Marketing', 'SEO', 'Positioning'],
    type: 'role',
    faqs: [
      {
        q: 'Can marketers work worldwide in remote tech companies?',
        directAnswer: 'Many marketing roles offer global flexibility, while product launch roles may align with North American or European timezones.',
        explanation: 'RemoteMatch clearly displays timezone requirements on each listing so candidates know their scheduling feasibility immediately.',
        linkHref: '/remote-jobs/worldwide',
        linkText: 'See worldwide marketing openings',
      },
    ],
  },
  {
    slug: 'senior',
    title: 'Senior & Staff',
    h1: 'Senior & Staff Remote Roles',
    metaTitle: 'Senior & Staff Remote Jobs — High-Impact Leadership | RemoteMatch',
    metaDescription: 'Discover Senior, Staff, and Principal remote roles. Transparent compensation, architectural scope, and verified team fit.',
    directAnswer: 'RemoteMatch features high-impact Senior, Staff, and Principal remote opportunities for professionals who excel in autonomous environments. Review architectural scope, team size, and transparent compensation bands.',
    intro: 'High-leverage remote positions for experienced engineers, designers, and leaders who thrive in autonomous, async environments.',
    tags: ['Senior', 'Staff', 'Distributed Systems', 'Architecture', 'Leadership'],
    type: 'seniority',
    faqs: [
      {
        q: 'What distinguishes Senior and Staff evaluations on RemoteMatch?',
        directAnswer: 'Senior roles require proven independent delivery, while Staff roles assess cross-team architectural ownership and mentoring.',
        explanation: 'Our matching system examines the complexity and scale of systems you have operated rather than merely counting calendar years on your resume.',
        linkHref: '/guide/evaluate-remote-job-requirements',
        linkText: 'Guide to evaluating remote requirements',
      },
    ],
  },
  {
    slug: 'entry-level',
    title: 'Early Career',
    h1: 'Entry-Level & Mid Remote Jobs',
    metaTitle: 'Entry-Level & Junior Remote Jobs — Start Your Remote Career | RemoteMatch',
    metaDescription: 'Browse vetted early-career and mid-level remote roles with supportive mentorship, documentation-first cultures, and fair pay.',
    directAnswer: 'RemoteMatch filters for early-career and mid-level remote positions at organizations with mature documentation and dedicated onboarding systems. Understand foundational expectations and training support upfront.',
    intro: 'Remote opportunities welcoming early to mid-career professionals with clear growth pathways and supportive async cultures.',
    tags: ['Junior', 'Mid-Level', 'Frontend', 'Backend', 'Support'],
    type: 'seniority',
    faqs: [
      {
        q: 'Can early-career engineers thrive in remote work?',
        directAnswer: 'Yes, provided the employer has structured onboarding, assigned mentors, and comprehensive written documentation.',
        explanation: 'RemoteMatch verifies team support structures to ensure junior candidates join environments where they can develop quickly.',
        linkHref: '/guide/quality-over-quantity-remote-jobs',
        linkText: 'Read about high-intent application strategy',
      },
    ],
  },
  {
    slug: 'worldwide',
    title: 'Worldwide Remote',
    h1: 'Worldwide Remote Jobs (Work From Anywhere)',
    metaTitle: 'Worldwide Remote Jobs — Work From Anywhere | RemoteMatch',
    metaDescription: 'Curated remote jobs with zero geographic hiring restrictions. Apply from anywhere in the world with transparent USD/EUR pay.',
    directAnswer: 'RemoteMatch highlights truly borderless remote opportunities open to applicants worldwide regardless of residency. Every listing provides verified compensation in USD, EUR, or GBP.',
    intro: 'Truly global remote jobs that hire across all borders, without geographic hiring filters or timezone lock-ins.',
    tags: ['Worldwide', 'Anywhere', 'Global'],
    type: 'location',
    faqs: [
      {
        q: 'How do employers hire internationally for worldwide remote roles?',
        directAnswer: 'Employers typically hire via local entities, Employer of Record (EOR) services like Deel or Remote.com, or international contractor agreements.',
        explanation: 'This ensures candidates receive legal employment contracts, localized benefits, and compliant tax processing in their resident country.',
        linkHref: '/guide/remote-salary-transparency',
        linkText: 'Understanding international remote compensation',
      },
    ],
  },
  {
    slug: 'united-states',
    title: 'US & Canada',
    h1: 'Remote Jobs in the United States & Canada',
    metaTitle: 'Remote Jobs in US & Canada — Top Tech Companies | RemoteMatch',
    metaDescription: 'Remote opportunities for professionals in US and Canadian timezones (EST, CST, MST, PST) with competitive compensation.',
    directAnswer: 'RemoteMatch curates remote positions for professionals residing in US and Canadian timezones. Discover competitive salaries, 401(k)/RRSP benefits, and flexible working arrangements.',
    intro: 'Vetted remote positions designed for North American timezones offering competitive compensation and benefits packages.',
    tags: ['US/Canada Only', 'EST', 'PST'],
    type: 'location',
    faqs: [
      {
        q: 'Do US remote jobs require active US work authorization?',
        directAnswer: 'Most US-only postings require existing citizenship, green card, or eligible work authorization.',
        explanation: 'When an opportunity offers visa transfer or sponsorship, RemoteMatch surfaces this explicitly in the requirements overview.',
        linkHref: '/remote-jobs/worldwide',
        linkText: 'Check worldwide remote alternatives',
      },
    ],
  },
  {
    slug: 'europe',
    title: 'Europe & UK',
    h1: 'Remote Jobs in Europe & the UK',
    metaTitle: 'Remote Jobs in Europe & UK — GMT & CET Timezones | RemoteMatch',
    metaDescription: 'Browse remote tech roles in European and UK time zones with transparent GBP and EUR compensation.',
    directAnswer: 'RemoteMatch showcases European and UK remote roles with transparent EUR and GBP compensation, statutory paid leave, and synchronous CET/GMT collaboration hours.',
    intro: 'Explore European remote opportunities with healthy work-life balance, transparent salaries, and synchronous CET/GMT collaboration.',
    tags: ['Europe / UK Only', 'CET', 'GMT'],
    type: 'location',
    faqs: [
      {
        q: 'How are remote employment contracts handled in Europe?',
        directAnswer: 'European remote companies employ either through country-specific subsidiaries or compliant Employer of Record platforms.',
        explanation: 'This provides candidates full statutory protections including healthcare, retirement contributions, and standard European holiday entitlements.',
        linkHref: '/guide/remote-salary-transparency',
        linkText: 'Read about European remote compensation',
      },
    ],
  },
];

export interface SeoGuideArticle {
  slug: string;
  title: string;
  description: string;
  readingTime: string;
  publishedDate: string;
  author: string;
  category: string;
  topicalCluster: string;
  directAnswer: string;
  content: string[];
  takeaways: string[];
  faqs: SeoFaqItem[];
}

export const SEO_GUIDE_ARTICLES: SeoGuideArticle[] = [
  {
    slug: 'how-remote-matching-works',
    title: 'How Remote Matching Works (Without the Keyword Guesswork)',
    description: 'Why traditional keyword-matching fails remote applicants, and how deep background evaluation reveals real fit.',
    readingTime: '5 min read',
    publishedDate: '2026-03-01',
    author: 'RemoteMatch Editorial',
    category: 'Matching Strategy',
    topicalCluster: 'REMOTE JOB MATCHING',
    directAnswer: 'Remote matching evaluates candidate experience by comparing demonstrated engineering scale, architectural responsibility, and timezone overlap against employer requirements, rather than relying on crude keyword frequency.',
    content: [
      'Traditional job boards rely on crude keyword filters. If a job description mentions "Kubernetes" five times and your resume mentions it four, an automated applicant tracking system (ATS) may arbitrarily rank you behind someone who simply repeated the word more frequently.',
      'Remote hiring is fundamentally different from in-person hiring. What matters most is not keyword frequency, but context: the scale of systems you have operated, the degree of autonomy you exercised, how well your working hours overlap with the team, and whether you can communicate complex technical trade-offs asynchronously in writing.',
      'RemoteMatch solves this by analyzing four key pillars for every opportunity: Role Alignment, Technical Capability, Seniority Scope, and Timezone Overlap. Instead of guessing why an application vanished into an ATS black hole, candidates can see exactly where their profile shines and what prerequisites might need extra attention.',
    ],
    takeaways: [
      'Keyword stuffing rarely works on modern engineering managers who read candidate portfolios.',
      'Timezone overlap and async communication weight more heavily in remote evaluations than raw years on a title.',
      'Knowing what is missing before you apply lets you either address it in your proposal or move on to a higher-probability opportunity.',
    ],
    faqs: [
      {
        q: 'Why does RemoteMatch highlight what may be missing?',
        directAnswer: 'Surfacing gaps allows you to address them directly in your proposal note or prioritize roles with higher alignment.',
        explanation: 'Candidates who proactively address ambiguous requirements convert to interviews at more than triple the baseline rate of generic applications.',
        linkHref: '/guide/tailored-proposal-letters',
        linkText: 'Read how to write a tailored proposal letter',
      },
    ],
  },
  {
    slug: 'evaluate-remote-job-requirements',
    title: 'How to Evaluate Remote Job Requirements Before Applying',
    description: 'Differentiate hard prerequisites from wishlist items, check timezone overlap, and evaluate compensation upfront.',
    readingTime: '6 min read',
    publishedDate: '2026-03-02',
    author: 'RemoteMatch Editorial',
    category: 'Application Strategy',
    topicalCluster: 'REMOTE JOB REQUIREMENTS',
    directAnswer: 'To evaluate remote requirements effectively, separate non-negotiable legal and timezone boundaries from technical core competencies and secondary wishlist items before deciding to apply.',
    content: [
      'Job descriptions are often written as wishlists by committee. Hiring managers, recruiters, and team leads add desired skills until the posting describes a mythical candidate who rarely exists.',
      'To evaluate whether an opportunity is worth your time, separate requirements into three buckets: Non-Negotiable Hard Requirements (e.g. legal jurisdiction, required timezone overlap), Core Capabilities (e.g. production experience with modern React or distributed databases), and Nice-to-Haves (e.g. familiarity with a specific niche tool).',
      'If you meet 75-80% of core capabilities and all hard legal/timezone requirements, you are in the top tier of applicants. Use your application materials to highlight concrete outcomes rather than apologizing for tertiary gaps.',
    ],
    takeaways: [
      'Always verify geographic and timezone criteria before spending time polishing an application.',
      'Meeting 75-80% of listed capabilities is typically the sweet spot for competitive candidacy.',
      'Address minor wishlist gaps proactively by explaining related patterns or quick learning curve.',
    ],
    faqs: [
      {
        q: 'Should I apply if I lack one listed secondary tool?',
        directAnswer: 'Yes, if you possess strong fundamentals in an equivalent technology and clearly demonstrate adaptability.',
        explanation: 'Teams value engineers who understand distributed architecture principles over candidates who only know a specific vendor syntax.',
        linkHref: '/remote-jobs/software-engineering',
        linkText: 'Explore remote software engineering roles',
      },
    ],
  },
  {
    slug: 'tailored-proposal-letters',
    title: 'How to Write a Tailored Proposal Letter That Gets Read',
    description: 'Structure a 3-paragraph application note that directly references team pain points without AI fluff.',
    readingTime: '4 min read',
    publishedDate: '2026-03-03',
    author: 'RemoteMatch Editorial',
    category: 'Proposals & Letters',
    topicalCluster: 'REMOTE APPLICATIONS',
    directAnswer: 'A high-impact remote proposal is a concise 3-paragraph note under 250 words that establishes specific role alignment, cites two measurable achievements, and confirms timezone compatibility.',
    content: [
      'Generic cover letters full of generic praise ("I have long admired your innovative company...") are instantly ignored by busy hiring teams.',
      'Effective remote applications use a concise three-paragraph format: Paragraph 1 states the exact role and why your specific background matches their current milestone. Paragraph 2 presents 2-3 measurable achievements directly relevant to their stack or challenge. Paragraph 3 clarifies your timezone overlap, working style, and links to your work.',
      'Keep it under 250 words. Remote managers respect brevity, clarity, and respect for their time above all else.',
    ],
    takeaways: [
      'Keep your proposal under 250 words and lead with relevant accomplishments.',
      'Directly connect your past solutions to the team\'s stated business or technical challenge.',
      'Explicitly confirm your timezone compatibility and availability for interviews.',
    ],
    faqs: [
      {
        q: 'Do employers still read cover letters for remote roles?',
        directAnswer: 'Long letters are skipped, but brief, high-signal application notes are read by hiring managers seeking proof of written clarity.',
        explanation: 'In remote work, writing is the primary medium of daily collaboration. A thoughtful, concise note immediately demonstrates team suitability.',
        linkHref: '/guide/how-remote-matching-works',
        linkText: 'Learn how RemoteMatch analyzes role fit',
      },
    ],
  },
  {
    slug: 'timezone-overlap-remote-hiring',
    title: 'How Timezone Overlap Affects Remote Hiring Decisions',
    description: 'Why 4 hours of real-time overlap is standard for distributed teams and how to position your availability.',
    readingTime: '5 min read',
    publishedDate: '2026-03-04',
    author: 'RemoteMatch Editorial',
    category: 'Remote Work Logistics',
    topicalCluster: 'REMOTE TIMEZONES',
    directAnswer: 'Most functional distributed teams require 3 to 4 hours of daily synchronous overlap for architectural alignment, pull request reviews, and blockers, making timezone compatibility a hard screening filter.',
    content: [
      'While "work from anywhere" is an inspiring slogan, most functional distributed teams require 3 to 4 hours of synchronous overlap each business day for code reviews, architectural discussions, and standups.',
      'Understanding your target employer\'s timezone core is critical. A team based in San Francisco (PST) holding core hours between 10am and 2pm PST will be challenging for someone based in Central Europe unless they are prepared to work late evenings.',
      'Always clearly state your working hours and flexibility in UTC and target timezone offsets on your RemoteMatch profile and application notes.',
    ],
    takeaways: [
      'Target companies whose core hours naturally overlap with at least 3-4 hours of your active working day.',
      'Specify your working window upfront to eliminate friction during recruiter screening.',
      'Async-first companies (like Automattic and GitLab) require the least overlap, making them ideal for global candidates.',
    ],
    faqs: [
      {
        q: 'How can I document successful cross-timezone collaboration?',
        directAnswer: 'Highlight instances where you coordinated features across continents using async RFCs, recorded walkthroughs, and automated CI pipelines.',
        explanation: 'Showing that your code and documentation unblock colleagues while you sleep is the strongest evidence of remote senior maturity.',
        linkHref: '/guide/build-remote-first-profile',
        linkText: 'Check profile building recommendations',
      },
    ],
  },
  {
    slug: 'quality-over-quantity-remote-jobs',
    title: 'Why Applying to Fewer, Better-Matched Jobs Works Better',
    description: 'The data behind high-intent applications vs spray-and-pray job hunting in competitive remote markets.',
    readingTime: '5 min read',
    publishedDate: '2026-03-05',
    author: 'RemoteMatch Editorial',
    category: 'Search Strategy',
    topicalCluster: 'REMOTE JOB SEARCH',
    directAnswer: 'Submitting 5 to 10 deeply researched, high-fit applications per week delivers dramatically higher interview conversion than blasting hundreds of generic one-click submissions into applicant tracking systems.',
    content: [
      'With the rise of one-click application extensions, popular remote job postings now receive upwards of 500 to 1,500 applicants within 48 hours. Most of these applications are completely un-tailored and discarded immediately by hiring software.',
      'Submitting 10 high-fit, well-researched applications with tailored proposals consistently delivers higher interview conversion than firing off 200 generic clicks.',
      'RemoteMatch is designed specifically for this reality: by giving you a clear match score, highlighting requirements to double-check, and curating high-signal opportunities, you can focus your energy where your probability of success is highest.',
    ],
    takeaways: [
      'Hiring teams can detect auto-applied resumes within three seconds.',
      'Investing 20 minutes in a high-fit role produces far higher yield than blasting 50 generic resumes.',
      'Track every conversation carefully to maintain momentum from application to offer.',
    ],
    faqs: [
      {
        q: 'How many applications should a remote job seeker send per week?',
        directAnswer: 'For experienced tech professionals, 5 to 10 customized, high-fit applications per week yields the highest interview conversion.',
        explanation: 'Focused applications allow you to tailor your resume points to the employer\'s challenges, producing meaningful discussions rather than automated rejections.',
        linkHref: '/remote-jobs',
        linkText: 'Browse curated remote openings',
      },
    ],
  },
  {
    slug: 'build-remote-first-profile',
    title: 'How to Build a Profile That Reflects Your Real Remote Experience',
    description: 'Highlight async documentation, written clarity, autonomous problem-solving, and international collaboration.',
    readingTime: '6 min read',
    publishedDate: '2026-03-06',
    author: 'RemoteMatch Editorial',
    category: 'Profile & Resume',
    topicalCluster: 'REMOTE EXPERIENCE',
    directAnswer: 'A remote-first profile emphasizes written technical design ownership, measurable business impact, autonomous delivery, and successful async team collaboration rather than mere lists of tools.',
    content: [
      'In a physical office, presence and verbal charm often mask gaps in documentation or execution. In a remote environment, written clarity is your superpower.',
      'When framing your experience, highlight instances where you authored RFCs or technical specs, drove consensus across continents, established automated testing suites, or mentored teammates without face-to-face supervision.',
      'Ensure your RemoteMatch profile accurately captures your primary skills, secondary tools, preferred timezone windows, and target compensation to receive high-relevance recommendations.',
    ],
    takeaways: [
      'Emphasize written artifacts: technical design docs, architecture specs, and async project ownership.',
      'Quantify the scope of your systems (e.g. users, requests per second, revenue impact).',
      'Keep your target role and salary expectations realistic and visible.',
    ],
    faqs: [
      {
        q: 'How do I demonstrate remote readiness if my past company was hybrid?',
        directAnswer: 'Spotlight your asynchronous habits: written handoffs, documented post-mortems, and self-directed sprint management.',
        explanation: 'Remote leaders look for evidence of operational discipline regardless of whether your previous contract was hybrid or fully distributed.',
        linkHref: '/onboarding',
        linkText: 'Complete your RemoteMatch profile review',
      },
    ],
  },
  {
    slug: 'remote-salary-transparency',
    title: 'Remote Salary Transparency: Understanding Ranges Across Regions',
    description: 'Navigating local-indexed vs global-rate compensation models for remote software and product roles.',
    readingTime: '7 min read',
    publishedDate: '2026-03-07',
    author: 'RemoteMatch Editorial',
    category: 'Compensation & Offers',
    topicalCluster: 'REMOTE SALARY',
    directAnswer: 'Remote compensation models generally follow either global flat pay, regional geographic banding, or local cost-of-living indexing, each with distinct trade-offs for international professionals.',
    content: [
      'Remote compensation generally falls into one of three philosophies: Geographic Cost-of-Living Indexing (salaries adjusted to your home city), Geo-Banded Regional Pay (e.g. tier 1 North America, tier 2 Western Europe, tier 3 Rest of World), and Global Flat Pay (equal pay for equal title regardless of location).',
      'Understanding a company\'s compensation model before applying saves weeks of misaligned negotiations. RemoteMatch makes salary bands visible on every job card so you never waste time on opportunities below your requirements.',
      'When evaluating contractor vs employee roles, remember to account for self-employment taxes, health insurance, paid time off, and equipment allowances.',
    ],
    takeaways: [
      'Identify whether an employer pays global flat rates or local cost-of-living adjusted rates.',
      'Contractor rates should typically be 25-35% higher than equivalent full-time salaries to account for taxes and benefits.',
      'Never hesitate to clarify the currency and pay frequency during the initial screening call.',
    ],
    faqs: [
      {
        q: 'Why does RemoteMatch require transparent salary data on listings?',
        directAnswer: 'Displaying verified salary ranges upfront prevents compensation mismatches late in the interview pipeline.',
        explanation: 'Both candidates and hiring teams save dozens of hours when financial expectations are aligned before the first screening conversation.',
        linkHref: '/remote-jobs',
        linkText: 'View transparent remote listings',
      },
    ],
  },
  {
    slug: 'tracking-remote-applications',
    title: 'Tracking Remote Applications: From First Click to Offer',
    description: 'Keep your search organized across screening, technical rounds, take-homes, and final negotiations.',
    readingTime: '5 min read',
    publishedDate: '2026-03-08',
    author: 'RemoteMatch Editorial',
    category: 'Career Management',
    topicalCluster: 'APPLICATION TRACKING',
    directAnswer: 'Managing active remote interview pipelines across multiple companies requires logging each opportunity\'s stage, interviewer contacts, technical feedback, and agreed follow-up timelines in a single system.',
    content: [
      'Managing multiple concurrent interview pipelines across different timezones can quickly become overwhelming without a single source of truth.',
      'A structured application pipeline moves opportunities through four standard stages: Applied, Screening, Interview, and Offer. For each active process, note the specific recruiter, interview schedule, questions asked, and follow-up deadlines.',
      'The integrated RemoteMatch Application Tracker allows you to monitor all saved and applied roles, store interview notes, and log stage progressions seamlessly in one unified interface.',
    ],
    takeaways: [
      'Log the recruiter contact and exact job posting text immediately after applying.',
      'Keep concise notes after every call detailing technical questions, team dynamics, and agreed next steps.',
      'Celebrate every stage transition as tangible progress toward your ideal remote position.',
    ],
    faqs: [
      {
        q: 'Can I track external applications inside RemoteMatch?',
        directAnswer: 'Yes, the RemoteMatch tracker supports organizing any remote opportunity through Applied, Screening, Interview, and Offer.',
        explanation: 'Having a single view across all conversations keeps your follow-ups timely and reduces interview fatigue.',
        linkHref: '/tracker',
        linkText: 'Open the RemoteMatch Application Tracker',
      },
    ],
  },
];

// ==============================================================================
// Freshness and Lifecycle Queries
// ==============================================================================

/**
 * Returns all actively indexable jobs. Live Supply Activation: reads the
 * persisted `opportunities` catalog via RLS (`opportunities_select_active`,
 * status = 'active' only) instead of the static CURATED_JOBS array — the
 * guarantee that unknown/expired/draft rows never appear here comes from
 * that policy, not from any filtering in this function.
 */
export async function getActiveJobs(supabase: SupabaseClient): Promise<CanonicalOpportunity[]> {
  return getActiveOpportunities(supabase);
}

/**
 * Validates whether a job is eligible for search engine indexing.
 */
export function isJobIndexable(job: CanonicalOpportunity): boolean {
  return job.status === 'active';
}

/**
 * Checks if an expired job is permanently removed and should return 410 Gone,
 * or if it should return 200 with noindex,follow as a closed-job page.
 */
export function isJobPermanentlyRemoved(job: CanonicalOpportunity): boolean {
  return job.status === 'expired' && Boolean(job.isPermanentlyRemoved);
}

/**
 * Retrieves a job by its bare source id — the format the public
 * `/remote-jobs/view/[id]` URL has always used — REGARDLESS of status, so
 * the 410-vs-noindex decision above can actually be made. See
 * getOpportunityBySourceIdAnyStatus()'s own header for why this
 * deliberately bypasses RLS via the admin client.
 */
export async function getJobById(id: string): Promise<CanonicalOpportunity | undefined> {
  const job = await getOpportunityBySourceIdAnyStatus(id);
  return job ?? undefined;
}

/**
 * Filters active jobs for a category hub. Location filtering now reads the
 * already-classified remoteType/eligibleCountries fields directly (computed
 * once, at ingestion time, by the frozen classifyRemoteEligibility())
 * instead of re-parsing a raw location string that Live Supply Activation
 * doesn't persist — strictly more accurate for the same underlying fact,
 * not a behavior change for any job that was correctly classified before.
 */
export async function getJobsForCategory(categorySlug: string, supabase: SupabaseClient): Promise<CanonicalOpportunity[]> {
  const activeJobs = await getActiveJobs(supabase);
  const cat = SEO_CATEGORIES.find((c) => c.slug === categorySlug);
  if (!cat) return activeJobs;

  if (cat.type === 'location') {
    if (cat.slug === 'worldwide') {
      return activeJobs.filter((j) => j.remoteType === 'Worldwide');
    }
    if (cat.slug === 'united-states') {
      return activeJobs.filter((j) => j.remoteType === 'US' || j.eligibleCountries.some((c) => c === 'US' || c === 'USA'));
    }
    if (cat.slug === 'europe') {
      return activeJobs.filter((j) => j.remoteType === 'EU/EEA' || j.eligibleCountries.some((c) => c === 'EU' || c === 'UK' || c === 'EEA'));
    }
  }

  if (cat.type === 'seniority') {
    if (cat.slug === 'senior') {
      return activeJobs.filter((j) => j.experienceRequirement === '7-10' || j.title.toLowerCase().includes('senior') || j.title.toLowerCase().includes('lead') || j.title.toLowerCase().includes('staff'));
    }
    if (cat.slug === 'entry-level') {
      return activeJobs.filter((j) => j.experienceRequirement === '0-1' || j.experienceRequirement === '2-3');
    }
  }

  const slugLower = cat.slug.replace('-', ' ');
  return activeJobs.filter((j) => {
    const titleLower = j.title.toLowerCase();
    const skillsLower = (j.requiredSkills || []).map((t) => t.toLowerCase());
    const matchesTag = cat.tags.some((t) => skillsLower.includes(t.toLowerCase()));
    const matchesTitle = titleLower.includes(slugLower) || (slugLower === 'software engineering' && (titleLower.includes('engineer') || titleLower.includes('developer')));
    return matchesTag || matchesTitle;
  });
}

/**
 * Searches active jobs against a keyword query string (q) and optional
 * category. Performs factual matching against title, company, description,
 * and required skills. Location terms are matched against remoteType,
 * since the raw location string isn't persisted (see getJobsForCategory).
 */
export async function searchJobs(query: string | undefined, categorySlug: string | undefined, supabase: SupabaseClient): Promise<CanonicalOpportunity[]> {
  const pool = categorySlug ? await getJobsForCategory(categorySlug, supabase) : await getActiveJobs(supabase);
  if (!query || !query.trim()) return pool;

  const terms = query.toLowerCase().trim().split(/\s+/);
  return pool.filter((job) => {
    const haystack = `${job.title} ${job.company} ${job.description} ${(job.requiredSkills || []).join(' ')} ${job.remoteType}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

// ==============================================================================
// Structured Content Helpers (Strict Factual Validation)
// ==============================================================================

/**
 * Builds Schema.org BreadcrumbList.
 */
/**
 * Display-only salary range string, e.g. "$120,000–$160,000 USD". Replaces
 * the old raw `salaryString` field (free text from the provider, e.g.
 * "$120,000 - $160,000 USD"), which isn't persisted on CanonicalOpportunity
 * — only the parsed salaryMin/salaryMax/salaryCurrency are. Returns
 * undefined (never a fabricated range) when no salary was disclosed at all.
 */
export function formatSalaryRange(job: CanonicalOpportunity): string | undefined {
  if (!job.salaryMin) return undefined;
  const currency = job.salaryCurrency || 'USD';
  const min = job.salaryMin.toLocaleString('en-US');
  if (job.salaryMax && job.salaryMax > job.salaryMin) {
    return `$${min}–$${job.salaryMax.toLocaleString('en-US')} ${currency}`;
  }
  return `$${min}+ ${currency}`;
}

export function buildBreadcrumbSchema(items: Array<{ name: string; url: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Builds Schema.org JobPosting.
 * STRICT FACTUAL RULE:
 * - Only output for active jobs (status === 'active').
 * - Only output baseSalary when salaryMin is present AND currency is known.
 * - If only minimum exists without max, do NOT invent max.
 * - Do NOT invent validThrough (omit unless supplied).
 * - Do NOT invent missing employment type or applicant location.
 *
 * Live Supply Activation note: the raw pay-period text ("/ hour" etc.) that
 * used to drive unitText isn't persisted on CanonicalOpportunity — only the
 * parsed salaryMin/salaryMax/salaryCurrency are. unitText now defaults to
 * 'YEAR' rather than guessing from a string that no longer exists at this
 * point; this is a real, narrower loss of granularity than before,
 * flagged here rather than silently changed. Applicant location now comes
 * from remoteType/eligibleCountries (already-classified, not persisted as
 * free text either) rather than the old raw locationString — for a
 * Worldwide role this means correctly omitting
 * applicantLocationRequirements entirely (per the "do not invent" rule)
 * rather than force-fitting "Worldwide" into a schema.org Country name.
 */
export function buildJobPostingSchema(job: CanonicalOpportunity) {
  if (!isJobIndexable(job)) {
    return null;
  }

  const schema: Record<string, any> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description,
    datePosted: job.postedAt,
    hiringOrganization: {
      '@type': 'Organization',
      name: job.company,
      sameAs: job.sourceUrl,
      logo: job.companyLogo,
    },
    jobLocationType: 'TELECOMMUTE',
    url: `https://remotematch.com/remote-jobs/view/${job.sourceId}`,
    directApply: true,
  };

  // Employment type only if known
  if (job.employmentType === 'Full-time') {
    schema.employmentType = 'FULL_TIME';
  } else if (job.employmentType === 'Contract' || job.employmentType === 'Freelance') {
    schema.employmentType = 'CONTRACTOR';
  } else if (job.employmentType === 'Part-time') {
    schema.employmentType = 'PART_TIME';
  }

  // Applicant location only if the job is actually scoped to specific
  // countries — a genuinely borderless Worldwide role has no applicant
  // location requirement to state, so nothing is invented for it.
  if (job.eligibleCountries.length > 0) {
    schema.applicantLocationRequirements = job.eligibleCountries.map((country) => ({
      '@type': 'Country',
      name: country,
    }));
  }

  // Salary only when actually supplied with valid currency
  if (job.salaryMin && job.salaryCurrency) {
    const valueObj: Record<string, any> = {
      '@type': 'QuantitativeValue',
      minValue: job.salaryMin,
      unitText: 'YEAR',
    };
    if (job.salaryMax && job.salaryMax > job.salaryMin) {
      valueObj.maxValue = job.salaryMax;
    }
    schema.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.salaryCurrency,
      value: valueObj,
    };
  }

  return schema;
}
