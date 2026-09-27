// ═══════════════════════════════════════════════════════════════
// becho-rail-proxy
// Real-time departures, journey planning & facility status
// for Deutsche Bahn / Berlin public transport
//
// Data sources (in order of preference):
//   1. BVG API (v6.bvg.transport.rest) — primary, works from Workers
//   2. DB API Marketplace (api.deutschebahn.com) — fallback, currently
//      blocked by Cloudflare error 1016 (Origin DNS)
//
// Secrets:
//   DB_API_CLIENT_ID     — DB API Marketplace client ID
//   DB_API_CLIENT_SECRET — DB API Marketplace client secret
// ═══════════════════════════════════════════════════════════════

// ─── Constants ─────────────────────────────────────────────────

const BVG_BASE = "https://v6.bvg.transport.rest";
const DB_OAUTH_URL = "https://api.deutschebahn.com/auth/realms/db-api-marketplace/protocol/openid-connect/token";
const DB_STADA_URL = "https://api.deutschebahn.com/stada/v2/stations";
const DB_FAHRPLAN_URL = "https://api.deutschebahn.com/fahrplan/v1/departureBoard";
const DB_FASTA_URL = "https://api.deutschebahn.com/fasta/v2/stations";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json; charset=utf-8",
};

// Well-known station names for nicer output
const STATION_NAMES = {
  "8011160": "Berlin Hbf",
  "8000105": "Frankfurt (Main) Hbf",
  "8098160": "München Hbf",
  "8002549": "Hamburg Hbf",
  "8000284": "Köln Hbf",
  "8000085": "Düsseldorf Hbf",
  "8000096": "Stuttgart Hbf",
  "8010222": "Leipzig Hbf",
  "8010039": "Dresden Hbf",
  "8000244": "Hannover Hbf",
};

// ─── Utilities ──────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS,
  });
}

function handlePreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function formatTime(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return null;
  }
}

function formatDuration(ms) {
  if (!ms) return null;
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? h + "h " + m + "m" : m + "m";
}

async function parseBody(resp) {
  const text = await resp.text();
  try {
    return { ok: true, json: JSON.parse(text), raw: text };
  } catch {
    return { ok: false, json: null, raw: text };
  }
}

// BVG stop IDs look like "de:11000:900003201".
// The departures endpoint only accepts the trailing numeric part.
function toNumericId(id) {
  const s = String(id);
  if (s.includes(":")) return s.split(":").pop();
  return s;
}

// ─── DB API OAuth ───────────────────────────────────────────────

let dbToken = null;
let dbTokenExpiry = 0;

async function getDbToken(env, log) {
  if (!env.DB_API_CLIENT_ID || !env.DB_API_CLIENT_SECRET) return null;
  if (dbToken && Date.now() < dbTokenExpiry - 60_000) return dbToken;

  try {
    const resp = await fetch(DB_OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "grant_type=client_credentials" +
        "&client_id=" + encodeURIComponent(env.DB_API_CLIENT_ID) +
        "&client_secret=" + encodeURIComponent(env.DB_API_CLIENT_SECRET),
    });
    const body = await parseBody(resp);
    if (log) log.push({ step: "db-oauth", status: resp.status, ok: resp.ok });

    if (resp.ok && body.ok && body.json.access_token) {
      dbToken = body.json.access_token;
      dbTokenExpiry = Date.now() + (body.json.expires_in || 3600) * 1000;
      return dbToken;
    }
  } catch (err) {
    if (log) log.push({ step: "db-oauth", error: err.message });
  }
  return null;
}

// ─── BVG: Station Search ────────────────────────────────────────

async function searchStations(query, log) {
  const url = BVG_BASE + "/stops?query=" + encodeURIComponent(query) + "&results=10&fuzzy=true";

  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await parseBody(resp);
    if (log) log.push({ step: "station-search", status: resp.status, ok: resp.ok });

    if (resp.ok && body.ok) {
      const stops = Array.isArray(body.json) ? body.json : body.json.stops || [];
      return stops.map((s) => ({
        id: String(s.id),
        name: s.name,
        type: s.type || null,
        location: s.location || null,
      }));
    }
  } catch (err) {
    if (log) log.push({ step: "station-search", error: err.message });
  }
  return null;
}

// ─── BVG: Departures ────────────────────────────────────────────

