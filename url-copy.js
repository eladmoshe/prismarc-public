import { Logger } from './logger.js';

const copyQueue = new WeakMap();

/**
 * Copy the last-focused tab URL from the MV3 service worker. Serialize access
 * to the offscreen document (one per extension). An open sidebar can copy if
 * the offscreen document is unavailable.
 */
export function copyCurrentTabUrlWithFallback({ chromeApi = globalThis.chrome, logger = Logger, tab } = {}) {
    const previous = copyQueue.get(chromeApi) ?? Promise.resolve();
    const operation = previous.then(() => copyFromExtension(chromeApi, logger, tab));
    copyQueue.set(chromeApi, operation.catch(() => {}));
    return operation;
}

async function copyFromExtension(chromeApi, logger, commandTab) {
    try {
        const tab = commandTab ?? (await chromeApi.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        if (!tab?.id || !tab.url) {
            logger.error?.(Logger.context('There is no active tab URL to copy.'));
            return false;
        }

        if (chromeApi.offscreen?.createDocument) {
            try {
                await copyOffscreen(chromeApi, logger, tab.url);
                try {
                    await chromeApi.runtime.sendMessage({ action: 'urlCopySuccess' });
                } catch {
                    // The sidebar need not be open for an offscreen copy.
                }
                return true;
            } catch (error) {
                logger.log?.('[URLCopy] Offscreen clipboard failed, trying sidebar:', error);
            }
        }

        let timeout;
        try {
            const response = await new Promise((resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('Sidebar timeout')), 1000);
                chromeApi.runtime.sendMessage({ command: 'copyCurrentUrl', url: tab.url }, result => {
                    if (chromeApi.runtime.lastError) reject(chromeApi.runtime.lastError);
                    else resolve(result);
                });
            });
            if (response?.success === true) return true;
            throw new Error('Sidebar clipboard copy failed');
        } finally {
            clearTimeout(timeout);
        }
    } catch (error) {
        logger.error?.(Logger.context('Could not copy the current tab URL.'), error);
        return false;
    }
}

async function copyOffscreen(chromeApi, logger, url) {
    const contexts = await chromeApi.runtime.getContexts?.({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chromeApi.runtime.getURL('offscreen.html')]
    });
    if (!contexts?.length) {
        await chromeApi.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['CLIPBOARD'],
            justification: 'Copy the current tab URL from a keyboard shortcut.'
        });
    }
    try {
        const response = await chromeApi.runtime.sendMessage({
            target: 'offscreen',
            type: 'copyToClipboard',
            text: url
        });
        if (response?.success !== true) throw new Error(response?.error || 'Offscreen clipboard copy failed');
    } finally {
        try {
            await chromeApi.offscreen.closeDocument();
        } catch (error) {
            logger.warn?.(Logger.context('Could not close the clipboard document.'), error);
        }
    }
}
