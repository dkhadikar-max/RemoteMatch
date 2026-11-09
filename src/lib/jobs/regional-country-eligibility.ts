const EU_EEA_COUNTRIES = new Set([
  'austria','belgium','bulgaria','croatia','cyprus','czechia','czech republic','denmark',
  'estonia','finland','france','germany','greece','hungary','ireland','italy','latvia',
  'lithuania','luxembourg','malta','netherlands','poland','portugal','romania','slovakia',
  'slovenia','spain','sweden','iceland','liechtenstein','norway',
]);

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ');
}

/** True when a country is included by an EU, EEA, or combined EU/EEA listing. */
export function matchesEuEeaEligibility(eligible: string[], countryVariants: Set<string>): boolean {
  const regions = new Set(eligible.map(normalized));
  if (!regions.has('eu') && !regions.has('eea') && !regions.has('eu eea') && !regions.has('eu/eea')) {
    return false;
  }
  return Array.from(countryVariants).some((country) => EU_EEA_COUNTRIES.has(normalized(country)));
}
