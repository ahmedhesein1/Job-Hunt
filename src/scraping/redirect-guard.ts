import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * §5.2 / §13 SSRF protection: HTTPS only, host allowlist, and no private, loopback,
 * link-local or cloud-metadata destinations — checked on every redirect hop.
 */
export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const dnsResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Exact hostnames or `*.suffix` patterns. */
export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    const pattern = p.toLowerCase();
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
    return host === pattern;
  });
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. 169.254.169.254 metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const value = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, fd00:ec2::254 metadata
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return true;
}

export async function assertSafeUrl(rawUrl: string, allowedHosts: readonly string[], resolve: Resolver = dnsResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError(`Only HTTPS is allowed (${url.protocol})`);
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URL are not allowed');
  if (url.port && url.port !== '443') throw new UnsafeUrlError('Non-standard port');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) throw new UnsafeUrlError('IP-literal hosts are not allowed');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    throw new UnsafeUrlError('Local hostnames are not allowed');
  }
  if (!hostAllowed(hostname, allowedHosts)) throw new UnsafeUrlError(`Host ${hostname} is not on the allowlist`);
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError(`Host ${hostname} resolves to a private or reserved address`);
  }
  return url;
}
