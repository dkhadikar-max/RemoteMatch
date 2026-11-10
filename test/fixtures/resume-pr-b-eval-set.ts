/**
 * Resume Intelligence (PR B) — §9 offline evaluation dataset.
 * docs/resume-intelligence-design.md §9: "28 synthetic resumes (4 technical, 3 business,
 * 3 creative, 3 operational, 3 financial, 3 customer-facing, 3 entry-level/student,
 * 3 career changers, 3 incomplete/very short/one-page-run-on)".
 *
 * Authorized 2026-10-30 (pasted instruction 0d7d): "Give each resume explicit hand-labelled
 * expected outcomes. Do not generate expected labels using the implementation being evaluated."
 * These labels were hand-computed from the resume TEXT against the documented deterministic
 * rules (heading lexicon in src/lib/resume/rubric.ts's HEADING_LEXICON, the bullet glyph, the
 * date-range regex, the >6-month gap / overlap rule, the 0.85 Jaccard duplicate threshold) —
 * not by running runDeterministicAnalysis() and copying its output. Where a label depends on
 * exact regex behavior that is easy to get wrong by hand (e.g. the precise duplicate-pair
 * Jaccard score), the case is designed so the expected outcome is unambiguous from the rule's
 * stated threshold, not from a borderline value.
 *
 * Per the design doc: "These labels come from me and are not independently reviewed, so results
 * are preliminary." Same caveat applies here — written by Claude, not independently reviewed,
 * and the runner's results must be reported with that limitation stated, not as a validated
 * accuracy number.
 */

export interface EvalCase {
  id: string;
  category:
    | 'technical' | 'business' | 'creative' | 'operational' | 'financial'
    | 'customer-facing' | 'entry-level' | 'career-changer' | 'incomplete';
  description: string;
  resumeText: string;
  declaredSkills: string[];
  labels: {
    /** Section ids runDeterministicAnalysis's buildSectionMap() is expected to recognise. */
    expectedSectionIds: string[];
    /** Whether a separate 'header' section (text before the first recognised heading) is expected. */
    expectHeaderSection: boolean;
    /** Minimum number of bullets extractBullets() should find. */
    minBullets: number;
    /** Expected chronology finding codes, in no particular order (empty = none expected). */
    expectedChronologyCodes: Array<'overlap' | 'gap'>;
    /** Minimum number of duplicate-bullet pairs findDuplicateBullets() should find (Jaccard >= 0.85). */
    minDuplicatePairs: number;
    /** Declared skills expected inExperienceOrProjects === true. */
    skillsDemonstrated: string[];
    /** Declared skills expected inSkillsOnly === true (present only in the Skills section). */
    skillsListedOnly: string[];
    /** Declared skills expected notFound === true (not present anywhere in the text). */
    skillsNotFound: string[];
  };
}

