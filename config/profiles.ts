export type Seniority = 'intern' | 'junior' | 'mid' | 'senior';
export type RemoteRegion = 'WORLDWIDE' | 'EMEA' | 'AFRICA' | 'MENA';

export interface SearchProfile {
  id: string;
  titleInclude: string[];
  titleExclude: string[];
  mustHaveSkills: string[];
  niceSkills: string[];
  seniority: { accept: Seniority[]; maxYears: number };
  locations: {
    /** ISO alpha-2 countries where on-site/hybrid work is acceptable. */
    countries: string[];
    remoteRegions: RemoteRegion[];
    minTzOverlapHours: number;
  };
  minSalaryUsdMonth: number | undefined;
}

export const profiles: SearchProfile[] = [
  {
    id: 'backend-node',
    titleInclude: [
      'backend', 'back-end', 'node', 'nodejs', 'node.js', 'nestjs',
      'api engineer', 'server-side',
      // Owner decision 2026-11-11: full-stack roles too (Node still required in the description).
      'full stack', 'full-stack', 'fullstack',
      // Owner decision 2026-11-11: generic engineering titles, kept relevant by the Node
      // must-have check on the description.
      'software engineer', 'software developer', 'product engineer', 'platform engineer',
      // Owner decision 2026-11-11: every backend-related title family. Broad ones
      // (programmer, web developer) stay relevant through the Node must-have check.
      'programmer', 'software development engineer', 'sde', 'swe', 'application developer',
      'web developer', 'web engineer', 'javascript developer', 'javascript engineer',
      'typescript developer', 'typescript engineer', 'js developer', 'express.js', 'expressjs',
      'mern', 'mean stack', 'microservices', 'integration engineer',
      // §6.3: Arabic title aliases (Wuzzuf, LinkedIn Arabic UI).
      'مطور باك اند', 'مهندس باك اند', 'مبرمج', 'مطور برمجيات', 'مهندس برمجيات', 'مطور ويب',
      'مطور فول ستاك', 'مطور full stack', 'مطور node', 'مطور خلفية',
    ],
    titleExclude: [
      'frontend', 'front-end', 'ios', 'android', 'flutter',
      'react native', 'qa', 'sales', 'data scientist',
    ],
    mustHaveSkills: ['node'],
    niceSkills: [
      'typescript', 'nestjs', 'postgresql', 'redis', 'docker',
      'aws', 'kafka', 'grpc',
    ],
    // Owner decision 2026-11-11: senior roles accepted; leadership (lead/staff/principal/
    // head/architect/manager) is still rejected.
    seniority: { accept: ['junior', 'mid', 'senior'], maxYears: 7 },
    locations: {
      // Owner decision 2026-11-13: on-site/hybrid in Egypt only (the owner lives there).
      // Other countries, Gulf and MENA included, are accepted only as remote roles.
      countries: ['EG'],
      remoteRegions: ['WORLDWIDE', 'EMEA', 'AFRICA', 'MENA'],
      minTzOverlapHours: 4,
    },
    minSalaryUsdMonth: undefined,
  },
];

export const cvSkills = [
  'node', 'typescript', 'nestjs', 'postgresql', 'redis', 'docker', 'grpc',
];

/**
 * Dated exchange rates to USD (§6.3: never silently guess a rate). Empty means only
 * USD salaries are converted; others keep their original currency.
 */
export const exchangeRates: { asOf: string | undefined; toUsd: Record<string, number> } = {
  asOf: undefined,
  toUsd: {},
};
