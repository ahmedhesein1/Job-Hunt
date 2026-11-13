/**
 * §5.1 robots.txt support for website-hosted feeds. robots.txt is not a substitute for
 * terms of use; it is an additional gate.
 */
interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  /** Seconds between requests requested by the site (non-standard but widely used). */
  crawlDelay?: number | undefined;
}

export interface RobotsRules {
  groups: Group[];
}

export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) current.crawlDelay = seconds;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "allow everything".
      if (value === '' && field === 'disallow') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return { groups };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function applicableGroups(rules: RobotsRules, userAgent: string): Group[] {
  const product = userAgent.split('/')[0]?.toLowerCase() ?? '';
  const specific = rules.groups.filter((g) => g.agents.some((a) => a !== '*' && product.includes(a)));
  return specific.length > 0 ? specific : rules.groups.filter((g) => g.agents.includes('*'));
}

/** The site's requested delay between requests, in seconds, if any. */
export function crawlDelaySeconds(rules: RobotsRules, userAgent: string): number | undefined {
  const delays = applicableGroups(rules, userAgent)
    .map((g) => g.crawlDelay)
    .filter((d): d is number => d !== undefined);
  return delays.length ? Math.max(...delays) : undefined;
}

/** Longest matching rule wins; Allow wins ties (RFC 9309). */
export function isAllowed(rules: RobotsRules, userAgent: string, pathWithQuery: string): boolean {
  const applicable = applicableGroups(rules, userAgent);
  let best: Rule | undefined;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (!patternToRegex(rule.pattern).test(pathWithQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}
