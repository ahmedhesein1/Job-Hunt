import { containsTerm, normalizeForMatch } from '../../core/skills';

/**
 * Evaluates a LinkedIn Boolean keyword query (the same strings the saved searches use)
 * against job text: "exact phrases", AND / OR / NOT in capitals, parentheses, and an
 * implicit AND between adjacent terms. Precedence: NOT > AND > OR, as on LinkedIn.
 */
type Node =
  | { kind: 'term'; value: string }
  | { kind: 'not'; node: Node }
  | { kind: 'and' | 'or'; nodes: Node[] };

type Token = { type: 'term'; value: string } | { type: 'and' | 'or' | 'not' | 'lparen' | 'rparen' };

export class BooleanQueryError extends Error {
  override name = 'BooleanQueryError';
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  const re = /"([^"]*)"|(\()|(\))|([^\s()"]+)/g;
  for (const m of query.replace(/[“”„]/g, '"').matchAll(re)) {
    if (m[1] !== undefined) {
      if (m[1].trim()) tokens.push({ type: 'term', value: m[1] });
    } else if (m[2]) tokens.push({ type: 'lparen' });
    else if (m[3]) tokens.push({ type: 'rparen' });
    else if (m[4] === 'AND') tokens.push({ type: 'and' });
    else if (m[4] === 'OR') tokens.push({ type: 'or' });
    else if (m[4] === 'NOT') tokens.push({ type: 'not' });
    else if (m[4]) tokens.push({ type: 'term', value: m[4] });
  }
  return tokens;
}

export function parseBooleanQuery(query: string): Node {
  const tokens = tokenize(query);
  let i = 0;
  const peek = () => tokens[i];

  const parseOr = (): Node => {
    const nodes = [parseAnd()];
    while (peek()?.type === 'or') {
      i += 1;
      nodes.push(parseAnd());
    }
    return nodes.length === 1 ? nodes[0]! : { kind: 'or', nodes };
  };
  const parseAnd = (): Node => {
    const nodes = [parseUnary()];
    for (;;) {
      const t = peek();
      if (t?.type === 'and') {
        i += 1;
        nodes.push(parseUnary());
      } else if (t && (t.type === 'term' || t.type === 'not' || t.type === 'lparen')) {
        nodes.push(parseUnary()); // implicit AND
      } else break;
    }
    return nodes.length === 1 ? nodes[0]! : { kind: 'and', nodes };
  };
  const parseUnary = (): Node => {
    const t = peek();
    if (t?.type === 'not') {
      i += 1;
      return { kind: 'not', node: parseUnary() };
    }
    if (t?.type === 'lparen') {
      i += 1;
      const node = parseOr();
      if (peek()?.type !== 'rparen') throw new BooleanQueryError('missing closing parenthesis');
      i += 1;
      return node;
    }
    if (t?.type === 'term') {
      i += 1;
      return { kind: 'term', value: t.value };
    }
    throw new BooleanQueryError(`unexpected ${t ? t.type : 'end of query'}`);
  };

  const node = parseOr();
  if (i !== tokens.length) throw new BooleanQueryError(`unexpected ${tokens[i]!.type}`);
  return node;
}

function evaluate(node: Node, text: string): boolean {
  switch (node.kind) {
    case 'term':
      return containsTerm(text, node.value);
    case 'not':
      return !evaluate(node.node, text);
    case 'and':
      return node.nodes.every((n) => evaluate(n, text));
    case 'or':
      return node.nodes.some((n) => evaluate(n, text));
  }
}

const cache = new Map<string, Node>();

/** True when `text` satisfies the query. Parsed queries are cached. */
export function matchesBooleanQuery(query: string, text: string): boolean {
  let node = cache.get(query);
  if (!node) {
    node = parseBooleanQuery(query);
    cache.set(query, node);
  }
  return evaluate(node, normalizeForMatch(text));
}
