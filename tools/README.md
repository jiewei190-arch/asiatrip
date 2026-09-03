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
| `test-assistant.js` | Drives the real assistant in the page over ~35 realistic phrasings and prints each answer. |
| `test-assistant-stress.js` | Feeds it empty, malformed, hostile and absurd input; fails on any throw, empty reply or page error. |
| `test-destination-ambiguity.js` | Shows the suggestions for ambiguous names and flags any two a user could not tell apart. |
| `test-destination-consistency.js` | Asserts that a destination's name, country, flag, coordinates and canonical id all come from the same resolved place. Includes the two strings that produced the bug. |
| `test-entity-imagery.js` | Runs the shipped entity resolver against named landmarks; reports which rung answered. |
| `test-wikidata-images.js` | Exercises the Wikidata P18 → Commons thumbnail rung in isolation. |
| `audit-image-accuracy.js` | Reports, per destination, WHICH rung produced its photo and from which article — so a wrong-place image is visible instead of counting as a success. |
| `test-destination-page.js` | Opens a typed-in destination's page with recorded payloads and reports what every image resolves to. |
| `test-global-imagery.js` | Runs the shipped geo + photo chain against the live network and reports real worldwide image coverage. |
| `test-geo-search.js` | Replays real recorded Photon/Wikipedia payloads (`geo-fixtures.json`) through the shipped `geo.js` and checks each test destination resolves with correct country, type and coordinates. |

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

## Global destination search

`geo.js` looks destinations up live; nothing about them is stored in the repo. Two keyless,
CORS-enabled providers:

1. **Photon** (`photon.komoot.io`) — an OSM geocoder built for type-ahead. With `lang=en` it
   returns English names ("Beijing", not "北京市") and structured place data. This answers
   almost everything.
2. **Wikipedia search** — for what Photon cannot do. Loose tourist regions are often absent
   from OSM as searchable places ("Amalfi Coast" returns a footpath in Australia), and
   abbreviations are not geocoder input ("NYC"). Wikipedia's answer is fed *back* through
   Photon, so the result still carries full structured data.

Nominatim is deliberately unused: its usage policy forbids autocomplete, and it refused these
queries outright when tested.

Two things were tuned by testing against real payloads, and both are worth keeping:

- **Provider order dominates the ranking.** Re-ranking on the typed string put *Roma, Texas*
  (population 11,000) above Rome, because "Roma" matches letter-for-letter and "Rome" does
  not. Photon already ranks by prominence, which is most of what "travel relevance" means, so
  type weight and a small string bonus adjust its order rather than replacing it.
- **A prefix match is not automatically a hit.** "NYC" matched *Nychyporivka*, a Ukrainian
  village starting with those three letters, which suppressed the fallback that finds New York
  City. A prefix now only counts when the result is not wildly longer than the query.

Type filtering is what keeps a railway station out of "Beijing" and hospitals out of "NYC":
only place kinds in `GEO_TYPE_RANK` can appear. Country flags are computed from the ISO 3166
alpha-2 code via regional indicator symbols — no table to maintain.

## Imagery for a destination anywhere

`resolveDestinationPhoto` in `data.js`. Measured across 51 places on six continents, not
assumed — and the measuring found more bugs than the building did:

| Symptom | Cause | Fix |
|---|---|---|
| "Vinales" showed a MotoGP rider | Search by name can match a person | A candidate must carry coordinates near the destination; people have none |
| Faroe Islands showed its flag, Socotra a satellite frame | No filename filter at runtime | Reject flags, seals, satellite frames and rendered vector graphics |
| A map of Patagonia passed the filter | `\bmap\b` finds no word boundary inside `Pat_map.PNG` — underscore is a word character | Separators become spaces before matching |
| Patagonia rejected its own article | A fixed 75km radius, against a region of a million km² whose article sits 606km from the geocoded centroid | The radius scales with place type: 40km for a village, 800km for a region, 2000km for a country |
| A run of destinations "had no photo" | Wikipedia throttles bursts with 429, and a refusal read as an answer | One retry with backoff; a refusal is never cached as a miss |