function mapDeparture(dep) {
  const when = dep.when || dep.plannedWhen || dep.plannedTime || null;
  const delay = dep.delay != null ? Math.round(dep.delay / 60) : null;
  const line = dep.line || {};

  let status = "on-time";
  if (dep.cancelled) status = "cancelled";
  else if (delay != null && delay > 0) status = "delayed";
  else if (delay != null && delay < 0) status = "early";

  return {
    id: dep.tripId || null,
    time: formatTime(when),
    when: when,
    delay: delay,
    line: line.name || line.productName || "Unknown",
    lineType: line.product || dep.product || "",
    direction: dep.direction || "Unknown",
    platform: dep.platform != null ? String(dep.platform) : null,
    cancelled: dep.cancelled || false,
    status,
  };
}

async function getDepartures(stationId, log) {
  const numId = toNumericId(stationId);
  const url = BVG_BASE + "/stops/" + encodeURIComponent(numId) + "/departures?duration=60&results=50";

  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await parseBody(resp);
    if (log) log.push({ step: "departures", status: resp.status, ok: resp.ok, numId });

    if (resp.ok && body.ok) {
      const deps = body.json.departures || [];
      const stop = body.json.stop || {};
      return {
        departures: deps.map(mapDeparture),
        stationName: stop.name || "Unknown",
      };
    }
  } catch (err) {
    if (log) log.push({ step: "departures", error: err.message });
  }
  return null;
}

// ─── BVG: Journey Planning ──────────────────────────────────────

function mapLeg(leg) {
  const line = leg.line || {};
  const depTime = leg.departure || leg.plannedDeparture || null;
  const arrTime = leg.arrival || leg.plannedArrival || null;
  const delay = leg.departureDelay != null ? Math.round(leg.departureDelay / 60) : null;

  return {
    mode: line.product || leg.type || "walking",
    line: line.name || null,
    lineType: line.product || null,
    direction: leg.direction || (leg.destination ? leg.destination.name : null),
    from: leg.origin ? leg.origin.name : null,
    to: leg.destination ? leg.destination.name : null,
    departure: formatTime(depTime),
    departureWhen: depTime,
    arrival: formatTime(arrTime),
    arrivalWhen: arrTime,
    delay,
    duration: formatDuration(leg.duration),
    cancelled: leg.cancelled || false,
  };
}

function mapJourney(j) {
  const legs = (j.legs || []).map(mapLeg);
  const first = legs[0];
  const last = legs[legs.length - 1];

  const transitLegs = legs.filter((l) => l.mode !== "walking");
  const transfers = Math.max(0, transitLegs.length - 1);

  return {
    id: j.id || null,
    departure: first ? first.departure : null,
    arrival: last ? last.arrival : null,
    duration: formatDuration(j.duration),
    transfers,
    legs,
    price: j.price || null,
  };
}

async function getJourneys(fromId, toId, log) {
  const from = toNumericId(fromId);
  const to = toNumericId(toId);
  const url = BVG_BASE + "/journeys?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to) + "&results=5&language=en";

  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await parseBody(resp);
    if (log) log.push({ step: "journeys", status: resp.status, ok: resp.ok });

    if (resp.ok && body.ok) {
      const journeys = (body.json.journeys || []).map(mapJourney);
      return { journeys, count: journeys.length };
    }
  } catch (err) {
    if (log) log.push({ step: "journeys", error: err.message });
  }
  return null;
}

// ─── DB API: FaSta (Facility Status) ────────────────────────────

async function getFacilities(token, stationId, log) {
  const url = DB_FASTA_URL + "/" + encodeURIComponent(stationId);

  try {
    const resp = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    const body = await parseBody(resp);
    if (log) log.push({ step: "fasta", status: resp.status, ok: resp.ok });

    if (resp.ok && body.ok) {
      const facilities = (body.json.facilities || []).map((f) => ({
        id: f.equipmentNumber,
        type: f.type,
        state: f.state,
        stateText: f.state ? f.state.replace(/_/g, " ") : null,
        description: f.description || null,
        location: f.geocoord
          ? { lat: f.geocoord.latitude, lon: f.geocoord.longitude }
          : null,
      }));

      return {
        facilities,
        summary: {
          total: facilities.length,
          active: facilities.filter((f) => f.state === "ACTIVE").length,
          inactive: facilities.filter((f) => f.state === "INACTIVE").length,
          unknown: facilities.filter((f) => f.state === "UNKNOWN").length,
        },
      };
    }
  } catch (err) {
    if (log) log.push({ step: "fasta", error: err.message });
  }
  return null;
}

