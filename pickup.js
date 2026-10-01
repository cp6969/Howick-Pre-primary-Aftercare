// Decides whether a person is on a child's pickup list, from the free-text
// "Authorized pickups" field (children.pickup_notes), e.g.
//   "Grandmother (Nomsa), Aftercare van"   "Father only"   "Mother, Au pair (Sarah)"
//
// Rules:
//  - Empty notes: there is no list on file, so nobody is flagged.
//  - Any entry containing the word "only" makes the list restrictive: only
//    the listed people may collect ("Father only" means Mother is flagged).
//  - Otherwise parents are always allowed (Mother, Father, or the parent name
//    on file), plus everyone listed.
//  - An entry matches the whole entry, the part outside brackets, or the name
//    inside brackets: "Grandmother (Nomsa)" matches "Grandmother", "Nomsa"
//    and "Grandmother (Nomsa)".

const PARENT_WORDS = ['mother', 'father', 'mom', 'mum', 'dad', 'parent'];

function norm(s) {
  return String(s || '').toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim();
}

function parsePickupNotes(notes) {
  const raw = String(notes || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  const restricted = raw.some((e) => /\bonly\b/i.test(e));
  const entries = raw.map((e) => e.replace(/\bonly\b/gi, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { entries, restricted };
}

function entryMatches(entry, who) {
  const whole = norm(entry);
  const outside = norm(entry.replace(/\([^)]*\)/g, ''));
  const inside = (entry.match(/\(([^)]*)\)/) || [])[1];
  return who === whole || (outside && who === outside) || (inside && who === norm(inside));
}

// child: { full_name, parent_name, pickup_notes }
function checkPickup(child, collectedBy) {
  const who = norm(collectedBy);
  const { entries, restricted } = parsePickupNotes(child.pickup_notes);
  if (!entries.length) return { ok: true, has_list: false, restricted: false, allowed: [] };

  let ok = entries.some((e) => entryMatches(e, who));
  if (!ok && !restricted) {
    ok = PARENT_WORDS.includes(who) || (!!child.parent_name && who === norm(child.parent_name));
  }
  const allowed = restricted ? entries : ['Mother', 'Father'].concat(entries.filter((e) => !PARENT_WORDS.includes(norm(e))));
  return { ok, has_list: true, restricted, allowed };
}

module.exports = { checkPickup, parsePickupNotes };
