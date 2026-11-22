export const storeBuildMode = 'chrome-web-store';
export const storeBuildDirectory = 'dist-store';
export const storeArchive = 'prismarc-chrome-web-store.zip';
export const storeIcon = 'assets/prismarc-store-icon.png';

export function storeManifest(source) {
  const manifest = structuredClone(source);
  const revision = process.env.PRISMARC_STORE_BUILD_REVISION;
  if (revision !== undefined) {
    const baseParts = manifest.version.split('.');
    if (baseParts.length !== 3
      || baseParts.some(part => !/^(?:0|[1-9]\d{0,4})$/.test(part) || Number(part) > 65535)
      || !/^[1-9]\d{0,4}$/.test(revision)
      || Number(revision) > 65535) {
      throw new Error('Store CD requires a three-part Chrome version and a revision from 1 to 65535.');
    }
    manifest.version = `${manifest.version}.${revision}`;
  }
  manifest.icons[128] = storeIcon;
  const optionalPermissions = manifest.optional_permissions?.filter(permission => permission !== 'identity');
  if (optionalPermissions?.length) {
    manifest.optional_permissions = optionalPermissions;
  } else {
    delete manifest.optional_permissions;
  }
  manifest.content_security_policy.extension_pages =
    manifest.content_security_policy.extension_pages.replace(/\bconnect-src\s+[^;]+/, "connect-src 'none'");
  return manifest;
}
