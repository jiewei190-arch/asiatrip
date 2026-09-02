# Image pipeline

The curated destinations and their places ship with **real photographs committed under
`images/`**, so the site is photography-first on first paint and stays that way with the
network blocked, throttled or offline. The live Wikipedia lookup in `data.js` still runs — it
is what serves the *worldwide* destinations a visitor types in, not the built-in twelve.

## Scripts

| Script | What it does |
|---|---|
| `import-images.py` | Searches Wikipedia for each destination/place/dish, picks the best-matching article's lead photo, re-encodes it to a web-sized progressive JPEG under `images/`, and records author + licence. |
| `build-photo-index.py` | Writes `photos.js` (the bundled-image index consulted by `data.js`) and `CREDITS.md` from the import results. |
| `import-scenes.py` | Collects a pool of distinct, notable landmark photos per destination, used to give every photo-less card a different real local image. |
| `audit-images.js` | Renders the real site in Chromium at desktop and mobile sizes and fails on any broken image, leftover placeholder, or console error. |
| `audit-duplicates.js` | Walks every destination's tabs and reports any image rendered more than once, comparing by file content rather than by name. |

## How a photo is chosen

Matching a place name to the right article is most of the work. In order:

1. **Title relevance** — symmetric (F1) token overlap, so a title that *adds* a contradicting
   word is penalised as much as one that drops a word. For "Meiji Jingu Shrine", `Meiji
   Shrine` (0.80) correctly beats `Meiji Jingu Stadium` (0.67).
2. **Disambiguation suffixes are not mismatches** — `Queenstown, New Zealand` is scored as
   "Queenstown". Without this the correct article lost to `Queenstown Airport`.
3. **Transliteration tolerance** — `Marrakech` matches the article spelled `Marrakesh`.
4. **Geography decides ties** — a candidate must sit within a radius of the real
   coordinates. Title similarity alone matched "The Ludlow Hotel" (New York) to a pub in
   Shropshire and "Hotel Borg" (Reykjavik) to one in the Faroes; the coordinate check ends
   that whole class of error, and rejects abstractions ("Sushi", "Hyatt") which have no
   coordinates at all.
5. **Graphics are rejected by pixels, not filenames** — Santorini's own article leads with
   `2011_Dimos_Thiras.png`, a municipality map: nothing in that name says "map" and it is not
   an SVG. A photograph carries hundreds of distinct colours with no single one dominating; a
   map is a few flat fills over one background. Anything that looks flat is skipped and the
   next candidate is tried.
6. **Heroes reject infrastructure** — an airport or bus station really is in the city and
   really is photographed, but it is not what makes anyone want to go.

A target with no confident match is left out of the index on purpose. It then falls to a real
category photograph, and only failing that to the generated name card — never to a
loosely-related photo passed off as the place.

## No card repeats another

Every place lacking a photograph of its own used to fall back to the same destination-level
shot — Marrakech rendered one identical photo on seven cards. Three things now prevent that:

1. **A scene pool per destination.** `import-scenes.py` collects eight distinct nearby
   landmarks, ranked by Wikipedia's *search* relevance rather than raw proximity — ranking by
   distance returned "Eifukuchō Station" and "Takachiho University" for Tokyo, which are real
   but nothing anyone travels to see. The search radius scales to how far each destination's
   own places actually spread, so Yokohama (26km away, a different city) stays out of Tokyo
   while Bali, whose temples sit tens of kilometres apart, stays whole.
2. **Claiming.** Each image can be taken once per destination; a place whose preferred image
   is already spoken for moves to its next option. Resolution runs in passes so priority beats
   array order: "La Mamounia Restaurant" is inside the La Mamounia hotel and both legitimately
   match the same building, but the building's photo belongs to the hotel and the restaurant
   is better served by a plate of what it cooks.
3. **Content-level de-duplication at index time.** Claiming keys on path, so it cannot see
   that two different filenames hold identical bytes. `build-photo-index.py` collapses those,
   keeping one key per distinct image so the loser falls through to its next option.

`audit-duplicates.js` is what proves it: 15 places per destination, 15 distinct images, across
all twelve, on top of 12 unique destination heroes.

One thing deliberately *not* deduplicated: a destination listed in several Discover
collections shows its own hero each time. Handing repeat appearances an arbitrary nearby
landmark did dedupe the page, but it put a satellite image of the caldera on Santorini's
Beach card and the Catacombs on Paris's food card. A destination card has to sell the
destination, so the best photo repeats rather than a worse one being substituted.

## Honesty rules

- `photos.js` grades every entry: `1` = the photo depicts that place itself, `2` = an honest
  stand-in showing the neighbourhood it sits in. Nothing in the UI presents a `2` as being of
  the property, and `CREDITS.md` labels every one.
- Hotels fall back to the *street they are on* before any generic interior. A photo of the
  neighbourhood claims nothing about a hotel's rooms; a stock bedroom would imply it is
  theirs. Only when neither exists does a star-graded accommodation photo appear.
- Restaurants prefer a photo of the restaurant, then a real plate of the cuisine they cook,
  then their neighbourhood. One dish photo is used at most once per destination.
- Generated demo entries for typed-in cities use generic category photography, clearly
  category-level, and are upgraded in place the moment a real photo of the actual place
  resolves.

## Running it

```
pip install Pillow
python3 tools/import-images.py                       # full import (slow: Wikipedia rate-limits)
python3 tools/import-images.py --manifest=<file>     # re-run a subset
python3 tools/build-photo-index.py                   # regenerate photos.js + CREDITS.md
node tools/audit-images.js                           # verify in a real browser
```

`import-images.py` reads its target list from `$TRIPFLOW_WORK/manifest.json` (default
`tools/.work/`). `audit-images.js` needs a static server on `127.0.0.1:8099` and Playwright;
set `CHROMIUM_PATH` if Chromium is not in Playwright's default location.
