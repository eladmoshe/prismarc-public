/** Only extension-owned contexts may invoke privileged runtime handlers. */
export function isTrustedExtensionMessage(message, sender, chromeApi = globalThis.chrome) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const runtime = chromeApi?.runtime;
    if (!runtime?.id || sender?.id !== runtime.id) return false;
    // Web-page content scripts share the extension ID but are outside our UI trust boundary.
    return sender.url === undefined ||
        (typeof sender.url === 'string' && sender.url.startsWith(runtime.getURL('')));
}