The ladder, in order: the destination's own article (vetted as the right place) → a real
photograph of a landmark within 10km → the same around the article's own coordinates, which
for a huge region is somewhere quite different → the country → the generated name card.

Every rung is a genuine photograph of somewhere the traveller is actually going. The last
rung is reached only for a place with no photograph of its own and nothing photographed
nearby — Patagonia is the one case in 51, since its lead image is a map and its centroid is
empty steppe.

## One destination, one identity

Ambiguous names must be distinguishable in the list, not merely present. "Victoria" returned
two rows both reading *Victoria — Texas, United States*, because OSM carries the county and
the city as separate places; to a traveller they are one destination. Suggestions sharing a
name, country and region now collapse to the most travel-relevant type, which freed the slot
that surfaced Victoria, Malta.

A page once displayed the caption **Malaysia** above the name **Seoul Korea**. The cause was
not the renderer: `geocodeCity()` ran an unfiltered Nominatim free-text search and took result
#1, which for a typed string returns *businesses*. Reproduced directly:

```
"Paris Texas"  ->  a PUB IN BUDAPEST named "Paris, Texas"   class=pub  country=Hungary
```

So the name came from what the user typed and the country from an unrelated shop that happened
to share it. Three changes make that structurally impossible:

1. **Geocoding only returns places.** A result must be an administrative area, settlement,
   island, park or landmark. Businesses can no longer define a destination's country.
2. **Identity is written once, at creation.** Background enrichment adds attractions; it may no
   longer restate name, country or coordinates for a destination that arrived verified. A late
   response cannot repaint an identity.
3. **A canonical place id.** Every resolved destination carries `placeId` — OSM's stable
   type+id pair — and the photo cache and lookups key off it, so "dest:paris" can no longer be
   shared by Paris, France and Paris, Texas.

`geoValidateDestination()` refuses to render a destination whose fields disagree, and
`test-destination-consistency.js` asserts the whole thing across continents, including the two
exact strings from the bug report.

**On Google Places:** it is not used, and cannot be without changing a decision you made
earlier — it requires an API key with billing enabled, and this app was explicitly built to
need no key from anyone. Photon/OSM provides the same guarantees keylessly: a stable canonical
id, verified coordinates, and a country that comes from the same record as the name.

## Restaurants: labelled, not disguised

Only about 4% of restaurants carry any image reference in the free data, so most food cards
necessarily show a dish rather than the premises. Two instructions were in tension — "no
random generic food" and "any related food photo is fine" — and the resolution is that
showing one is fine, letting it be MISTAKEN for the restaurant is not. Cards using a category
or cuisine stand-in now carry a small "Illustrative" mark. The card stays appetising and
nobody is misled about what they are looking at.

`test-phase2-imagery.js` runs the full Phase 2 list: cities, countries, towns, villages and
ambiguous pairs, asserting the country is right AND an image resolved. Paris, Texas resolves
to its own Eiffel Tower replica; London, Ontario to its own skyline.

## Countries: the Wikivoyage banner

Countries resolved to nothing for a long time, and the reason is worth recording: most
countries' Wikidata P18 is a satellite photograph or a relief map — Japan's is "Satellite
image of Japan", Brazil's "Brazil topo.jpg", Australia's "Australia satellite plane.jpg".
The filters were right to reject them; there was simply nothing else being tried.

Wikidata P948 is the Wikivoyage banner: an image editors chose to represent the place **to
travellers**. It is exactly the right property for a destination hero and is preferred over
P18 for destinations, while named entities still take P18 first (there it is a photograph of
the thing itself). Countries went from 2/6 to 6/6 — Egypt returns camels and pyramids, Japan
lanterns, Italy Florence, Australia Uluru at sunset.

## Destination imagery vs entity imagery

These need opposite things, and conflating them regresses both.

A **named entity** wants the photograph taken at its coordinates — Commons geosearch.
A **destination** wants the image that REPRESENTS it, which proximity cannot supply: geosearch
at a city centroid offered the Tokyo International Forum's roof for Tokyo, a church for Reine
and a waterfall for Hallstatt, displacing the skyline, the fjord and the village square. So
destinations skip geosearch entirely and use the representative ladder: their own verified
article, then Wikidata P18 (a curated image, which is what a country needs — a country's own
article usually leads with a flag).

