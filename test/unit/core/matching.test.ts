import { describe, expect, it } from 'vitest';
import { profiles } from '../../../config/profiles';
import { evaluateEligibility } from '../../../src/core/eligibility';
import { normalizeSalary } from '../../../src/core/salary';
import { classifySeniority, extractMinYears } from '../../../src/core/seniority';
import { containsTerm, extractSkills, normalizeForMatch } from '../../../src/core/skills';

const profile = profiles[0]!;
const NOW = Date.parse('2026-11-10T10:00:00Z');

describe('skills — whole-word matching (§6.3)', () => {
  it('Java does not match JavaScript; Go does not match Google', () => {
    expect(containsTerm(normalizeForMatch('Senior JavaScript dev'), 'java')).toBe(false);
    expect(containsTerm(normalizeForMatch('Work at Google'), 'go')).toBe(false);
    expect(containsTerm(normalizeForMatch('Java and Go'), 'go')).toBe(true);
  });

  it('matches node aliases and hyphen variants', () => {
    const s = extractSkills(normalizeForMatch('We use Node.js, NestJS, Postgres and Redis on AWS'));
    expect([...s].sort()).toEqual(['aws', 'nestjs', 'node', 'postgresql', 'redis']);
    expect(containsTerm(normalizeForMatch('Back End Engineer'), 'back-end')).toBe(true);
  });

  it('accepts ts only in unambiguous context', () => {
    expect(extractSkills(normalizeForMatch('We like ts')).has('typescript')).toBe(false);
    expect(extractSkills(normalizeForMatch('Strong JS/TS skills')).has('typescript')).toBe(true);
    expect(extractSkills('', ['ts']).has('typescript')).toBe(true);
  });

  it('matches Arabic titles', () => {
    expect(containsTerm(normalizeForMatch('مطور باك اند Node'), 'مطور باك اند')).toBe(true);
  });
});

describe('seniority (§6.2)', () => {
  it.each([
    ['Senior Backend Engineer', true],
    ['Sr. Node Developer', true],
    ['Backend Tech Lead', true],
    ['Engineering Manager, Backend', true],
    ['Backend Engineer', false],
    ['Junior Node.js Developer', false],
  ])('%s → clearlySenior=%s', (title, expected) => {
    expect(classifySeniority(title).clearlySenior).toBe(expected);
  });

  it('does not reject a non-people "manager" title', () => {
    expect(classifySeniority('API Platform Manager').clearlySenior).toBe(false);
  });

  it('uses the lowest source hint', () => {
    expect(classifySeniority('Backend Engineer', ['Mid-level', 'Senior']).level).toBe('mid');
  });
});

describe('extractMinYears', () => {
  it('reads ranges by their lower bound', () => {
    expect(extractMinYears('We need 2-4 years of experience with Node')).toBe(2);
  });
  it('takes the strictest stated minimum', () => {
    expect(extractMinYears('3+ years Node experience and at least 5 years of professional experience')).toBe(5);
  });
  it('ignores numbers unrelated to experience', () => {
    expect(extractMinYears('Founded 10 years ago, we serve 5 years of data')).toBeUndefined();
  });
  it('reads Arabic', () => {
    expect(extractMinYears('خبرة 3 سنوات في Node')).toBe(3);
  });
});