// ─── DB API: Fallbacks ───────────────────────────────────────────

async function dbSearchStations(token, query, log) {
  const url = DB_STADA_URL + "?searchstring=" + encodeURIComponent(query);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    const body = await parseBody(resp);
    if (log) log.push({ step: "db-stada", status: resp.status, ok: resp.ok });
    if (resp.ok && body.ok) {
      return (body.json.result || [])
        .map((s) => ({
          id: s.evaNumbers?.[0] ? String(s.evaNumbers[0].number) : null,
          name: s.name,
          type: s.category ? "category-" + s.category : null,
          location: s.position?.wgs84Coordinates
            ? {
                lat: s.position.wgs84Coordinates.latitude,
                lon: s.position.wgs84Coordinates.longitude,
              }
            : null,
        }))
        .filter((s) => s.id);
    }
  } catch (err) {
    if (log) log.push({ step: "db-stada", error: err.message });
  }
  return null;
}

async function dbGetDepartures(token, stationId, log) {
  const date = new Date().toISOString().slice(0, 16);
  const url = DB_FAHRPLAN_URL + "/" + encodeURIComponent(stationId) + "?date=" + encodeURIComponent(date);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    const body = await parseBody(resp);
    if (log) log.push({ step: "db-fahrplan", status: resp.status, ok: resp.ok });
    if (resp.ok && body.ok) {
      return (body.json.departures || []).map((d) => ({
        id: d.detailsId || null,
        time: formatTime(d.dateTime ? d.dateTime + ":00" : null),
        delay: null,
        line: d.name || d.productName || "Unknown",
        lineType: d.type || d.product || "",
        direction: d.direction || "Unknown",
        platform: d.platform ? String(d.platform) : null,
        cancelled: false,
        status: "on-time",
      }));
    }
  } catch (err) {
    if (log) log.push({ step: "db-fahrplan", error: err.message });
  }
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────

function filterByLine(deps, line, lineType) {
  if (!line && !lineType) return deps;
  return deps.filter((d) => {
    let ok = true;
    if (line) ok = ok && d.line.toLowerCase().includes(line.toLowerCase());
    if (lineType) ok = ok && d.lineType.toLowerCase().includes(lineType.toLowerCase());
    return ok;
  });
}

function groupByLine(deps) {
  const groups = {};
  for (const d of deps) {
    const key = d.line || "Unknown";
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  }
  return groups;
}

