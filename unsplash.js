/* ============================================================================
 * unsplash.js — landmark and destination photography, verified and pinned.
 *
 * Wikimedia Commons is thorough about small, obscure places and thin about famous ones: it had
 * no photograph taken since 2019 for eight of the twelve destination heroes, and the Paris hero
 * dated from 2014. Unsplash is the opposite — deep on landmarks and cities, useless for a
 * specific back-street bistro — so it is used for exactly what it is good at.
 *
 * WHY THIS FILE IS DATA RATHER THAN A LIVE CALL
 * The Unsplash API needs a key, and this app has none by design: it is a static site on GitHub
 * Pages with no server to hold a secret. So the search happens once, during development,
 * through an authenticated connector, and what ships is the ANSWER: a permanent CDN URL that
 * any browser can load without credentials. No runtime key, no runtime dependency, no rate
 * limit on the traveller's side.
 *
 * WHAT IS AND IS NOT ALLOWED IN HERE
 * Every entry must be a photograph OF THE NAMED PLACE, checked at the time it was added against
 * the photo's own alt text and description. A generic "cafe" or "food" shot must never be added
 * for a specific venue — that is the exact thing this project removed from the curated
 * destinations, and re-introducing it through a different door would be worse for being harder
 * to spot.
 *
 * ATTRIBUTION
 * The Unsplash License permits free use, including commercially, without permission. It asks
 * that the photographer be credited, so every entry carries the name and profile link and the
 * UI renders them. `taken` is the photograph's own creation date, which lets the same recency
 * rule that governs Commons imagery apply here too.
 * ========================================================================== */

window.UNSPLASH_PHOTOS = {
  // key -> { id, url, alt, by, byUrl, taken }
  "dest/paris": {
    id: "uYrACAHq6jI",
    url: "https://images.unsplash.com/photo-1679231926688-ef9cdab5ed2f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "The Eiffel Tower towering over the city of Paris",
    by: "Timelab", byUrl: "https://unsplash.com/@timelabpro", taken: "2023-03-19",
  },
  "dest/tokyo": {
    id: "o4D-y_ldw7c",
    url: "https://images.unsplash.com/photo-1787612498827-0109e4693409?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "Aerial view of the illuminated Shibuya Crossing at night in Tokyo",
    by: "Brayden Law", byUrl: "https://unsplash.com/@braydenlaw", taken: "2026-08-24",
  },
  "dest/rome": {
    id: "qlvhFAhVXj8",
    url: "https://images.unsplash.com/photo-1787932442540-323f03fcefb4?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "The stone arches of the Colosseum in Rome under a clear blue sky",
    by: "Ana Mudalen", byUrl: "https://unsplash.com/@anamudalen", taken: "2026-08-28",
  },
  "dest/new-york": {
    id: "IU65ny0PKBU",
    url: "https://images.unsplash.com/photo-1788366367537-6896e3ae2341?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "Brooklyn Bridge and the New York City skyline at golden hour",
    by: "Sarah Louise Kinsella", byUrl: "https://unsplash.com/@sarahlouisekinsella", taken: "2026-09-02",
  },
  "dest/barcelona": {
    id: "FXnS1eMASso",
    url: "https://images.unsplash.com/photo-1787046793896-a6b62444f038?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "An aerial view of the Sagrada Familia and the city of Barcelona",
    by: "Dominik Mattern", byUrl: "https://unsplash.com/@dominikmattern", taken: "2026-08-18",
  },
  "dest/marrakech": {
    id: "Kloc39u0yhk",
    url: "https://images.unsplash.com/photo-1783869251087-66c331cb474c?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "The courtyard of a traditional Moroccan riad in Marrakech",
    by: "Simon Gagner", byUrl: "https://unsplash.com/@trendscope_se", taken: "2026-07-12",
  },
  "dest/santorini": {
    id: "kYxgm42SQso",
    url: "https://images.unsplash.com/photo-1570077188670-e3a8d69ac5ff?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "Santorini, Greece",
    by: "Pretty Pink", byUrl: "https://unsplash.com/@infinitexplorer", taken: "2019-10-03",
  },
  "dest/bangkok": {
    id: "7enOiBayyPg",
    url: "https://images.unsplash.com/photo-1779419183239-25222afb3b26?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "Wat Arun temple silhouetted against a sunset sky, Bangkok",
    by: "Ahmet Yuksek", byUrl: "https://unsplash.com/@ahmetyuksek", taken: "2026-05-22",
  },
  "dest/bali": {
    id: "zscPRX-c50M",
    url: "https://images.unsplash.com/photo-1786881929160-83b8e00a5a11?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "A villa overlooking the Sidemen rice terraces, Bali",
    by: "Rowan Heuvel", byUrl: "https://unsplash.com/@insolitus", taken: "2026-08-16",
  },
  "dest/reykjavik": {
    id: "sTSjZ0mANTo",
    url: "https://images.unsplash.com/photo-1787946178180-6edb3320d24d?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "Hallgrimskirkja church and the Leif Erikson statue in Reykjavik",
    by: "NIR HIMI", byUrl: "https://unsplash.com/@nirhimi", taken: "2026-08-28",
  },
  "dest/ljubljana": {
    id: "wwKLeuAmwtM",
    url: "https://images.unsplash.com/photo-1773658088032-87e28148ea1b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixlib=rb-4.1.0&q=80&w=1080",
    alt: "Ljubljana Castle overlooking the city",
    by: "ALEKO KEZEVADZE", byUrl: "https://unsplash.com/@alexanderkez", taken: "2026-03-16",
  },

  /* Queenstown, New Zealand is deliberately absent, and this note is the record of why.
     Two searches returned only "a calm lake reflecting mountains" and "people walking on a
     concrete pier extending into a lake" — both by a New Zealand photographer, neither naming
     the place. A picture that is probably right is exactly what this project refuses: it looks
     identical to one that is right, and nobody can tell them apart afterwards. Queenstown keeps
     its Commons photograph, which is verified. Nothing goes in this table on a guess. */
};

/** One entry, or null. Kept as a function so callers never touch the table directly and the
 *  recency rule is applied in exactly one place. */
function unsplashPhoto(key){
  const table = (typeof window !== 'undefined' && window.UNSPLASH_PHOTOS) || {};
  const hit = table[key];
  if(!hit || !hit.url) return null;
  // The same window that governs Commons imagery. A landmark photograph from 2014 is no more
  // current here than it was there, and exempting this source would make the rule meaningless.
  if(typeof IMAGE_MIN_CAPTURE_YEAR !== 'undefined' && IMAGE_MIN_CAPTURE_YEAR != null){
    const year = parseInt(String(hit.taken || '').slice(0, 4), 10);
    if(!(year >= IMAGE_MIN_CAPTURE_YEAR)) return null;
  }
  return hit;
}
function unsplashUrl(key){ const p = unsplashPhoto(key); return p ? p.url : null; }

if(typeof module !== 'undefined' && module.exports){
  module.exports = { unsplashPhoto, unsplashUrl,
                     get UNSPLASH_PHOTOS(){ return (typeof window !== 'undefined' && window.UNSPLASH_PHOTOS) || {}; } };
}
