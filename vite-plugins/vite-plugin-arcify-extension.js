import { resolve } from 'path';
import { readFileSync } from 'node:fs';
import fs from 'fs-extra';
import { isCalendarClientId } from '../calendar-config.js';

function calendarBuildClientId() {
  const file = resolve(process.cwd(), 'calendar-oauth-client.local');
  const value = process.env.PRISMARC_CALENDAR_CLIENT_ID ?? (fs.existsSync(file) ? readFileSync(file, 'utf8') : '');
  const clientId = value.trim();
  if (clientId && !isCalendarClientId(clientId)) throw new Error('PrismArc Calendar builds require a public Google OAuth client ID.');
  return clientId;
}

/**
 * Get shared input configuration for PrismArc
 */
function getExtensionInputs() {
  return {
    sidebar: resolve(process.cwd(), 'sidebar.html'),
    'tutorial-practice': resolve(process.cwd(), 'tutorial-practice.html'),
    options: resolve(process.cwd(), 'options.html'),
    'calendar-settings': resolve(process.cwd(), 'calendar-settings.html'),
    'installation-onboarding': resolve(process.cwd(), 'installation-onboarding.html'),
    background: resolve(process.cwd(), 'background.js'),
    'sidebar-script': resolve(process.cwd(), 'sidebar.js'),
    'options-script': resolve(process.cwd(), 'options.js'),
    'installation-onboarding-script': resolve(process.cwd(), 'installation-onboarding.js'),
    offscreen: resolve(process.cwd(), 'offscreen.html'),
    'quick-switcher': resolve(process.cwd(), 'quick-switcher.html'),
    'tab-switcher': resolve(process.cwd(), 'tab-switcher.html'),
  };
}

/**
 * Get shared output configuration for PrismArc
 */
function getExtensionOutput(isDev = false) {
  return {
    entryFileNames: (chunkInfo) => {
      const mainScripts = ['background', 'sidebar-script', 'options-script', 'installation-onboarding-script'];
      if (mainScripts.includes(chunkInfo.name)) {
        if (chunkInfo.name === 'sidebar-script') return 'sidebar.js';
        if (chunkInfo.name === 'options-script') return 'options.js';
        if (chunkInfo.name === 'installation-onboarding-script') return 'installation-onboarding.js';
        return `${chunkInfo.name}.js`;
      }
      return isDev ? '[name].js' : 'assets/[name]-[hash].js';
    },
    chunkFileNames: isDev ? '[name].js' : 'assets/[name]-[hash].js',
    assetFileNames: (assetInfo) => {
      if (assetInfo.name?.endsWith('.css')) {
        return '[name][extname]';
      }
      if (assetInfo.name?.endsWith('.html')) {
        return '[name][extname]';
      }
      return isDev ? '[name][extname]' : 'assets/[name]-[hash][extname]';
    }
  };
}

/**
 * Get PrismArc build plugins
 */
function getExtensionPlugins(isDev = false) {
  const outDir = isDev ? 'dist-dev' : 'dist';
  // Manifest and runtime code load these by their original URLs.
  const staticFiles = [
    'manifest.json',
    'styles.css',
    'LICENSE',
    'NOTICE',
    'assets/default_icon.png',
    'assets/icon.png',
    'assets/icon-16.png',
    'assets/icon-24.png',
    'assets/icon-32.png',
    'assets/icon-48.png',
    'assets/varela-round.ttf',
    'assets/varela-round-LICENSE.txt',
  ];

  return [
    // Main extension build plugin
    {
      name: 'prismarc-extension-main',
      writeBundle: async () => {
        await Promise.all(staticFiles.map(file => fs.copy(file, resolve(outDir, file))));
        console.log(`✅ PrismArc extension built to ${outDir}/`);
      }
    }
  ];
}

/**
 * Create complete Vite configuration for PrismArc
 */
export function createArcifyConfig(options = {}) {
  const { isDev = false } = options;
  const outDir = isDev ? 'dist-dev' : 'dist';

  const config = {
    define: { __PRISMARC_CALENDAR_CLIENT_ID__: JSON.stringify(calendarBuildClientId()) },
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: getExtensionInputs(),
        output: getExtensionOutput(isDev)
      },
      target: 'es2020',
      minify: !isDev,
      sourcemap: isDev
    },
    plugins: getExtensionPlugins(isDev),
    server: {
      port: 3000,
      open: false,
      ...(isDev && { hmr: false }) // Disable HMR for Chrome extension in dev mode
    },
    resolve: {
      alias: {
        '@': resolve(process.cwd(), './'),
      }
    }
  };

  // Add dev-specific options
  if (isDev) {
    config.mode = 'development';
    config.build.watch = {
      include: ['**/*.js', '**/*.html', '**/*.css', 'manifest.json']
    };
  }

  return config;
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use createArcifyConfig instead
 */
export function arcifyExtensionPlugin(options = {}) {
  return getExtensionPlugins(options.isDev);
}
