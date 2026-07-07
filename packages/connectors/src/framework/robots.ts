/**
 * Minimal robots.txt support for the crawler connectors.
 *
 * We only need prefix/wildcard rule matching for a single path per store
 * (`/products.json`), so this implements the common subset of REP:
 * user-agent groups, Allow/Disallow with `*` wildcards and `$` end anchors,
 * longest-match-wins (Allow wins ties). Unreachable/missing robots.txt is
 * treated as "allowed" (standard for 404; we extend it to network errors to
 * stay dev-friendly — see docs/decisions-data-eng.md).
 */
import { politeFetch, type PolitenessOptions } from './politeness';

/** Our product token for robots.txt group matching. */
export const ROBOTS_AGENT_TOKEN = 'hemlinebot';

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!current) continue; // rules before any user-agent line are invalid
      if (value === '' && field === 'disallow') continue; // "Disallow:" = allow all
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', path: value });
    } else {
      lastWasAgent = false; // crawl-delay, sitemap, etc. close the agent run
    }
  }
  return groups;
}

/** Convert a robots path pattern (with * and $) into a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const anchored = escaped.endsWith('\\$') ? `${escaped.slice(0, -2)}$` : escaped;
  return new RegExp(`^${anchored}`);
}

export function isPathAllowed(
  robotsTxt: string,
  path: string,
  agentToken: string = ROBOTS_AGENT_TOKEN,
): boolean {
  const groups = parseRobots(robotsTxt);
  const token = agentToken.toLowerCase();

  // Pick the most specific matching group: exact/substring agent match beats '*'.
  let selected: RobotsGroup[] = groups.filter((g) =>
    g.agents.some((a) => a !== '*' && (token.includes(a) || a.includes(token))),
  );
  if (selected.length === 0) selected = groups.filter((g) => g.agents.includes('*'));
  if (selected.length === 0) return true;

  let best: { allow: boolean; specificity: number } | null = null;
  for (const g of selected) {
    for (const rule of g.rules) {
      if (patternToRegExp(rule.path).test(path)) {
        const specificity = rule.path.length;
        if (
          best === null ||
          specificity > best.specificity ||
          (specificity === best.specificity && rule.allow && !best.allow)
        ) {
          best = { allow: rule.allow, specificity };
        }
      }
    }
  }
  return best?.allow ?? true;
}

export interface RobotsGate {
  /** Is crawling `path` on `origin` allowed for HemlineBot? Cached per origin. */
  isAllowed(origin: string, path: string): Promise<boolean>;
}

export function createRobotsGate(opts: PolitenessOptions = {}): RobotsGate {
  const cache = new Map<string, Promise<string | null>>();

  const fetchRobots = (origin: string): Promise<string | null> => {
    let p = cache.get(origin);
    if (!p) {
      p = politeFetch(`${origin}/robots.txt`, undefined, opts)
        .then(async (res) => (res.ok ? await res.text() : null))
        .catch(() => null);
      cache.set(origin, p);
    }
    return p;
  };

  return {
    async isAllowed(origin: string, path: string): Promise<boolean> {
      const txt = await fetchRobots(origin);
      if (txt == null) return true; // missing/unreachable robots.txt → allowed
      return isPathAllowed(txt, path);
    },
  };
}
