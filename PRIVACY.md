# PrismArc privacy policy

Effective November 20, 2026.

PrismArc organizes your tabs and bookmarks in Chrome. The extension runs on your device. Its maintainer does not receive your browsing history, page images, calendar events, or usage analytics.

**Tabs, bookmarks, and search.** PrismArc reads tab titles and URLs, native bookmarks, and Chrome history to display the sidebar and answer Quick Switcher searches. Space membership, saved tab information, archive entries, and preferences are stored in your browser profile. Choosing **Delete from browser history** removes visits to the selected result's URLs from Chrome history. Choosing **Search Google** sends the search text to Google by opening a browser tab. Chrome can sync native bookmarks and history according to your profile settings. Speaker buttons use Chrome's native audio status and change a tab's mute setting when activated.

**PrismArc popups over webpages.** This optional setting asks Chrome for site access and permission to open Recent Tabs and Quick Switcher over permitted pages. The listener runs in Chrome’s isolated world and shows an extension-owned frame when you invoke a switcher. Search text, tab titles, URLs, history results, and page images stay inside the extension. When you ask to delete a history result from the overlay, Quick Switcher moves the query and result into its own window for confirmation. Privileged pages and private windows use their existing switching behavior. The separate browsing-preview setting controls automatic page images.

Air Traffic stores your URL patterns and destination Spaces on this device. It compares addresses locally when you open or navigate a temporary tab.

**Page images.** On macOS, using the Recent Tabs shortcut can capture the visible web page, including sensitive content displayed on it. Settings lets you turn off page previews and exclude domains and their subdomains. **Capture previews while browsing** requests optional all-sites access for foreground captures. Private windows are excluded. PrismArc keeps up to five small thumbnails. Shortcut-only previews expire after ten minutes in memory. If you enable browsing previews, encrypted thumbnails stay on this device for the browser session. Only the picker requests their images. The encryption key stays in Chrome’s session memory and is lost when the browser restarts. Navigation, closing a tab, or disabling previews clears the affected images. PrismArc never uploads them.

**Google Calendar.** If you choose to connect a Google account, Google handles sign-in and consent. PrismArc receives a short-lived access token that it keeps in browser-session storage. It requests today's primary calendar events from Google, uses your response status to omit declined events, and displays titles and times. Event data stays in extension memory. Disconnect clears local access and asks Google to revoke the available token. You can also remove the app from your [Google Account connections](https://myaccount.google.com/connections).

**Retention and control.** The clipboard shortcut writes the selected tab's URL to your system clipboard on request. Profile-local extension data lasts until you remove it or uninstall the extension. Native bookmarks, Chrome history, and the system clipboard have their own controls. Debug logging is optional and can show browsing details locally when enabled.
