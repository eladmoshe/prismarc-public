import { Utils } from './utils.js';

const revisionLimit = 256;
const siteRevisions = new Map();
let nextRevision = 0;

export function wrapSidebarFavicon(image) {
    const wrapper = document.createElement('span');
    wrapper.className = 'sidebar-favicon';
    wrapper.append(image);
    return wrapper;
}

function siteKey(pageUrl) {
    try {
        const { origin } = new URL(pageUrl);
        if (origin !== 'null') return origin;
    } catch { /* Invalid and opaque URLs still use Chrome's default icon. */ }
    return pageUrl;
}

function rememberSiteRevision(site, revision) {
    siteRevisions.delete(site);
    siteRevisions.set(site, revision);
    if (siteRevisions.size > revisionLimit) siteRevisions.delete(siteRevisions.keys().next().value);
}

export function invalidateSidebarFavicons(pageUrl) {
    rememberSiteRevision(siteKey(pageUrl), ++nextRevision);
}

export function setSidebarFavicon(image, pageUrl, size = '16') {
    const site = siteKey(pageUrl);
    const revision = siteRevisions.get(site);
    if (revision !== undefined) rememberSiteRevision(site, revision);
    const favicon = Utils.getFaviconUrl(pageUrl, size);
    // Change the extension-local request after Chrome reports a changed favicon,
    // so a decoded placeholder does not mask the icon now in Chrome's cache.
    const source = revision === undefined ? favicon : favicon + '&revision=' + revision;
    if (image.src === source) return;
    image.onload = () => {
        if (image.src !== source || image.currentSrc !== source) return;
        image.onload = null;
        // Refresh if Chrome reported another icon change during this load.
        if (siteRevisions.get(site) !== revision) setSidebarFavicon(image, pageUrl, size);
    };
    image.onerror = () => {
        if (image.src !== source) return;
        image.onerror = image.onload = null;
        image.src = 'assets/default_icon.png';
    };
    image.src = source;
}
