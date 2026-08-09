// Reading a request out of an ordinary sentence.
//
// "@karthik please get the vendor invoices reconciled by Friday" is how work is
// actually handed out. Everything else - opening a dialog, picking a person from
// a list, choosing a date from a picker - is ceremony bolted onto a sentence
// somebody already typed correctly. This turns the sentence into {assignee,
// title, due} so the app can offer to make it a task with one tap.
//
// DETERMINISTIC ON PURPOSE. No model, no network, no dependency, no build step.
// A parser that is right 85% of the time and instant beats one that is right 95%
// of the time, costs a round trip, and cannot run when the line is bad - which is
// the line the field team is always on. It is also auditable: when it gets
// something wrong you can read the rule that did it.
//
// AND IT NEVER ACTS ON ITS OWN. Everything here produces a SUGGESTION. The
// person confirms. That is not timidity, it is the finding that decides whether
// this kind of feature is used or switched off: a wrong task created silently is
// a task somebody has to find and delete, and after the second one they stop
// trusting every task in the list. A suggestion that is wrong costs one glance.

// ------------------------------------------------------------------ vocabulary
// Verbs that make a sentence a request rather than a remark. Kept broad, because
// the cost of a missed suggestion is nothing and the cost of a wrong one is one
// dismissal. Ordered longest-first where prefixes overlap so the matcher does not
// stop at "look" inside "look into".
const ASK_VERBS = [
  'look into', 'sort out', 'follow up', 'follow-up', 'make sure', 'take care of',
  'get in touch', 'reach out', 'circle back', 'put together', 'draw up', 'write up',
  'reconcile', 'prepare', 'organise', 'organize', 'arrange', 'schedule', 'confirm',
  'collect', 'compile', 'complete', 'finish', 'submit', 'approve', 'review', 'check',
  'verify', 'update', 'upload', 'download', 'install', 'deploy', 'release', 'migrate',
  'fix', 'debug', 'test', 'ship', 'merge', 'refactor', 'document', 'investigate',
  'send', 'share', 'forward', 'email', 'call', 'ring', 'message', 'ping', 'chase',
  'book', 'order', 'buy', 'pay', 'invoice', 'bill', 'reimburse', 'settle',
  'clean', 'clear', 'sort', 'file', 'print', 'sign', 'scan', 'post', 'deliver',
  'handle', 'own', 'lead', 'run', 'drive', 'set up', 'setup', 'add', 'remove',
  'create', 'make', 'build', 'draft', 'plan', 'do', 'get', 'find', 'fetch', 'pick up',
];

// Politeness that marks a request and carries no meaning in the title. Sorted
// longest-first at load, because these overlap: matching "need you to" inside
// "we need you to" leaves a stranded "We" at the front of the title, and a task
// called "We fix the login bug" is the kind of thing that makes people stop
// trusting generated text.
const POLITE = [
  'could you please', 'can you please', 'would you please', 'please could you',
  'please can you', 'when you get a chance', 'whenever you can',
  'i need you to', 'we need you to', 'requesting you to', 'request you to',
  'could you', 'can you', 'would you', 'will you', 'need you to',
  'want you to', 'wanted you to', 'if you can', 'when you can',
  'please', 'kindly', 'pls', 'plz',
].sort((a, b) => b.length - a.length);

// "Somebody do this" - a real ask with no owner. It belongs in the queue of work
// waiting to be picked up, not silently attached to whoever happens to read it.
// Global, because "anyone please update it, anyone at all" would otherwise leave
// the second one in the title.
const UNOWNED = /\b(?:(?:can|could|would|will)\s+)?(?:someone|somebody|anyone|anybody)\s+(?:please\s+)?(?:needs?\s+to|has\s+to|should\s+)?/gi;
// Same words, but only asking whether the sentence HAS an owner. A separate
// non-global copy because lastIndex on a shared global regex makes .test()
// alternate between true and false on identical input, which is the single most
// confusing bug this file could contain.
const UNOWNED_TEST = /\b(?:(?:can|could|would|will)\s+)?(?:someone|somebody|anyone|anybody)\b/i;

