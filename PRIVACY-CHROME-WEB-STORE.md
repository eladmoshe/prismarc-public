# PrismArc privacy policy for the Chrome Web Store release

Effective November 27, 2026.

PrismArc organizes and switches between tabs and bookmarks in Chrome. It processes browsing data on your device. The maintainer receives no browsing history, page images, or usage analytics.

## Tabs, bookmarks, and search

Air Traffic stores your URL patterns and destination Spaces on this device. It compares addresses locally when you open or navigate a temporary tab.

PrismArc reads tab titles and addresses, native Chrome bookmarks, and Chrome browsing history to display the sidebar and answer Quick Switcher searches. It saves spaces, saved tab information, archive entries, and preferences in Chrome's local extension storage.

Choosing **Delete from browser history** removes visits to the selected result's addresses from Chrome history. Choosing **Search Google** opens a Google search page and sends the search query to Google. Chrome can sync native bookmarks and history according to your Chrome profile settings. Speaker buttons read Chrome’s native audio status and change a tab’s mute setting when you activate them.

Starting with PrismArc 5.3.0, **Clean** keeps eligible page addresses and tab order in extension memory for up to 20 seconds so you can undo the most recent cleanup in that window. PrismArc discards those records when the undo period ends.

## Zoom launcher cleanup

PrismArc checks tab addresses for Zoom meeting launcher links. For a matching tab, it keeps the tab's Chrome ID and closure deadline in browser session storage. It closes the tab after about a minute if the tab is still on a qualifying launcher and has no pending navigation.

## Element capture

When you choose **Capture element**, PrismArc uses optional scripting access to show a picker on the current webpage. Confirming a selection captures the visible tab, crops it on your device, and copies the selected pixels to your system clipboard as a PNG. PrismArc discards the temporary image after the operation. This feature works independently of Recent Tabs previews.

## PrismArc popups over webpages

If you enable **Show PrismArc popups over webpages**, Chrome requests optional scripting and site access. On permitted pages an isolated listener shows Quick Switcher or Recent Tabs inside an authenticated extension frame when you invoke a switcher. Quick Switcher processes typed input in that frame. Queries, search results, tab titles, addresses, images, and tab counts stay inside the extension on your device. Recent Tabs uses its shortcut modifier on macOS.

Choosing to delete a history result in the overlay opens the Quick Switcher window to confirm the same query and result. Private windows, Chrome's protected pages, and pages where the frame is unavailable use the usual fallback.

This setting works independently from **Capture previews while browsing**. Either setting can use the same optional site grant. Turning both off releases that grant.

## Page previews on macOS

Using the Recent Tabs shortcut can capture the visible web page, including sensitive material displayed on the page. Enabling **Capture previews while browsing** asks Chrome for optional all-sites access so PrismArc can capture eligible foreground pages as you visit them. Private windows are excluded. PrismArc never uploads preview images.

PrismArc keeps up to five reduced thumbnails. Shortcut-only thumbnails are encrypted in browser-session memory and expire after ten minutes. If you enable browsing previews, encrypted thumbnails can stay on this device for the browser session. The key stays in Chrome's session memory and is lost when Chrome restarts. The Recent Tabs picker decrypts eligible thumbnails when opened.

Navigating or closing a tab clears its thumbnail. You can disable previews or exclude specific domains and their subdomains in PrismArc Settings. Disabling previews clears the thumbnail cache.

## Retention and controls

Local extension data lasts until you remove it or uninstall PrismArc. Native bookmarks and Chrome history have their own controls in Chrome. The copy shortcut writes the selected tab address to your system clipboard on request. Optional debug logging can include browsing details in local logs.

## Limited Use

PrismArc's handling of user data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. PrismArc uses this data for its disclosed tab organization, search, and switching features.

For privacy questions, contact the developer through PrismArc's Chrome Web Store listing.