`test-destination-imagery.js` covers this; `test-entity-imagery.js` covers named entities.

## Entity imagery (Phase 2)

`imagery.js` is the one resolver. Overpass was the intended entity source and proved
unusable here — slow (tens of seconds), 406 without an `Accept` header, and 429 under any
load. **Wikimedia Commons geosearch replaced it and is better**: Commons geotags its media,
so asking "what photographs were taken at these coordinates?" returns pictures of the thing
standing there, over infrastructure that answers reliably.

Containing the entity's name is not enough, and the two ways that fails are both common:

| File title | Why it is wrong | Handling |
|---|---|---|
| `Rainbow Bridge from Tokyo Tower` | taken FROM the entity, of something else | rejected outright |
| `Infant and Skull, Medieval, Louvre` | an object INSIDE it, not the place | rejected — another subject is named first |
| `Louvre - panoramio (11)` | the entity leads the title | accepted at 92 |
| `Detail of Tokyo Tower 2011` | short qualifier, still of the entity | accepted at 80 |

Position carries the signal: a photograph OF something names it first. Verified on nine real
landmarks and hotels — Eiffel Tower, Colosseum, Sagrada Família, Louvre, Sensō-ji, Shibuya
Sky, Tokyo Tower, Marina Bay Sands — all now depict their entity.

## Image accuracy

Coverage and accuracy are different questions, and only the second one matters to a traveller.
`audit-image-accuracy.js` reports which rung answered for each destination, which is how these
were found — every one was a real wrong-place image being served:

| Wrong image | Why it passed | Rule added |
|---|---|---|
| A MotoGP rider for Viñales | Name search matches people | Candidate must carry coordinates |
| A generic Madagascar photo for Nosy Be | A country-level fallback existed | **Removed.** A photo of Madagascar is not a photo of Nosy Be |
| A municipality map for Santorini, a 10th-century map for Tuscany | Names say nothing about being maps | Photographs on Commons are JPEG; maps, flags and diagrams are PNG/SVG |
| Santorini's **airport terminal** | Infrastructure is genuinely in the destination | Heroes reject airports, stations, hospitals |
| A village hall, then a rural pub, then a reservoir, for the **state of Victoria** | A centroid in bushland, and Wikipedia titles every town as "Town, State" so the name test always passes | No landmark is used for a state, province or country at all |

The ladder: the destination's own article (coordinates within a type-scaled radius **and** the
title naming the place) → a landmark verifiably inside it → the name card. Nothing else.

The last rung is not a failure. A state whose centroid is farmland has no image that honestly
represents it, and a beautiful photograph of the wrong place is worse than none.

**What this does not do:** Google Images and Google Maps are not used — there is no API access
here, and scraping them would breach their terms and yield unstable URLs. Verification is done
against Wikipedia/Wikimedia structured data (coordinates, article titles, file formats), which
is what a visual check would be trying to establish anyway.

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

## Phase 2: real places, real maps, real money

`test-geo-integrity.js` — the regression guard for the Seoul-to-Spain bug. It reproduces the old
`20 + rnd()*40-20` formula, asserts it landed in Andalusia, and asserts the code that produced it
is gone. Also covers the three-layer containment test (country code, boundary box, radius), which
exists because no single one works at every scale: a radius around Japan's centroid exiles
Okinawa, and Japan's boundary box contains Seoul.

`test-places-ui.js` — drives the real destination UI in a headless browser using live captures in
`places-fixtures.json`, because the browser here has no outbound network. Proves a verified
destination gets its real coordinates, an unverified one draws no map at all, discovered
restaurants render with real names, and none of the old invented names or ratings can reappear.
Needs Playwright on NODE_PATH.

`test-global-places.js` — hits the real services for a spread of destination types worldwide and
checks geocoding, country, currency, discovery and containment together. Not mocked, so a failure
here is something a traveller would have seen. The public Overpass mirrors throttle, so a lone
EMPTY row is worth re-running before believing it.

