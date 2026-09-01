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
- **Trip Ideas generator** — 5 themed trip concepts per destination (food, culture, nightlife, shopping, relaxation), customizable and saveable
- **Trip Planner** — drag-and-drop day-by-day itinerary, interactive Leaflet map, route optimization, notes/comments/voting, transit between stops
- **Budget tracker** — auto-calculated category breakdown, manual expenses, budget style (Budget/Moderate/Luxury), over-budget warnings
- **My Trips** — dashboard of all trips with open/edit/duplicate/share/delete
- **Saved** — Google Maps-style collections
- **AI assistant** — floating chat that can actually modify your itinerary (optimize routes, adjust budget, rearrange days, find alternatives); works out of the box with a rule-based engine, or connect a free Gemini API key for open-ended Q&A

## Data

Twelve real destinations ship with rich mock data (attractions, restaurants, hotels, reviews). Any other destination typed into search gets a deterministic, procedurally generated starter dataset so the app never hits a dead end.

State (trips, saved collections, settings, theme) persists to `localStorage` for a working demo without a backend.

## Tech

Vanilla HTML/CSS/JS, no build step, no dependencies besides Leaflet (maps) and Font Awesome (icons) via CDN.