describe('eligibility (§6.2)', () => {
  const ev = (input: Parameters<typeof evaluateEligibility>[0]) => evaluateEligibility(input, profile, NOW);

  it('accepts Egypt on-site', () => {
    expect(ev({ location: 'Cairo, Egypt', remote: false }).status).toBe('ELIGIBLE');
  });
  it('accepts worldwide / EMEA remote', () => {
    expect(ev({ location: 'Remote - Worldwide', remote: true }).status).toBe('ELIGIBLE');
    expect(ev({ locationRestrictions: ['EMEA'] }).remoteScope).toBe('Remote (EMEA)');
  });
  it('rejects explicit US-only', () => {
    expect(ev({ location: 'Remote', remote: true, description: 'This role is US only.' }).status).toBe('EXCLUDED');
    expect(ev({ location: 'Remote', description: 'Candidates must be located in the United States' }).status).toBe('EXCLUDED');
    expect(ev({ location: 'Remote, Canada; Remote, United States' }).status).toBe('EXCLUDED');
  });
  it('does not treat lowercase "us only" as a place', () => {
    expect(ev({ location: 'Remote', remote: true, description: 'Contact us only via the form.' }).status).toBe('UNKNOWN');
  });
  it('rejects restriction lists without Egypt, accepts lists with it', () => {
    expect(ev({ locationRestrictions: ['Sri Lanka'] }).status).toBe('EXCLUDED');
    expect(ev({ locationRestrictions: ['Egypt', 'India'] }).status).toBe('ELIGIBLE');
  });
  it('keeps unknown remote as UNKNOWN, not rejected', () => {
    expect(ev({ location: 'Remote', remote: true }).status).toBe('UNKNOWN');
    expect(ev({}).status).toBe('UNKNOWN');
  });
  it('rejects on-site outside Egypt only with clear evidence', () => {
    expect(ev({ location: 'Berlin', countryCode: 'DE', remote: false }).status).toBe('EXCLUDED');
    expect(ev({ location: 'San Francisco, CA', remote: false }).status).toBe('EXCLUDED');
    expect(ev({ location: 'Zagazig' }).status).toBe('ELIGIBLE');
  });
  it('applies timezone overlap', () => {
    expect(ev({ timezoneOffsets: [-8] }).status).toBe('EXCLUDED');
    expect(ev({ timezoneOffsets: [1] }).status).toBe('UNKNOWN');
  });
  it('lets an explicit EMEA mention override a US mention', () => {
    expect(ev({ location: 'Remote - US or EMEA', remote: true }).status).toBe('ELIGIBLE');
  });

  describe('Gulf and MENA (owner decision 2026-11-11)', () => {
    it.each([
      ['Riyadh, Saudi Arabia', 'SA'],
      ['Dubai, United Arab Emirates (Hybrid)', 'AE'],
      ['Abu Dhabi', 'AE'],
      ['Doha, Qatar', 'QA'],
      ['Kuwait City', 'KW'],
      ['Manama, Bahrain', 'BH'],
      ['Muscat, Oman', 'OM'],
      ['Amman, Jordan', 'JO'],
      ['Casablanca, Morocco', 'MA'],
      ['Tunis, Tunisia', 'TN'],
      ['الرياض، السعودية', 'SA'],
      ['دبي، الإمارات', 'AE'],
    ])('accepts on-site/hybrid in %s', (location, code) => {
      const r = ev({ location, remote: false });
      expect(r).toMatchObject({ status: 'ELIGIBLE', eligibleRegions: [code] });
    });

    it('accepts ISO country codes and Gulf/GCC remote scopes', () => {
      expect(ev({ location: 'Office', countryCode: 'sa' }).status).toBe('ELIGIBLE');
      expect(ev({ location: 'Remote - GCC', remote: true }).remoteScope).toBe('Remote (MENA)');
      expect(ev({ locationRestrictions: ['Gulf region'] }).status).toBe('ELIGIBLE');
    });

    it.each([
      [{ title: 'Backend Developer (Saudi Nationals Only)', location: 'Riyadh' }],
      [{ location: 'Riyadh, Saudi Arabia', description: 'This position is only open to Saudi nationals.' }],
      [{ location: 'Dubai', description: 'UAE Nationals are required for this Emiratisation role.' }],
      [{ location: 'Jeddah', description: 'Saudization position for fresh graduates.' }],
      [{ location: 'الرياض', description: 'الوظيفة للسعوديين فقط' }],
      [{ location: 'الرياض', description: 'أن يكون سعودي الجنسية' }],
    ])('rejects citizens-only roles even in accepted countries: %o', (input) => {
      expect(ev(input)).toMatchObject({ status: 'EXCLUDED', reason: expect.stringMatching(/^nationals only/) });
    });

    it('does not mistake "Saudi nationals preferred" or company names for restrictions', () => {
      expect(ev({ location: 'Riyadh', description: 'Saudi nationals preferred; all nationalities welcome.' }).status).toBe('ELIGIBLE');
      expect(ev({ location: 'Dubai', description: 'Work with Emirates NBD and Saudi Aramco clients.' }).status).toBe('ELIGIBLE');
    });

    it('still rejects on-site outside the accepted countries', () => {
      expect(ev({ location: 'Istanbul, Turkey', remote: false }).status).toBe('EXCLUDED');
      // Live dry run 2026-11-11: an Ashby posting in Sofia was UNKNOWN, not EXCLUDED.
      expect(ev({ location: 'Sofia, Bulgaria', remote: false }).status).toBe('EXCLUDED');
      expect(ev({ location: 'Belgrade', remote: false }).status).toBe('EXCLUDED');
      // Remote flag not provided by the feed (Ashby/Workable/Greenhouse leave it unset).
      expect(ev({ location: 'Sofia, Bulgaria' }).status).toBe('EXCLUDED');
      expect(ev({ location: 'Sofia, Bulgaria; Cairo, Egypt' }).status).toBe('ELIGIBLE');
      expect(ev({ location: 'Remote - Serbia', remote: true }).status).toBe('EXCLUDED');
      expect(ev({ location: 'London', countryCode: 'GB', remote: false }).status).toBe('EXCLUDED');
    });
  });
});

describe('salary (§6.3)', () => {
  it('normalises annual USD to monthly and converts USD only', () => {
    const s = normalizeSalary({ min: 60000, max: 84000, currency: 'usd', period: 'year', origin: 'employer' });
    expect(s).toMatchObject({ monthlyMin: 5000, monthlyMax: 7000, usdMonthlyMin: 5000, usdMonthlyMax: 7000 });
  });
  it('does not guess exchange rates', () => {
    const s = normalizeSalary({ min: 30000, currency: 'EGP', period: 'month', origin: 'wuzzuf' });
    expect(s?.usdMonthlyMin).toBeUndefined();
    expect(s?.monthlyMin).toBe(30000);
  });
  it('drops implausible or sentinel values', () => {
    expect(normalizeSalary({ min: 0, max: 0, currency: 'USD', period: 'year', origin: 'x' })).toBeUndefined();
    expect(normalizeSalary({ min: 30, max: 30, currency: 'USD', period: 'year', origin: 'x' })).toBeUndefined();
    expect(normalizeSalary({ min: 114000000, currency: 'USD', period: 'year', origin: 'x' })).toBeUndefined();
  });
});
