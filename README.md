# TripFlow

An all-in-one travel planning platform — search destinations, discover attractions/restaurants/hotels, build a drag-and-drop day-by-day itinerary on an interactive map, generate AI trip ideas, track budget, and collaborate with friends, all in one place.

Inspired by the interaction patterns of Tripadvisor, Expedia, Google Maps, Yelp and Wanderlog.

## Run locally

No build step or API keys required. Serve the folder with any static server, e.g.:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## What's included

- **Home** — hero search, "Surprise Me" AI trip idea generator, trending destinations
- **Discover** — curated destination collections (trending, beach, adventure, food, romantic, affordable, hidden gems)
- **Destination dashboard** — Overview, Things To Do, Restaurants, Hotels, Itinerary, Map, Trip Ideas tabs, each with working filters
- **Trip Ideas generator** — 9 themed trip concepts per destination (food, culture, nightlife, shopping, relaxation, art, adventure, romance, hidden gems); every "Generate" click produces a genuinely new, randomized set of places, and each idea is customizable and saveable
- **Trip Planner** — drag-and-drop day-by-day itinerary, interactive map, route optimization, notes/comments/voting, transit between stops
- **Interactive map** — Google-Maps-style basemap (light/dark) with a Map/Satellite toggle, categorized markers, live popups
- **Budget tracker** — auto-calculated category breakdown, manual expenses, budget style (Budget/Moderate/Luxury), over-budget warnings
- **My Trips** — dashboard of all trips with open/edit/duplicate/share/delete
- **Saved** — Google Maps-style collections
- **Assistant** — a floating chat that needs **no API key, no account and no network**. It answers from the app's own data and edits your itinerary directly: "plan 5 days in Rome", "add Senso-ji to day 2", "day 1 is too packed", "optimise my route", "how's my budget?", "do I need a visa?", "hidden gems in Bali", "cheap eats under $15". It remembers the conversation, so "add the second one to day 2" works. Optionally connect your own provider key for open-ended chat on top — the assistant is fully functional without one. See `assistant.js`.

## Data

Twelve real destinations ship with rich hand-authored data (attractions, restaurants, hotels, reviews) **and real photography committed to the repo** under `images/` — every destination and every place on it gets a different photograph, none repeated — so the site is photography-first on first paint, with no placeholder flash, and it looks the same with the network blocked, throttled or offline. `photos.js` indexes those files and `CREDITS.md` carries the author and licence for every one; see `tools/README.md` for how each photo is matched and verified.

Type in **any other city worldwide** and TripFlow shows an instant starter page, then upgrades itself in the background using free, keyless public APIs:

- **Nominatim (OpenStreetMap)** geocodes the destination for accurate placement.
- **Wikipedia's GeoSearch API** finds real nearby landmarks — real names, descriptions and photos — no fictional attractions for real cities.
- **Wikipedia's REST summary API** fetches a real photo for every named place across the app.
- Map tiles come from **CARTO** (light/dark "Voyager"/"Dark Matter" basemaps) and **Esri** (satellite), giving a Google-Maps-style look with a Map/Satellite toggle — no billed API key required.

Every live lookup is cached in `localStorage` and fails gracefully. Nothing ever shows a broken image: an image that fails walks down its own priority chain to another real photograph — the specific place, then its neighbourhood, then a real category photograph — and only a place with no photograph anywhere falls back to a generated name card.

State (trips, saved collections, settings, theme) also persists to `localStorage` for a working demo without a backend.

## Tech

Vanilla HTML/CSS/JS, no build step, no bundler. External dependencies (all keyless, all via CDN): Leaflet (maps), Font Awesome (icons), and the live data sources above.
