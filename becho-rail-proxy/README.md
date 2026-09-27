# Becho Rail Proxy

Cloudflare Worker for real-time public transport data — departures, journey planning, and facility status.

## Data Sources

| Source | Status | Used for |
|---|---|---|
| BVG API (`v6.bvg.transport.rest`) | ✅ Working | Station search, departures, journey planning |
| DB API Marketplace (`api.deutschebahn.com`) | ❌ Error 1016 | Fallback for StaDa, Fahrplan, FaSta |

> **Note:** `api.deutschebahn.com` is behind Cloudflare and returns error 1016 (Origin DNS) when called from a Cloudflare Worker. This is a DNS issue on the Deutsche Bahn side and cannot be fixed from the Worker.

## Endpoints

### Station Search
```
GET /?station=Berlin
```
Returns up to 10 matching stations with their BVG IDs.

### Departures
```
GET /?id=<station_id>
GET /?id=<station_id>&group=1       # Group by line
GET /?id=<station_id>&line=ICE       # Filter by line name
GET /?id=<station_id>&lineType=suburban  # Filter by line type
```

Returns real-time departures for the next 60 minutes.

### Journey Planning
```
GET /?from=Berlin Hbf&to=Alexanderplatz    # By station name
GET /?fromId=<id>&toId=<id>                # By station ID
```

Returns up to 5 journey options with legs, transfers, and timing.

### Facility Status (FaSta)
```
GET /?facilities=8011160
```

Returns elevator/escalator status. Currently unavailable due to DB API error 1016.

### Debug
```
GET /?station=Berlin&debug=1
```

Adds a `diagnostics` array to the response with step-by-step API call details.

## Setup

### Prerequisites
- A Cloudflare account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed

### Deploy
```bash
wrangler deploy
```

### Set Secrets
```bash
wrangler secret put DB_API_CLIENT_ID
wrangler secret put DB_API_CLIENT_SECRET
```

Get free credentials at [https://api.deutschebahn.com](https://api.deutschebahn.com).

## Frontend Integration

The Worker is deployed at:
```
https://becho-rail-proxy.grackiglas.workers.dev
```

CORS is enabled (`Access-Control-Allow-Origin: *`), so it can be called directly from browser-based apps.

### Example Usage
```js
// Search stations
fetch("https://becho-rail-proxy.grackiglas.workers.dev/?station=Berlin")
  .then(r => r.json())
  .then(data => console.log(data.stations));

// Departures grouped by line
fetch("https://becho-rail-proxy.grackiglas.workers.dev/?id=de:11000:900003201&group=1")
  .then(r => r.json())
  .then(data => console.log(data.byLine));

// Journey planning
fetch("https://becho-rail-proxy.grackiglas.workers.dev/?from=Berlin Hbf&to=Alexanderplatz")
  .then(r => r.json())
  .then(data => console.log(data.journeys));
```

## License

MIT