// "I'll do it" - the other half of the same problem. A commitment somebody made
// out loud is the single most-dropped kind of work there is.
const SELF = /\b(?:i(?:'|’)?ll|i will|i can|i(?:'|’)?ve got it|i got it|on it|leave it (?:to|with) me|i(?:'|’)?m on it)\b/gi;
const SELF_TEST = /\b(?:i(?:'|’)?ll|i will|i can|i(?:'|’)?ve got it|i got it|on it|leave it (?:to|with) me|i(?:'|’)?m on it)\b/i;

// Things that look like a request and are not.
const NOT_ASK = /^(?:ok|okay|k|yes|no|yep|nope|sure|thanks|thank you|ty|got it|done|noted|cool|great|nice|perfect|\+1|👍)\b[.!]*$/i;

const DOW = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6 };
const MONTH = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };

// When a date is given with no time. 18:00 rather than 23:59 because a due date
// people miss by six hours every time is a due date they stop reading, and
// rather than 09:00 because "by Friday" in every workplace means the end of it.
const DEFAULT_HOUR = 18;
const TIME_WORDS = { morning: 9, noon: 12, midday: 12, afternoon: 14, evening: 18,
  tonight: 20, night: 20, eod: 18, cob: 18 };

// ------------------------------------------------------------------ helpers
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };

function nextDow(from, dow, forceNext) {
  const d = startOfDay(from);
  let delta = (dow - d.getDay() + 7) % 7;
  // "on Friday" said ON Friday means next Friday, not four minutes ago. "next
  // Friday" said on a Tuesday means the Friday of next week, which is the one
  // place English is genuinely ambiguous and where every calendar app picks a
  // side. This picks the same side as Google Calendar: next skips a week only
  // when the day has not yet passed this week.
  if (delta === 0) delta = 7;
  if (forceNext && delta < 7) delta += 7;
  d.setDate(d.getDate() + delta);
  return d;
}

// ------------------------------------------------------------------ dates
// Returns { at: Date, text: <the exact substring matched> } or null. The matched
// substring is returned so the caller can cut it out of the title: leaving "by
// Friday" in the title of a task that already has Friday as its due date is the
// small duplication that makes generated titles read like machine output.
export function parseDue(text, now = new Date()) {
  const s = text.toLowerCase();

  const hit = (re, fn) => {
    const m = s.match(re);
    if (!m) return null;
    const d = fn(m);
    return d ? { at: d, text: m[0] } : null;
  };

  // Explicit clock time, looked for first so it can be attached to whatever date
  // the rest of the sentence names. "friday 5pm" and "5pm friday" both work.
  let hour = null;
  let minute = 0;
  const t = s.match(/\b(?:at|by|before|around)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/)
    || s.match(/\b(?:at|by|before)\s+(\d{1,2}):(\d{2})\b/);
  let timeText = '';
  if (t) {
    hour = +t[1];
    minute = t[2] ? +t[2] : 0;
    const ap = t[3];
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    // A bare "by 5" with no am/pm means the working day, not five in the morning.
    if (!ap && hour < 8) hour += 12;
    timeText = t[0].trim();
  } else {
    const w = s.match(/\b(morning|noon|midday|afternoon|evening|tonight|eod|cob)\b/);
    if (w) { hour = TIME_WORDS[w[1]]; timeText = w[0]; }
  }
  const withTime = (d) => at(d, hour ?? DEFAULT_HOUR, hour === null ? 0 : minute);

  // "in an hour" and "in 20 minutes" already ARE a time. Running them through
  // withTime() moved them to six in the evening, which is a different sentence.
  const relTime = s.match(/\bin\s+(a|an|\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/);
  if (relTime) {
    const n = /^(a|an)$/.test(relTime[1]) ? 1 : +relTime[1];
    const d = new Date(now);
    if (/^(min|mins|minute|minutes)$/.test(relTime[2])) d.setMinutes(d.getMinutes() + n);
    else d.setHours(d.getHours() + n);
    return { at: d, text: relTime[0], timeText: '', hadTime: true };
  }

  const cand =
    // Absolute first: they are unambiguous and would otherwise be eaten by the
    // looser patterns below.
       hit(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => new Date(+m[1], +m[2] - 1, +m[3]))
    || hit(/\b(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?\b/, (m) => {
         // Day first. This product's people write 15/01, not 01/15.
         const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
         const d = new Date(y, +m[2] - 1, +m[1]);
         return isNaN(d) ? null : d;
       })
    || hit(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/,
         (m) => new Date(now.getFullYear(), MONTH[m[2]], +m[1]))
    || hit(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
         (m) => new Date(now.getFullYear(), MONTH[m[1]], +m[2]))
    || hit(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/, (m) => {
         const d = new Date(now.getFullYear(), now.getMonth(), +m[1]);
         if (d < startOfDay(now)) d.setMonth(d.getMonth() + 1);   // "the 3rd" on the 20th means next month
         return d;
       })

    // Relative.
    || hit(/\bday after tomorrow\b/, () => { const d = startOfDay(now); d.setDate(d.getDate() + 2); return d; })
    || hit(/\b(?:tomorrow|tmrw|tmw)\b/, () => { const d = startOfDay(now); d.setDate(d.getDate() + 1); return d; })
    || hit(/\b(?:today|tonight)\b/, () => startOfDay(now))
    || hit(/\bin\s+(a|an|\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/, (m) => {
         const n = /^(a|an)$/.test(m[1]) ? 1 : +m[1];
         const d = new Date(now);
         if (/^(min|mins|minute|minutes)$/.test(m[2])) d.setMinutes(d.getMinutes() + n);
         else d.setHours(d.getHours() + n);
         return d;
       })
    || hit(/\bin\s+(a|an|\d+)\s*(day|days|week|weeks|month|months)\b/, (m) => {
         const n = /^(a|an)$/.test(m[1]) ? 1 : +m[1];
         const d = startOfDay(now);
         if (/^days?$/.test(m[2])) d.setDate(d.getDate() + n);
         else if (/^weeks?$/.test(m[2])) d.setDate(d.getDate() + n * 7);
         else d.setMonth(d.getMonth() + n);
         return d;
       })
    || hit(/\b(?:by\s+)?(?:the\s+)?end of (?:the\s+)?(day|week|month)\b/, (m) => {
         const d = startOfDay(now);
         if (m[1] === 'day') return d;
         if (m[1] === 'week') { d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7)); return d; }
         return new Date(d.getFullYear(), d.getMonth() + 1, 0);
       })
    || hit(/\b(?:eod|cob)\b/, () => startOfDay(now))
    || hit(/\beow\b/, () => { const d = startOfDay(now); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7)); return d; })
    || hit(/\bnext week\b/, () => { const d = startOfDay(now); d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7)); return d; })
    || hit(/\bnext month\b/, () => new Date(now.getFullYear(), now.getMonth() + 1, 1))
    || hit(/\b(next|this|on|by|before)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/,
         (m) => nextDow(now, DOW[m[2]], m[1] === 'next'));

  // A clock time and no day at all: "deploy the fix at 3pm". That is today, or
  // tomorrow if three has already gone - which is the reading a person would
  // give it, and returning nothing here dropped the deadline out of a sentence
  // that plainly had one.
  if (!cand) {
    if (hour === null) return null;
    const d = at(now, hour, minute);
    if (d <= now) d.setDate(d.getDate() + 1);
    return { at: d, text: timeText, timeText, hadTime: true };
  }
  const when = withTime(cand.at);
  // A time already in the past today, said with no date, means tomorrow. "send
  // it by 9am" typed at 3pm is not a task that is already nine hours overdue.
  if (/^(today|tonight|eod|cob)$/.test(cand.text) && when < now) when.setDate(when.getDate() + 1);
  if (isNaN(when.getTime())) return null;
  return { at: when, text: cand.text, timeText, hadTime: hour !== null };
}

