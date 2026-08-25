# UI REWORK CHECKLIST - ground up, page by page

The design language (apply to EVERY surface):
- Type: 13px UI / 15px messages / 11px tracked labels / 650-weight names
- Space: 4px grid. Comfortable density, Slack-like
- Radius: 8 rows / 10 buttons+inputs / 14 cards / 18 sheets
- Line: hairline borders (white 7% dark, ink 8% light), no heavy 1px greys
- Depth: 3 shadow tiers, used sparingly (composer focus, modals, popovers)
- Color: accent #406fe0 only for action+focus, everything else neutral
- Icons: SVG set only, 20px, 1.75 stroke. ZERO emoji in chrome

## SURFACES

### A. Foundation
- [ ] tokens.css: dark theme (near-black floor, layered surfaces, hairlines)
- [ ] tokens.css: light theme (off-white floor, white surfaces, hairlines)
- [ ] tokens.css: colorful theme (aubergine chrome, same discipline)
- [ ] tokens.css: radius scale 8/10/14/18, shadow tiers, focus ring
- [ ] base.css: type scale, selection, scrollbars, focus-visible

### B. Auth (first thing every human sees)
- [ ] Sign-in card: split-brand layout desktop, logo, value line, clean fields
- [ ] OTP code step: 6-box input feel, resend timer, target email shown
- [ ] Set-password step: strength meter styling
- [ ] No-team / join screen: two clear doors (create / join link)

### C. Main shell (95% of screen time)
- [ ] Top bar: space switcher, search pill, identity chip
- [ ] Space rail: logo tiles, active ring, badges, org labels
- [ ] Sidebar: section headers, channel rows (unread/mention/muted/active/voice/DM)
- [ ] Channel bar: title+topic, online pill, action icons, Invite
- [ ] Bookmark strip
- [ ] Messages: grouping, avatars, name+time, body 15px, hover actions,
      reactions pills, thread pill, day dividers, mention highlight,
      link cards, task chips, ack cards, code blocks, quotes
- [ ] Typing indicator + receipts line
- [ ] Composer: toolbar, attach chips, autocomplete popover, reply bar
- [ ] New-below pill, jump banner
- [ ] Tab bar (mobile) + drawer + scrim

### D. Panels (right sheet)
- [ ] Panel frame: header, content, footer
- [ ] Threads list + thread view
- [ ] Tasks (7 tabs, chips, forecast card)
- [ ] Activity inbox + mark-all-read
- [ ] Members list + add-people
- [ ] Search: input, chips, result rows
- [ ] Pins / Saved&Later
- [ ] Profile card + full profile page
- [ ] Drafts panel
- [ ] Notifications settings
- [ ] Integrations console
- [ ] Roles console
- [ ] Shortcuts sheet

### E. Full pages
- [ ] Org admin (#/admin): overview stats, people, servers, permissions, rules
- [ ] Space admin console: stats, settings, logo, invites, channels, audit
- [ ] Profile page (#/u/)
- [ ] Canvases (editor modal + blocks)
- [ ] Forms (builder + fill + responses)
- [ ] Polls, Events, Forum board, Topics
- [ ] Voice rooms panel + voice bar + screenshare viewer
- [ ] Snippets viewer
- [ ] Onboarding gate + rules + join requests
- [ ] Orientation banner + guide panel

### F. System
- [ ] Modals, confirms, type-to-confirm
- [ ] Toasts (info/success/error)
- [ ] Context menus
- [ ] Emoji picker
- [ ] Lightbox (image viewer)
- [ ] Connection bar + offline outbox rows
- [ ] Empty states (all)
- [ ] Loading skeletons
- [ ] Error report bar
- [ ] Mobile: sheets, drawers, safe areas, 44px targets
- [ ] Reduced motion + contrast

### G. Themes final pass
- [ ] Dark: every surface above
- [ ] Light: every surface above
- [ ] Colorful: chrome-only aubergine, content neutral

RULES: tokens only (no hardcoded hex outside tokens.css), tokens-only colors,
44px touch targets, focus-visible everywhere, zero emoji in chrome.