// ─── Main Handler ───────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return handlePreflight();
  if (request.method !== "GET") return json({ error: "Method not allowed. Use GET." }, 405);

  const debug = url.searchParams.get("debug") === "1";
  const log = debug ? [] : null;

  const station = url.searchParams.get("station");
  const id = url.searchParams.get("id");
  const facilities = url.searchParams.get("facilities");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const fromId = url.searchParams.get("fromId");
  const toId = url.searchParams.get("toId");
  const line = url.searchParams.get("line");
  const lineType = url.searchParams.get("lineType");
  const group = url.searchParams.get("group") === "1";

  // ── Root: show available endpoints ──
  if (!station && !id && !facilities && !from && !to && !fromId && !toId) {
    return json({
      service: "becho-rail-proxy",
      version: "7.0",
      description: "Real-time departures, journey planning & facility status for Berlin / DB transport.",
      endpoints: {
        "Search stations": "/?station=Berlin",
        "Departures": "/?id=<id>&group=1",
        "Journey (by name)": "/?from=Berlin Hbf&to=Alexanderplatz",
        "Journey (by ID)": "/?fromId=<id>&toId=<id>",
        "Facility status": "/?facilities=8011160",
        "Filter by line": "/?id=<id>&line=ICE",
        "Filter by type": "/?id=<id>&lineType=suburban",
      },
      tips: {
        group: "Add &group=1 to departures to group results by line.",
        debug: "Add &debug=1 to any request for diagnostics.",
      },
    });
  }

  // ── Journey planning ──
  if ((from && to) || (fromId && toId)) {
    let srcFrom = fromId;
    let srcTo = toId;
    let fromName = from || "Unknown";
    let toName = to || "Unknown";

    if (from && !fromId) {
      const results = await searchStations(from, log);
      if (results && results.length > 0) {
        srcFrom = results[0].id;
        fromName = results[0].name;
      }
    }
    if (to && !toId) {
      const results = await searchStations(to, log);
      if (results && results.length > 0) {
        srcTo = results[0].id;
        toName = results[0].name;
      }
    }

    if (!srcFrom || !srcTo) {
      return json({ error: "Could not find one or both stations.", from: fromName, to: toName, ...(log ? { diagnostics: log } : {}) }, 404);
    }

    const result = await getJourneys(srcFrom, srcTo, log);
    if (result && result.journeys.length > 0) {
      return json({
        from: { id: srcFrom, name: fromName },
        to: { id: srcTo, name: toName },
        journeys: result.journeys,
        count: result.count,
        source: "bvg",
        fetchedAt: new Date().toISOString(),
        ...(log ? { diagnostics: log } : {}),
      });
    }
    return json({
      from: { id: srcFrom, name: fromName },
      to: { id: srcTo, name: toName },
      journeys: [],
      count: 0,
      error: "No journeys found.",
      ...(log ? { diagnostics: log } : {}),
    }, 404);
  }

  // ── Facility status (FaSta) ──
  if (facilities) {
    const token = await getDbToken(env, log);
    if (token) {
      const result = await getFacilities(token, facilities, log);
      if (result) {
        return json({
          station: { id: facilities, name: STATION_NAMES[facilities] || "Unknown" },
          facilities: result.facilities,
          summary: result.summary,
          source: "db-fasta",
          fetchedAt: new Date().toISOString(),
          ...(log ? { diagnostics: log } : {}),
        });
      }
    }
    return json({
      station: { id: facilities, name: STATION_NAMES[facilities] || "Unknown" },
      facilities: [],
      summary: { total: 0, active: 0, inactive: 0, unknown: 0 },
      error: "FaSta unavailable (DB API returns error 1016 — Origin DNS).",
      ...(log ? { diagnostics: log } : {}),
    }, 404);
  }

  // ── Station search ──
  if (station) {
    const results = await searchStations(station, log);
    if (results && results.length > 0) {
      return json({
        query: station,
        stations: results,
        count: results.length,
        source: "bvg",
        hint: "Use ?id=<id> for departures or ?fromId=<id>&toId=<id> for journeys",
        ...(log ? { diagnostics: log } : {}),
      });
    }

    // Fallback: DB StaDa
    const token = await getDbToken(env, log);
    if (token) {
      const dbResults = await dbSearchStations(token, station, log);
      if (dbResults && dbResults.length > 0) {
        return json({
          query: station,
          stations: dbResults,
          count: dbResults.length,
          source: "db-stada",
          hint: "Use ?id=<id> for departures",
          ...(log ? { diagnostics: log } : {}),
        });
      }
    }

    return json({
      query: station,
      stations: [],
      count: 0,
      error: "No stations found.",
      ...(log ? { diagnostics: log } : {}),
    }, 404);
  }

  // ── Departures ──
  if (id) {
    let deps = null;
    let stationName = "Unknown";
    let source = "none";

    // 1. BVG (primary)
    const bvg = await getDepartures(id, log);
    if (bvg && bvg.departures.length > 0) {
      deps = bvg.departures;
      stationName = bvg.stationName;
      source = "bvg";
    }

    // 2. DB Fahrplan (fallback)
    if (!deps) {
      const token = await getDbToken(env, log);
      if (token) {
        const dbDeps = await dbGetDepartures(token, id, log);
        if (dbDeps && dbDeps.length > 0) {
          deps = dbDeps;
          source = "db-fahrplan";
        }
      }
    }

    if (!deps) {
      return json({
        station: { id, name: stationName },
        departures: [],
        count: 0,
        error: "No departures found.",
        ...(log ? { diagnostics: log } : {}),
      }, 404);
    }

    // Apply filters
    const filtered = filterByLine(deps, line, lineType);

    const response = {
      station: { id, name: stationName },
      count: filtered.length,
      source,
      fetchedAt: new Date().toISOString(),
      filters: { line: line || null, lineType: lineType || null },
      ...(log ? { diagnostics: log } : {}),
    };

    if (group) {
      response.byLine = groupByLine(filtered);
      response.lines = Object.keys(response.byLine).sort();
    } else {
      response.departures = filtered;
    }

    return json(response);
  }

  return json({ error: "No valid parameters. See / for available endpoints." }, 400);
}

// ─── Entry Point ────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return json({ error: "Internal error.", message: err.message }, 500);
    }
  },
};