// ------------------------------------------------------------------ the ask
// members: [{ id, name }] for the Space, so @mentions resolve to real people.
// me: the current user id, so "assign it to me" and "somebody else" differ.
export function parseAsk(text, { members = [], me = null, now = new Date() } = {}) {
  const raw = (text || '').trim();
  if (raw.length < 4 || NOT_ASK.test(raw)) return null;
  // A message that is only a link, or only an emoji, is not an instruction.
  if (/^https?:\/\/\S+$/.test(raw)) return null;

  const low = raw.toLowerCase();

  // ---- who
  // Longest name first, so "@Priya Raghavan" is not matched as "@Priya" leaving
  // "Raghavan" stranded in the title.
  const sorted = [...members].sort((a, b) => (b.name || '').length - (a.name || '').length);
  let assignee = null;
  let mentionText = '';
  for (const m of sorted) {
    if (!m.name) continue;
    const re = new RegExp('@' + m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i');
    const hit = raw.match(re);
    if (hit) { assignee = m.id; mentionText = hit[0]; break; }
  }
  const unowned = UNOWNED_TEST.test(low);
  const selfCommit = SELF_TEST.test(low);
  if (!assignee && selfCommit) assignee = me;

  // ---- when
  const due = parseDue(raw, now);

  // ---- is it an ask at all
  const politeHit = POLITE.find((p) => low.includes(p));
  const verbHit = ASK_VERBS.find((v) => new RegExp('(^|[^a-z])' + v + '([^a-z]|$)', 'i').test(low));

  // Confidence is a plain sum, and deliberately legible: you can read a
  // suggestion and say exactly which signals produced it.
  let score = 0;
  if (assignee && assignee !== me) score += 2;   // named somebody
  if (unowned) score += 2;                       // named the room
  if (selfCommit) score += 2;                    // named themselves
  if (politeHit) score += 2;
  if (verbHit) score += 1;
  if (due) score += 2;
  if (/\?\s*$/.test(raw) && !politeHit && !verbHit) score -= 2;   // a question, not an instruction
  if (raw.split(/\s+/).length < 3) score -= 2;

  // Four is "two independent signals agreed". Three suggested on far too much
  // ordinary conversation when this was tried against real channel text: a
  // mention plus any verb is just talking to somebody.
  if (score < 4) return null;

  // ---- what
  let title = raw;
  if (mentionText) title = title.replace(mentionText, ' ');
  if (due) {
    title = title.replace(new RegExp('\\b(?:by|before|on|due)\\s+' + due.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    title = title.replace(new RegExp(due.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    if (due.timeText) title = title.replace(due.timeText, ' ');
  }
  for (const p of POLITE) {
    title = title.replace(new RegExp('(^|[^a-z])' + p + '([^a-z]|$)', 'gi'), '$1 ');
  }
  title = title
    .replace(UNOWNED, ' ')
    .replace(SELF, ' ')
    .replace(/@[\w.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Cutting a date phrase out of the middle of a sentence leaves the
    // preposition that pointed at it: "book the training room for 22 Aug"
    // becomes "Book the training room for". Trailing scaffolding, not content.
    .replace(/\s+(?:by|before|on|at|for|due|until|till|to|in|from|and|then)\s*$/i, '')
    .replace(/^(?:and|then|so|also|just)\s+/i, '')
    .replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, '')
    .trim();

  // Whatever is left has to be a thing somebody could do. If stripping the
  // scaffolding left two words, the sentence was scaffolding.
  if (title.split(/\s+/).length < 2) return null;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (title.length > 140) title = title.slice(0, 137).replace(/\s\S*$/, '') + '…';

  return {
    title,
    assignee: unowned && !mentionText ? null : assignee,
    due: due ? due.at : null,
    dueHadTime: !!due?.hadTime,
    unowned: unowned && !mentionText,
    selfCommit,
    score,
    // Named so the confirm strip can explain itself. A suggestion that shows its
    // reasoning gets corrected instead of dismissed.
    why: [
      assignee && assignee !== me ? 'named someone' : null,
      unowned ? 'asked the room' : null,
      selfCommit ? 'you said you would' : null,
      politeHit ? 'a request' : null,
      verbHit ? `"${verbHit}"` : null,
      due ? 'a deadline' : null,
    ].filter(Boolean),
  };
}

// ------------------------------------------------------------------ phrasing
// How a due date is said back to somebody who has never used a tracker. "Due
// 2026-08-14T18:00:00" is correct and useless; "Friday 6pm" is what they typed
// and what they will check against.
export function sayDue(d, now = new Date()) {
  if (!d) return '';
  const day = startOfDay(d);
  const today = startOfDay(now);
  const days = Math.round((day - today) / 86400000);
  const time = d.getHours() === 0 && d.getMinutes() === 0
    ? '' : ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })
      .replace(':00', '').toLowerCase().replace(/\s/g, '');
  if (days === 0) return 'today' + time;
  if (days === 1) return 'tomorrow' + time;
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'long' }).toLowerCase() + time;
  if (days < 0) return 'overdue';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + time;
}
