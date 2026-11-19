import { activateBrowserResult } from './quick-switcher-search.js';

// Construct navigation only. No request is made until the user activates it.
export function googleSearchUrl(query) {
    const text = query.trim();
    if (!text) return null;
    const url = new URL('https://www.google.com/search');
    url.searchParams.set('q', text);
    return url.href;
}

export async function activateGoogleSearch(query, context, chromeApi = globalThis.chrome) {
    const url = googleSearchUrl(query);
    if (!url) return null;
    // A web search always creates a tab in the originating browsing context.
    return activateBrowserResult({ url }, context, true, chromeApi);
}
