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
- **AI assistant** — floating chat that can actually modify your itinerary (optimize routes, adjust budget, rearrange days, find alternatives); works out of the box with a rule-based engine, or connect a free Gemini API key for open-ended Q&A

## Data

Twelve real destinations ship with rich hand-authored data (attractions, restaurants, hotels, reviews). Type in **any other city worldwide** and TripFlow shows an instant starter page, then upgrades itself in the background using free, keyless public APIs:

- **Nominatim (OpenStreetMap)** geocodes the destination for accurate placement.
- **Wikipedia's GeoSearch API** finds real nearby landmarks — real names, descriptions and photos — no fictional attractions for real cities.
- **Wikipedia's REST summary API** fetches a real photo for every named place across the app (falling back to a generated gradient placeholder when no photo is found or the network is unavailable).
- Map tiles come from **CARTO** (light/dark "Voyager"/"Dark Matter" basemaps) and **Esri** (satellite), giving a Google-Maps-style look with a Map/Satellite toggle — no billed API key required.

Every live lookup is cached in `localStorage` and fails gracefully (offline, blocked, or slow networks fall back to the built-in placeholder data/images instantly — nothing ever hangs or breaks).

State (trips, saved collections, settings, theme) also persists to `localStorage` for a working demo without a backend.

## Tech

Vanilla HTML/CSS/JS, no build step, no bundler. External dependencies (all keyless, all via CDN): Leaflet (maps), Font Awesome (icons), and the live data sources above.
