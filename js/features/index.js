// Feature registry.
//
// Every feature lives in its own file and exports `register(app)`. They are
// loaded dynamically and independently: one feature failing to load never takes
// the app down with it, and adding a feature means adding a filename here and
// nothing else. That is what lets features be built in parallel.
const FEATURES = [
  'polls',
  'events',
  'canvases',
  'topics',
  'forum',
  'later',
  'status',
  'profile',
  // A person as a page at #/u/<id>. The modal card answers "who just said that";
  // this is the staff directory entry, which is a different shape.
  'profilepage',
  'admin',
  // The organisation console. A page at #/admin, not a panel.
  'orgadmin',
  'moderation',
  'integrations',
  'messageExtras',
  'onboarding',
  'roles',
  'snippets',
  'bookmarks',
  'notifications',
  'shortcuts',
  // coordination (0055): what a volunteer coordinator does every week
  'ackloop',
  'forms',
  'tasks',
  // The cheap way in to the line above: a message that hands work out gets a
  // one-tap offer to become a task, parsed on this device with no model and no
  // round trip. Loaded after tasks so the panel it feeds already exists.
  'quicktask',
  // Progress updates, blockers and the queue of work nobody owns. After tasks
  // because it fills a slot tasks.js draws, and it needs migration 0101 - without
  // it every RPC returns "function not found" once and the feature switches
  // itself off rather than erroring on every card.
  'taskprogress',
  'orientation',
  'activityReport',
  // Labelled sidebar rows for the four panels above. Without it they are only
  // header buttons past the inline cap, and the channel bar's overflow is dead.
  'coordnav',
  'offline',
  // Late, so it is registered after the features whose errors it would catch.
  'errorreport',
  // Last on purpose: it re-registers a few core panels by id and decorates what
  // every other feature has already put on screen.
  'uxfix',
];

export async function registerFeatures(app) {
  const loaded = [];
  await Promise.all(FEATURES.map(async (name) => {
    try {
      const mod = await import(`./${name}.js`);
      if (typeof mod.register === 'function') {
        await mod.register(app);
        loaded.push(name);
      }
    } catch (e) {
      // A missing or broken feature module is a degraded app, not a dead one.
      if (!/Failed to fetch|not found|404/i.test(e.message || '')) {
        console.warn(`[hearth] feature "${name}" failed to load:`, e);
      }
    }
  }));
  console.info('[hearth] features loaded:', loaded.join(', ') || 'none');
  return loaded;
}
