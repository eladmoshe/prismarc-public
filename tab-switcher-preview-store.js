const jpeg = 'data:image/jpeg;base64,';
const maxBytes = 40 * 1024;
const prefix = 'tabSwitcherThumbnail:';
const refPattern = /^tabSwitcherThumbnail:([ds]):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keyName = 'tabSwitcherThumbnailKey';

function encode(bytes) {
    return bytes.toBase64 ? bytes.toBase64() : btoa(String.fromCharCode(...bytes));
}

function decode(value) {
    return Uint8Array.fromBase64 ? Uint8Array.fromBase64(value) : Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
}

function cipher(ref, iv) {
    return { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(ref) };
}

export function previewStorageMode(ref) {
    const match = typeof ref === 'string' && refPattern.exec(ref);
    return match ? (match[1] === 'd' ? 'disk' : 'session') : null;
}

function sessionKeyBytes(saved) {
    if (typeof saved !== 'string' || saved.length !== 44) return null;
    try {
        const bytes = decode(saved);
        return bytes.length === 32 ? bytes : null;
    } catch {
        return null;
    }
}

// The worker serializes writes to its tab-to-reference index. Each write gets
// a new reference so a late read cannot silently return another generation.
export class TabSwitcherPreviewStore {
    constructor(chromeApi) {
        this.storage = chromeApi.storage;
    }

    sessionKey() {
        if (!this.key) {
            this.key = this.loadSessionKey().catch(error => {
                this.key = undefined;
                throw error;
            });
        }
        return this.key;
    }

    async loadSessionKey() {
        const saved = (await this.storage.session.get(keyName))[keyName];
        let bytes = sessionKeyBytes(saved);
        if (!bytes) {
            bytes = crypto.getRandomValues(new Uint8Array(32));
            await this.storage.session.set({ [keyName]: encode(bytes) });
        }
        return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }

    area(ref) {
        const mode = previewStorageMode(ref);
        return mode === 'session' ? this.storage.session : mode === 'disk' ? this.storage.local : null;
    }

    async put(data, disk) {
        if (!data?.startsWith(jpeg) || data.length > jpeg.length + 4 * Math.ceil(maxBytes / 3)) {
            throw new Error('Invalid tab thumbnail.');
        }
        const bytes = decode(data.slice(jpeg.length));
        if (!bytes.length || bytes.length > maxBytes) throw new Error('Invalid tab thumbnail.');
        const ref = prefix + (disk ? 'd:' : 's:') + crypto.randomUUID();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(cipher(ref, iv), await this.sessionKey(), bytes);
        await this.area(ref).set({ [ref]: { iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) } });
        return ref;
    }

    async read(ref) {
        const area = this.area(ref);
        if (!area) return null;
        const record = (await area.get(ref))[ref];
        if (typeof record?.iv !== 'string' || record.iv.length !== 16 ||
            typeof record.ciphertext !== 'string' || record.ciphertext.length > 4 * Math.ceil((maxBytes + 16) / 3)) return null;
        const key = await this.sessionKey();
        try {
            const bytes = await crypto.subtle.decrypt(cipher(ref, decode(record.iv)), key, decode(record.ciphertext));
            return jpeg + encode(new Uint8Array(bytes));
        } catch {
            return null; // Wrong session, corrupt content, or a swapped record.
        }
    }

    async delete(refs) {
        const groups = new Map();
        for (const ref of refs) {
            const area = this.area(ref);
            if (!area) continue;
            if (!groups.has(area)) groups.set(area, []);
            groups.get(area).push(ref);
        }
        await Promise.all([...groups].map(([area, keys]) => area.remove(keys)));
    }

    async reconcile(validRefs) {
        const saved = (await this.storage.session.get(keyName))[keyName];
        const retained = sessionKeyBytes(saved) ? new Set(validRefs) : new Set();
        const present = new Set();
        await Promise.all([this.storage.local, this.storage.session].map(async area => {
            // Chrome 130+ enumerates just the keys. Older supported versions
            // use the compatibility path during cleanup, never on picker reads.
            const keys = area.getKeys ? await area.getKeys() : Object.keys(await area.get(null));
            const stale = [];
            for (const ref of keys) {
                if (this.area(ref) !== area) continue;
                if (retained.has(ref)) present.add(ref);
                else stale.push(ref);
            }
            if (stale.length) await area.remove(stale);
        }));
        return present;
    }
}
