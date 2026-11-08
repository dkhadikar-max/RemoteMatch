/** Escape Postgres LIKE metacharacters so user input is matched literally. */
export function escapeLikeWildcards(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
