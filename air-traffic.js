export const AIR_TRAFFIC_RULES_KEY = 'airTrafficRules';
export const AIR_TRAFFIC_RULE_LIMIT = 100;

export function parseAirTrafficPattern(value) {
    if (typeof value !== 'string') return null;
    const pattern = value.trim();
    if (!pattern || pattern.length > 2048 || /[\s?#\\]/.test(pattern)) return null;

    const parts = /^(?:(https?):\/\/)?(\[[^\]]+\]|[^/:@*%]+)(?::(\d+))?(\/[^*]*\*?)?$/i.exec(pattern);
    if (!parts) return null;
    const [, scheme, host, port, path] = parts;
    const protocol = scheme ? `${scheme.toLowerCase()}:` : null;
    const prefix = !path || path.endsWith('*');
    const pathname = prefix ? path?.slice(0, -1) || '/' : path;
    try {
        const url = new URL(`${protocol || 'https:'}//${host}${port ? `:${port}` : ''}${pathname}`);
        const hostname = url.hostname.replace(/\.$/, '');
        if (!hostname || url.username || url.password) return null;
        return { pattern, protocol, hostname, port: port ? String(Number(port)) : null, pathname: url.pathname, prefix };
    } catch {
        return null;
    }
}

export function compileAirTrafficRule(rule) {
    const match = parseAirTrafficPattern(rule?.pattern);
    if (!match || typeof rule.spaceId !== 'string' || !rule.spaceId) return null;
    return { pattern: match.pattern, spaceId: rule.spaceId, match };
}

export function findAirTrafficDestination(rules, spaces, address) {
    if (!rules.length || !address) return undefined;
    let url;
    try { url = new URL(address); } catch { return undefined; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

    const host = url.hostname.replace(/\.$/, '');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    for (const { spaceId, match } of rules) {
        if (host !== match.hostname || (match.protocol && match.protocol !== url.protocol) ||
            (match.port && match.port !== port)) continue;
        if (match.prefix ? !url.pathname.startsWith(match.pathname) : url.pathname !== match.pathname) continue;
        const destination = spaces.find(space => space.id === spaceId);
        if (destination) return destination;
    }
}
