import { activateBrowserResult, searchableUrl } from './quick-switcher-search.js';

export function typedWebsiteUrl(query) {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text || /[\s\p{Cc}\p{Cf}\\]/u.test(text)) return null;
    if (/^chrome:/i.test(text)) return searchableUrl(text);
    const scheme = /^https?:\/\//i.exec(text)?.[0];
    const authority = text.slice(scheme?.length ?? 0).split(/[/?#]/, 1)[0];
    const address = /^(\[[^\]]+\]|[^:@%]+)(?::(\d+))?$/.exec(authority);
    if (!address) return null;

    let url;
    try { url = new URL(scheme ? text : `https://${text}`); }
    catch { return null; }
    if (url.username || url.password) return null;

    const hostname = url.hostname.replace(/\.$/, '');
    if (hostname.startsWith('[')) return url.href;
    if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
        // Reject shorthand, octal, and hexadecimal IPv4 forms that browsers rewrite.
        return address[1] === hostname ? url.href : null;
    }
    const labels = hostname.split('.');
    if (hostname.length > 253 || !labels.every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return null;
    if (scheme || (labels.length > 1 && /^[a-z]/i.test(labels.at(-1))) ||
        (hostname === 'localhost' && address[2])) return url.href;
    return null;
}

export async function activateTypedWebsite(query, context, chromeApi = globalThis.chrome) {
    const url = typedWebsiteUrl(query);
    if (!url) throw new Error('This website address cannot be opened');
    return activateBrowserResult({ url }, context, true, chromeApi);
}