`build-currency-data.py` — regenerates `currency-data.js` (245 countries, 152 currencies) from the
ISO country-codes dataset. Rates are fetched live; the catalogue is bundled.

### Two things worth knowing about Overpass

It reports a query timeout as **HTTP 200 with an empty element list and a `remark` field**. Taken
at face value that reads as "this city has no hotels", which is exactly how Seoul's Stays tab came
back empty. `overpassQuery` checks for the remark.

Including relations (`nwr` rather than `nw`) took the Seoul hotel query from 16 seconds to a
timeout at 82. Almost nothing in these categories is mapped as a relation, so the queries use `nw`.

## Foundation audit: why discovery and imagery were inconsistent

Five root causes, found by reading the code rather than guessing:

1. **Discovery only ran for typed destinations.** `discoverPlacesFor` was reachable from
   `makeGenericDestination` and `applyGeoToDestination` only — both typed-destination paths — so
   the twelve curated destinations never ran it and showed their hand-written handful, while
   anywhere else got hundreds. It now runs when ANY destination is opened.

2. **Enrichment deleted what discovery found.** `applyEnrichment` spliced out every existing
   attraction before pushing its own Wikipedia-derived list. Enrichment usually finishes first,
   so it wiped several hundred discovered attractions. It merges now.

3. **The stand-in pool held six photographs.** `categoryPhoto()` maps a whole category to one
   image, so a page of restaurants was one plate of food repeated. The pool is now every
   category and cuisine photograph that actually ships (41 food, 6 stay, 5 sight).

4. **Place images fell back to the city.** `photoQuery` ended its chain with the bare
   destination name, so any place without its own photograph resolved to the city's — one Tokyo
   skyline measured on **308 cards**. A place now searches only for itself.

5. **The search x was a close button.** `id="gsearchClose"`, wired to
   `panel.classList.remove('show')`. It clears now; a second press on an empty field closes.

### Known gap: the attraction stand-in pool

Only five attraction photographs ship (cathedral, museum, old-town, promenade, viewpoint). Real
photographs cover most of a visible page, but where they run out those five must be shared. They
are distributed evenly and marked "Illustrative", never clustered — but enlarging that pool is
the honest remaining fix, and matters more than any further code change here.

`test-foundation.js` covers all five, in a browser, against live services.

## Exact-place image verification

The question a candidate must answer is "does this photograph show THIS place", not "is this
about the destination". `test-image-accuracy.js` pins that down against titles that must be
accepted and titles that must be rejected, then resolves real venues of each category live.

Candidates are gathered from several sources and scored against the entity's full identity —
name, local name, street, house number, city, category — then the best clears a bar or nothing
is shown. Sources run in order of yield per second: Commons text search answers in under a
second at confidence 98-119, so the authoritative but slow Overpass lookup is only consulted
when it has not already cleared the high bar. Asking Overpass first cost 8.5 seconds per card
for an answer that usually was not there; the same photograph now resolves in 434 ms.

**Generic stand-ins are gone.** There is no category or cuisine pool any more. A card shows a
photograph of itself or an honest empty state naming what kind of place it is. A plate of pasta
on a card headed "Trattoria da Enzo" is indistinguishable from a real photograph of the place,
and that is the problem with it.

### On image coverage, honestly

There is no single coverage percentage worth quoting, and measuring one taught me why. Two runs
against Paris gave 100% and 25%, because discovery returned different place sets and the samples
were different places: the first happened to catch landmarks, the second caught Ben's Cookies
and Crêperie Elo. Coverage is a property of how notable a place is, not of this code.

What holds regardless: a place with a photograph on Commons gets it, verified against its own
name, street, city and category. A place without one shows an honest empty state. Two misses
worth understanding, both correct decisions rather than bugs:

- **Bouillon Julien** — Commons holds "Brasserie Julien" for the same venue. A similar-but-not-
  equal name is explicitly on the reject list, and being wrong here would put a different
  restaurant on the card.
- **Le Buci** — Commons genuinely holds nothing.