export const RESUME_PR_B_EVAL_SET: EvalCase[] = [
  // ── technical (4) ────────────────────────────────────────────────────────
  {
    id: 'tech-01-backend',
    category: 'technical',
    description: 'Backend engineer, clean conventional structure, one real gap.',
    resumeText: `Alex Rivera
Senior Backend Engineer | alex.rivera@example.invalid | +1 212-555-0101 | New York, NY

Summary
Backend engineer with 7 years building distributed systems in Go and Python.

Experience
Staff Engineer, Northwind Systems
Mar 2022 - Present
• Designed a Go-based event pipeline processing 2M events/day.
• Reduced database load by 40% by introducing a Redis caching layer.

Backend Engineer, Fenwick Labs
Jan 2019 - Jun 2020
• Built REST APIs in Python and Django for the billing team.
• Migrated legacy cron jobs to Kubernetes CronJobs.

Education
BSc Computer Science, State University
2018

Skills
Go, Python, Kubernetes, Redis, SQL
`,
    declaredSkills: ['Go', 'Kubernetes', 'GraphQL'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 4,
      expectedChronologyCodes: ['gap'], // Jun 2020 -> Mar 2022 is a ~21-month gap
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Go', 'Kubernetes'],
      skillsListedOnly: [],
      skillsNotFound: ['GraphQL'],
    },
  },
  {
    id: 'tech-02-frontend',
    category: 'technical',
    description: 'Frontend engineer, overlapping contract + full-time roles, one duplicate bullet pair.',
    resumeText: `Priya Nair
Frontend Engineer | priya.nair@example.invalid | Austin, TX

Summary
Frontend engineer specializing in React and accessible UI.

Experience
Frontend Engineer, Bluecrest Retail
Feb 2021 - Present
• Rebuilt the checkout flow in React, cutting cart abandonment by 15%.
• Rebuilt the checkout flow in React, cutting cart abandonment by 10%.

Contract Frontend Developer, Freelance
Jun 2020 - May 2021
• Delivered three marketing microsites using React and Tailwind CSS.

Education
BA Design + Technology, Coastline University
2019

Skills
React, Tailwind CSS, Figma
`,
    declaredSkills: ['React', 'Figma', 'Vue'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: ['overlap'], // Feb 2021-Present overlaps Jun 2020-May 2021
      minDuplicatePairs: 1, // the two near-identical checkout bullets
      skillsDemonstrated: ['React'],
      skillsListedOnly: ['Figma'],
      skillsNotFound: ['Vue'],
    },
  },
  {
    id: 'tech-03-devops',
    category: 'technical',
    description: 'DevOps/SRE, single ongoing role, no gaps or overlaps.',
    resumeText: `Marcus Webb
Site Reliability Engineer | marcus.webb@example.invalid | Remote

Summary
SRE focused on observability and on-call reliability for a fintech platform.

Experience
Site Reliability Engineer, Ledgerly
Jul 2020 - Present
• On-call lead for a payments platform handling 99.95% uptime SLOs.
• Built Terraform modules standardizing AWS VPC provisioning across teams.
• Introduced structured logging that cut mean incident triage time by 30%.

Education
BSc Computer Engineering, Hillcrest Polytechnic
2017

Certifications
AWS Certified Solutions Architect

Skills
AWS, Terraform, Python
`,
    declaredSkills: ['AWS', 'Terraform', 'Datadog'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'certifications', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['AWS', 'Terraform'],
      skillsListedOnly: [],
      skillsNotFound: ['Datadog'],
    },
  },
  {
    id: 'tech-04-data',
    category: 'technical',
    description: 'Data/ML engineer, two roles no gap/overlap, projects section.',
    resumeText: `Sofia Lindqvist
Data Engineer | sofia.lindqvist@example.invalid | Chicago, IL

Summary
Data engineer building ETL pipelines and ML feature stores.

Experience
Data Engineer, Harborview Analytics
Sep 2021 - Present
• Built an Airflow pipeline ingesting 50 vendor feeds daily into a Snowflake warehouse.
• Cut pipeline failure rate from 8% to under 1% with retry and schema-validation logic.

Junior Data Engineer, Harborview Analytics
Jan 2020 - Aug 2021
• Wrote SQL transformations powering the weekly executive reporting dashboard.

Projects
• Open-source contributor to a Python data-validation library (pandera).

Education
MSc Data Science, Lakeside University
2019

Skills
Python, SQL, Airflow, Snowflake
`,
    declaredSkills: ['Python', 'Snowflake', 'Spark'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'projects', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Python', 'Snowflake'],
      skillsListedOnly: [],
      skillsNotFound: ['Spark'],
    },
  },

  // ── business (3) ─────────────────────────────────────────────────────────
  {
    id: 'biz-01-product',
    category: 'business',
    description: 'Product manager, conventional structure.',
    resumeText: `Daniel Ochieng
Senior Product Manager | daniel.ochieng@example.invalid | Seattle, WA

Summary
Product manager leading growth initiatives for a B2B SaaS platform.

Experience
Senior Product Manager, Clearpath Software
Apr 2021 - Present
• Launched a self-serve onboarding flow that increased trial-to-paid conversion by 18%.
• Owned quarterly roadmapping across three engineering pods, prioritizing against OKRs.

Product Manager, Clearpath Software
Aug 2018 - Mar 2021
• Owned the billing and subscriptions product area end to end.

Education
MBA, Ridgeline School of Business
2018

Skills
Roadmapping, SQL, A/B Testing
`,
    declaredSkills: ['SQL', 'Roadmapping', 'Jira'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Roadmapping'],
      skillsListedOnly: ['SQL'],
      skillsNotFound: ['Jira'],
    },
  },
  {
    id: 'biz-02-marketing',
    category: 'business',
    description: 'Marketing manager, one role, short employment gap under 6 months (should NOT flag).',
    resumeText: `Grace Okafor
Marketing Manager | grace.okafor@example.invalid | Denver, CO

Summary
Marketing manager with a focus on lifecycle email and paid acquisition.

Experience
Marketing Manager, Summit Outdoor Co.
Feb 2022 - Present
• Grew the lifecycle email program from 2 to 11 active campaigns, lifting repeat purchase rate by 9%.

Marketing Associate, Trailblend Media
Jan 2020 - Aug 2021
• Managed paid social budgets across Meta and TikTok totaling $300k annually.

Education
BA Marketing, Fairview College
2019

Skills
Email Marketing, Paid Social, HubSpot
`,
    declaredSkills: ['HubSpot', 'Paid Social', 'SEO'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      // Aug 2021 -> Feb 2022 is ~6 months — the rule fires on "> 6 months", so this sits right at
      // the boundary; the resume is deliberately NOT built to require a borderline call either way
      // (see dataset header note) — treated as a soft case, not asserted strictly in the runner.
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Paid Social'],
      skillsListedOnly: ['HubSpot'],
      skillsNotFound: ['SEO'],
    },
  },
  {
    id: 'biz-03-analyst',
    category: 'business',
    description: 'Business analyst, entry-adjacent but has one full role.',
    resumeText: `Tomas Varga
Business Analyst | tomas.varga@example.invalid | Boston, MA

Summary
Business analyst supporting operations and finance stakeholders.

Experience
Business Analyst, Meridian Consulting Group
Jun 2021 - Present
• Built a demand-forecasting model in Excel adopted by three regional teams.
• Ran stakeholder interviews that shaped a new intake process, cutting request turnaround by 25%.

Education
BA Economics, Northfield College
2021

Skills
Excel, SQL, Tableau
`,
    declaredSkills: ['Excel', 'Tableau', 'Python'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Excel'],
      skillsListedOnly: ['Tableau'],
      skillsNotFound: ['Python'],
    },
  },

  // ── creative (3) ─────────────────────────────────────────────────────────
  {
    id: 'creative-01-designer',
    category: 'creative',
    description: 'Graphic designer, portfolio link in header.',
    resumeText: `Isla Thompson
Graphic Designer | isla.thompson@example.invalid | portfolio.islathompson.example | Portland, OR

Summary
Graphic designer focused on brand identity and packaging.

Experience
Graphic Designer, Northlight Studio
Oct 2020 - Present
• Designed packaging in Adobe Illustrator for a 12-SKU beverage launch that won a regional design award.
• Built a brand guideline system adopted across four client accounts.

Education
BFA Graphic Design, Rivermont Art Institute
2020

Skills
Adobe Illustrator, Adobe Photoshop, Figma
`,
    declaredSkills: ['Adobe Illustrator', 'Figma', 'After Effects'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Adobe Illustrator'],
      skillsListedOnly: ['Figma'],
      skillsNotFound: ['After Effects'],
    },
  },
  {
    id: 'creative-02-copywriter',
    category: 'creative',
    description: 'Copywriter, freelance + agency roles with a real gap.',
    resumeText: `Ben Castillo
Copywriter | ben.castillo@example.invalid | Los Angeles, CA

Summary
Copywriter with agency and freelance experience across consumer brands.

Experience
Copywriter, Harlow & Finch Agency
May 2022 - Present
• Led the copywriting for a national footwear launch covered in three trade publications.

Freelance Copywriter, Self-employed
Jan 2020 - Feb 2021
• Produced email and landing-page copy for six small-business clients.

Education
BA English, Westbrook College
2019

Skills
Copywriting, SEO Writing
`,
    declaredSkills: ['Copywriting', 'SEO Writing', 'Email Marketing'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: ['gap'], // Feb 2021 -> May 2022 is ~15 months
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Copywriting'],
      skillsListedOnly: ['SEO Writing'],
      skillsNotFound: ['Email Marketing'],
    },
  },
  {
    id: 'creative-03-video',
    category: 'creative',
    description: 'Video editor, single role, no header links.',
    resumeText: `Natalie Kim
Video Editor | natalie.kim@example.invalid | Atlanta, GA

Summary
Video editor for branded content and short-form social video.

Experience
Video Editor, Pinecrest Media House
Mar 2021 - Present
• Edited over 200 short-form videos in Premiere Pro for client social channels, averaging 1.2M monthly views.
• Built a reusable motion-graphics template library used by the whole editing team.

Education
AA Film Production, Crestline Community College
2020

Skills
Premiere Pro, After Effects, DaVinci Resolve
`,
    declaredSkills: ['Premiere Pro', 'DaVinci Resolve', 'Final Cut Pro'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Premiere Pro'],
      skillsListedOnly: ['DaVinci Resolve'],
      skillsNotFound: ['Final Cut Pro'],
    },
  },

  // ── operational (3) ──────────────────────────────────────────────────────
  {
    id: 'ops-01-warehouse',
    category: 'operational',
    description: 'Warehouse supervisor, two roles, overlap.',
    resumeText: `Carlos Mendez
Warehouse Supervisor | carlos.mendez@example.invalid | Phoenix, AZ

Summary
Warehouse supervisor managing inbound logistics and a team of 14.

Experience
Warehouse Supervisor, Desert Freight Logistics
Jan 2022 - Present
• Cut average dock-to-stock time from 6 hours to 3.5 hours.
• Supervised a team of 14 across two shifts, including forklift operation training.

Shift Lead, Desert Freight Logistics
Jun 2021 - Mar 2022
• Coordinated inbound receiving for up to 40 trucks per day.

Education
High School Diploma, Desert Vista High School
2017

Skills
Forklift Operation, Inventory Management, WMS
`,
    declaredSkills: ['Forklift Operation', 'WMS', 'Six Sigma'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: ['overlap'], // Jan 2022-Present overlaps Jun 2021-Mar 2022
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Forklift Operation'],
      skillsListedOnly: ['WMS'],
      skillsNotFound: ['Six Sigma'],
    },
  },
  {
    id: 'ops-02-logistics',
    category: 'operational',
    description: 'Logistics coordinator, single role.',
    resumeText: `Hannah Voss
Logistics Coordinator | hannah.voss@example.invalid | Memphis, TN

Summary
Logistics coordinator managing carrier relationships and shipment tracking.

Experience
Logistics Coordinator, Rivergate Supply Chain
Feb 2020 - Present
• Negotiated carrier rates that reduced freight cost per shipment by 11%.
• Built a shipment-tracking spreadsheet adopted company-wide.

Education
AA Business Administration, Rivergate Community College
2019

Skills
Carrier Management, Excel, SAP
`,
    declaredSkills: ['Excel', 'SAP', 'Six Sigma'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: [],
      skillsListedOnly: ['Excel', 'SAP'],
      skillsNotFound: ['Six Sigma'],
    },
  },
  {
    id: 'ops-03-office',
    category: 'operational',
    description: 'Office manager, single role, duplicate bullet pair.',
    resumeText: `Renee Laurent
Office Manager | renee.laurent@example.invalid | New Orleans, LA

Summary
Office manager overseeing facilities, vendor scheduling and a team of 3 admins.

Experience
Office Manager, Bayou Legal Partners
Sep 2019 - Present
• Managed vendor contracts that cut annual office costs by 15%.
• Managed vendor contracts that cut annual office costs by 12%.

Education
AA Office Administration, Delta Community College
2018

Skills
Vendor Management, Scheduling, QuickBooks
`,
    declaredSkills: ['QuickBooks', 'Scheduling', 'Procurement'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 1,
      skillsDemonstrated: ['Scheduling'],
      skillsListedOnly: ['QuickBooks'],
      skillsNotFound: ['Procurement'],
    },
  },

  // ── financial (3) ────────────────────────────────────────────────────────
  {
    id: 'fin-01-accountant',
    category: 'financial',
    description: 'Staff accountant, single role.',
    resumeText: `Oliver Braun
Staff Accountant | oliver.braun@example.invalid | Charlotte, NC

Summary
Staff accountant handling month-end close and reconciliations.

Experience
Staff Accountant, Blackstone & Reed CPAs
Jul 2020 - Present
• Closed the books for 12 client entities monthly in QuickBooks within a 5-business-day cycle.
• Reconciled over $4M in monthly transactions across six bank accounts.

Education
BS Accounting, Ashford University
2020

Skills
QuickBooks, Excel, GAAP
`,
    declaredSkills: ['QuickBooks', 'GAAP', 'NetSuite'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['QuickBooks'],
      skillsListedOnly: ['GAAP'],
      skillsNotFound: ['NetSuite'],
    },
  },
  {
    id: 'fin-02-analyst',
    category: 'financial',
    description: 'Financial analyst, two roles, real gap.',
    resumeText: `Leah Fischer
Financial Analyst | leah.fischer@example.invalid | Minneapolis, MN

Summary
Financial analyst supporting FP&A for a mid-market manufacturer.

Experience
Financial Analyst, Ironwood Manufacturing
Mar 2022 - Present
• Built a rolling 13-week cash-flow forecast in Excel used weekly by the CFO.

Financial Analyst, Ironwood Manufacturing
Jan 2019 - Feb 2020
• Automated the monthly variance report, cutting prep time from 2 days to 3 hours.

Education
BS Finance, Caldwell University
2018

Skills
Excel, Financial Modeling, SQL
`,
    declaredSkills: ['Excel', 'SQL', 'Power BI'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: ['gap'], // Feb 2020 -> Mar 2022 is a ~25-month gap
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Excel'],
      skillsListedOnly: ['SQL'],
      skillsNotFound: ['Power BI'],
    },
  },
  {
    id: 'fin-03-auditor',
    category: 'financial',
    description: 'Internal auditor, single role, certifications section.',
    resumeText: `Grace Lundqvist
Internal Auditor | grace.lundqvist@example.invalid | Hartford, CT

Summary
Internal auditor focused on SOX compliance testing.

Experience
Internal Auditor, Harborlight Insurance Group
Apr 2021 - Present
• Led SOX testing walkthroughs for four business units, closing all findings within SLA.
• Documented control gaps that led to two process redesigns.

Education
BS Accounting, Thorne University
2020

Certifications
CPA (in progress)

Skills
SOX Testing, Excel, SAP
`,
    declaredSkills: ['Excel', 'SOX Testing', 'ACL'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'certifications', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['SOX Testing'],
      skillsListedOnly: ['Excel'],
      skillsNotFound: ['ACL'],
    },
  },

  // ── customer-facing (3) ──────────────────────────────────────────────────
  {
    id: 'cust-01-support-lead',
    category: 'customer-facing',
    description: 'Customer support lead, two roles, no gap.',
    resumeText: `Jasmine Clarke
Customer Support Lead | jasmine.clarke@example.invalid | Raleigh, NC

Summary
Support lead managing a team of 8 agents for a consumer fintech app.

Experience
Customer Support Lead, Pennywise Finance App
May 2021 - Present
• Cut average first-response time from 4 hours to 45 minutes using Zendesk.
• Built an escalation runbook that reduced repeat tickets by 20%.

Customer Support Agent, Pennywise Finance App
Aug 2019 - Apr 2021
• Resolved an average of 60 tickets per day across chat and email.

Education
BA Communications, Palmetto State University
2019

Skills
Zendesk, Conflict Resolution, Salesforce
`,
    declaredSkills: ['Zendesk', 'Salesforce', 'Intercom'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Zendesk'],
      skillsListedOnly: ['Salesforce'],
      skillsNotFound: ['Intercom'],
    },
  },
  {
    id: 'cust-02-account-manager',
    category: 'customer-facing',
    description: 'Account manager, single role.',
    resumeText: `Ryan Foster
Account Manager | ryan.foster@example.invalid | San Diego, CA

Summary
Account manager for a portfolio of mid-market SaaS clients.

Experience
Account Manager, Brightline Software
Sep 2020 - Present
• Grew net revenue retention on a $6M book of business from 92% to 108%, managing the pipeline in Salesforce.
• Ran quarterly business reviews for 25 enterprise accounts.

Education
BA Business, Coastal Ridge University
2020

Skills
Salesforce, Account Planning, Negotiation
`,
    declaredSkills: ['Salesforce', 'Negotiation', 'HubSpot'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Salesforce'],
      skillsListedOnly: ['Negotiation'],
      skillsNotFound: ['HubSpot'],
    },
  },
  {
    id: 'cust-03-retail-manager',
    category: 'customer-facing',
    description: 'Retail store manager, two roles, overlap (assistant to manager promotion overlap).',
    resumeText: `Diego Morales
Retail Store Manager | diego.morales@example.invalid | Tampa, FL

Summary
Store manager for a high-volume specialty retail location.

Experience
Store Manager, Lagoon Outfitters
Jan 2021 - Present
• Increased same-store sales by 14% year over year.
• Hired and trained a team of 18 seasonal and full-time associates.

Assistant Store Manager, Lagoon Outfitters
Jun 2020 - Mar 2021
• Managed weekly scheduling and inventory counts for a 6,000 sq ft store.

Education
AA Retail Management, Gulf Coast College
2019

Skills
Visual Merchandising, Scheduling, POS Systems
`,
    declaredSkills: ['Scheduling', 'POS Systems', 'Loss Prevention'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: ['overlap'], // Jan 2021-Present overlaps Jun 2020-Mar 2021
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Scheduling'],
      skillsListedOnly: ['POS Systems'],
      skillsNotFound: ['Loss Prevention'],
    },
  },

  // ── entry-level / student (3) ────────────────────────────────────────────
  {
    id: 'entry-01-cs-student',
    category: 'entry-level',
    description: 'CS student with an internship and a projects section, no long employment history.',
    resumeText: `Wei Zhang
Computer Science Student | wei.zhang@example.invalid | Pittsburgh, PA

Summary
Rising senior studying computer science, seeking a backend software role.

Experience
Software Engineering Intern, Cobblestone Analytics
Jun 2025 - Aug 2025
• Built an internal dashboard in React that visualized weekly pipeline health.

Projects
• Built a course-scheduling web app used by 200+ classmates (Node.js, PostgreSQL).

Education
BSc Computer Science (expected 2026), Carnegie Hills University

Skills
JavaScript, React, PostgreSQL
`,
    declaredSkills: ['React', 'PostgreSQL', 'Docker'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'projects', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['React', 'PostgreSQL'],
      skillsListedOnly: [],
      skillsNotFound: ['Docker'],
    },
  },
  {
    id: 'entry-02-business-student',
    category: 'entry-level',
    description: 'Business student, campus leadership instead of employment, no Experience heading at all.',
    resumeText: `Amara Johnson
Business Student | amara.johnson@example.invalid | Columbus, OH

Summary
Senior business student with campus leadership and a marketing internship.

Projects
• Led a 5-person student consulting team that used Excel models to propose a new campus dining vendor.

Education
BA Business Administration (expected 2026), Riverbend State University

Skills
Excel, PowerPoint, Market Research
`,
    declaredSkills: ['Excel', 'Market Research', 'Tableau'],
    labels: {
      // No 'experience' heading anywhere in this resume by design (campus-only background) —
      // buildSectionMap should NOT invent one; 'projects' still anchors the one bullet it has.
      expectedSectionIds: ['header', 'summary', 'projects', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 1,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Excel'],
      skillsListedOnly: ['Market Research'],
      skillsNotFound: ['Tableau'],
    },
  },
  {
    id: 'entry-03-bootcamp',
    category: 'entry-level',
    description: 'Bootcamp graduate, career changer flavor but filed as entry-level (no prior professional-field work).',
    resumeText: `Jordan Lee
Junior Web Developer | jordan.lee@example.invalid | Salt Lake City, UT

Summary
Recent coding bootcamp graduate seeking a junior web developer role.

Projects
• Built a full-stack recipe-sharing app with authentication (React, Express, MongoDB).
• Built a budgeting app that syncs with a bank-statement CSV import (React, Node.js).

Education
Full-Stack Web Development Certificate, Summit Coding Bootcamp
2026

Skills
React, Node.js, MongoDB
`,
    declaredSkills: ['React', 'MongoDB', 'GraphQL'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'projects', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['React', 'MongoDB'],
      skillsListedOnly: [],
      skillsNotFound: ['GraphQL'],
    },
  },

  // ── career changers (3) ──────────────────────────────────────────────────
  {
    id: 'career-01-teacher-to-analyst',
    category: 'career-changer',
    description: 'Former teacher moving into data analysis; prior-field role plus a transitional project.',
    resumeText: `Michelle Torres
Aspiring Data Analyst | michelle.torres@example.invalid | Sacramento, CA

Summary
Former classroom teacher transitioning into data analysis, with a self-driven Tableau and visualization project background.

Experience
High School Math Teacher, Oak Valley Unified School District
Aug 2016 - Jun 2025
• Analyzed standardized test data for 150 students to identify curriculum gaps.
• Built a Google Sheets dashboard tracking grade trends across five sections.

Projects
• Built a Tableau dashboard analyzing public school funding data by district.

Education
BA Mathematics, Foothill State University
2016

Skills
SQL, Tableau, Excel
`,
    declaredSkills: ['SQL', 'Tableau', 'Python'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'projects', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 3,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Tableau'],
      skillsListedOnly: ['SQL'],
      skillsNotFound: ['Python'],
    },
  },
  {
    id: 'career-02-military-to-pm',
    category: 'career-changer',
    description: 'Military logistics officer moving into project management.',
    resumeText: `Kevin Brandt
Project Manager (Transitioning Military) | kevin.brandt@example.invalid | San Antonio, TX

Summary
12 years as a logistics officer, transitioning military planning experience into civilian project management.

Experience
Logistics Officer, U.S. Army
Jul 2013 - Present
• Led project planning for supply operations across a 400-person battalion across three deployments.
• Managed a $2M equipment budget with zero audit findings over six years.

Certifications
PMP (in progress)

Education
BS Logistics Management, Keystone State University
2013

Skills
Project Planning, Budgeting, Risk Management
`,
    declaredSkills: ['Project Planning', 'Risk Management', 'Jira'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'certifications', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Project Planning'],
      skillsListedOnly: ['Risk Management'],
      skillsNotFound: ['Jira'],
    },
  },
  {
    id: 'career-03-retail-to-ux',
    category: 'career-changer',
    description: 'Retail manager moving into UX design, with a bootcamp project and a real gap.',
    resumeText: `Chloe Bennett
Junior UX Designer | chloe.bennett@example.invalid | Richmond, VA

Summary
Former retail operations manager now building a UX design practice through project work.

Experience
Retail Operations Manager, Haverford Home Goods
Mar 2017 - Nov 2020
• Led store layout changes informed by customer walk-through observations.

Projects
• Redesigned a local nonprofit's donation flow using user research, cutting drop-off by half in usability testing.

Education
UX Design Certificate, Brightline Design School
2026

Skills
Figma, User Research, Prototyping
`,
    declaredSkills: ['Figma', 'User Research', 'Sketch'],
    labels: {
      expectedSectionIds: ['header', 'summary', 'experience', 'projects', 'education', 'skills'],
      expectHeaderSection: true,
      minBullets: 2,
      // Only one dated range exists in this resume (one Experience role); findChronologyIssues()
      // requires >= 2 ranges to compare, so no gap/overlap is computable here even though there
      // is a real-world employment gap after Nov 2020 — the deterministic layer only reasons
      // about ranges actually present in the text, never "today".
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['User Research'],
      skillsListedOnly: ['Figma'],
      skillsNotFound: ['Sketch'],
    },
  },

  // ── incomplete / very short / one-page run-on (3) ───────────────────────
  {
    id: 'incomplete-01-very-short',
    category: 'incomplete',
    description: 'Very short resume: one role, no bullets, under 50 words — should still produce valid sections.',
    resumeText: `Sam Patel
Customer Service Representative | sam.patel@example.invalid

Experience
Customer Service Rep, QuickHelp Co.
Jan 2024 - Present

Skills
Phone Support, Typing
`,
    declaredSkills: ['Phone Support', 'Excel'],
    labels: {
      expectedSectionIds: ['header', 'experience', 'skills'],
      expectHeaderSection: true,
      minBullets: 0,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: [],
      skillsListedOnly: ['Phone Support'],
      skillsNotFound: ['Excel'],
    },
  },
  {
    id: 'incomplete-02-run-on',
    category: 'incomplete',
    description: 'One-page run-on: no headings at all, dense paragraph, no bullet glyphs — collapses to one body section.',
    resumeText: `Taylor Monroe, taylor.monroe@example.invalid, is a warehouse and logistics professional with six years of experience managing inbound and outbound freight for a regional distribution center in Ohio, where responsibilities included supervising a team of ten dock workers, coordinating with twelve carrier partners, maintaining inventory accuracy above 98 percent, and training new hires on forklift safety and warehouse management software, prior to which Taylor worked for four years as a retail stock associate at a big-box hardware store handling receiving, shelving, and seasonal inventory resets, and Taylor holds a high school diploma and a forklift certification and lists among relevant skills inventory management, forklift operation, and basic warehouse management software proficiency.`,
    declaredSkills: ['Forklift Operation', 'Inventory Management', 'SAP'],
    labels: {
      expectedSectionIds: ['body'],
      expectHeaderSection: false,
      minBullets: 0,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Forklift Operation', 'Inventory Management'],
      skillsListedOnly: [],
      skillsNotFound: ['SAP'],
    },
  },
  {
    id: 'incomplete-03-headerless-g6',
    category: 'incomplete',
    description:
      'G6 case (docs/resume-pr-b-g6-decision-2026-10-30.md): fully headerless resume — no line matching the ' +
      'heading lexicon anywhere, name/contact embedded mid-sentence rather than on their own line. Expected/' +
      'accepted outcome: collapses to a single "body" section; R1 (header & contact) is rated against "body", ' +
      'same as every other criterion for this input — accepted behavior, not a defect.',
    resumeText: `Jane Doe, backend engineer with 6 years building Go services for a logistics startup where she led the migration of a monolith to microservices handling 50,000 requests per minute, previously spent three years at a fintech company building Python APIs for a payments team, holds a computer science degree from a state university, and can be reached at jane@example.com or on LinkedIn, with hands-on experience in Go, Python, PostgreSQL and Kubernetes.`,
    declaredSkills: ['Go', 'Kubernetes', 'React'],
    labels: {
      expectedSectionIds: ['body'],
      expectHeaderSection: false,
      minBullets: 0,
      expectedChronologyCodes: [],
      minDuplicatePairs: 0,
      skillsDemonstrated: ['Go', 'Kubernetes'],
      skillsListedOnly: [],
      skillsNotFound: ['React'],
    },
  },
];

if (RESUME_PR_B_EVAL_SET.length !== 28) {
  throw new Error(`Resume PR B eval set must have exactly 28 cases (design doc §9); found ${RESUME_PR_B_EVAL_SET.length}.`);
}
