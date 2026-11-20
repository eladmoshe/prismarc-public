export const storeBuildMode = 'chrome-web-store';
export const storeBuildDirectory = 'dist-store';
export const storeArchive = 'prismarc-chrome-web-store.zip';
export const storeIcon = 'assets/prismarc-store-icon.png';

export function storeManifest(source) {
  const manifest = structuredClone(source);
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
