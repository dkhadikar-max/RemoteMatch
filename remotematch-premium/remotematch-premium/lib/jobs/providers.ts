export type RemoteJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  salary?: string;
  tags: string[];
  source: string;
  officialUrl: string;
};

export interface JobProvider {
  id: string;
  label: string;
  fetchJobs(): Promise<RemoteJob[]>;
}

export const providerPlugins = [
  { id: "curated", label: "Curated", status: "active" },
  { id: "remotive", label: "Remotive", status: "active" },
  { id: "arbeitnow", label: "Arbeitnow", status: "active" },
  { id: "jobicy", label: "Jobicy", status: "ready" },
  { id: "remoteok", label: "RemoteOK", status: "ready" }
] as const;

/**
 * Keep ingestion source-specific and normalize into the BYN Opportunity model.
 * Add providers here without coupling the UI to external APIs.
 */
export function normalizeJob(input: Partial<RemoteJob> & Pick<RemoteJob, "id" | "title" | "company">): RemoteJob {
  return {
    id: input.id,
    title: input.title,
    company: input.company,
    location: input.location ?? "Worldwide",
    salary: input.salary,
    tags: input.tags ?? [],
    source: input.source ?? "curated",
    officialUrl: input.officialUrl ?? "#"
  };
}
