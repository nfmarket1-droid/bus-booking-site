import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  discoverActiveDates,
  enrichWithRoundtripPrices,
  fetchTourForDate,
  NO_SEASONAL_RETURN_DATES_MESSAGE,
  parseScheduleStops,
  type AlfTourResult,
  type RouteConfig,
} from '../_shared/alf-worker.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Each date triggers a single ALF request, time-boxed at ~12s. Keep the total
// batch count bounded so a full run finishes safely within the edge function's
// execution time limit.
const MAX_DATES_PER_RUN = 20;
// Kept modest with a short pause between batches (see below) — a big burst of
// concurrent requests (each date can trigger up to ~9 extra ALF requests to
// resolve "мало місць" and the child fare) was tripping ALF's rate limiting,
// which then made the calendar/ticket lookups fall back or fail entirely.
const CONCURRENCY = 3;
const BATCH_DELAY_MS = 700;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Direction = 'forward' | 'return';

type AlfRoute = {
  id: string;
  slug: string;
  name: string;
  origin_city: string;
  destination_city: string;
  town_from_inc: string;
  town_to_inc: string;
  port_to_inc: string;
  return_town_from_inc: string | null;
  return_town_to_inc: string | null;
  return_port_to_inc: string | null;
  class_code: string;
  route_class_text: string;
  carrier_name: string;
  base_departure_time: string;
  forward_schedule_source_url: string | null;
  return_schedule_source_url: string | null;
  is_active: boolean;
  sort_order: number;
  price_sync_interval_minutes: number;
  schedule_sync_interval_minutes: number;
  typical_roundtrip_days: number;
  last_price_sync_at: string | null;
  last_schedule_sync_at: string | null;
};

type SupabaseClient = ReturnType<typeof createClient>;

const isDue = (lastAt: string | null, intervalMinutes: number): boolean => {
  if (!lastAt) return true;
  return Date.now() - new Date(lastAt).getTime() >= intervalMinutes * 60_000;
};

// Syncs prices/seats for ONE direction of a route and writes a single alf_sync_runs
// log row for it (sync_type='prices') — this is what gives the worker log its
// per-route AND per-direction breakdown.
// Writes the dedicated "туди-назад" combo-price journal entry for one direction —
// e.g. "Київ → Вльора → Київ (туди-назад)" for the forward direction and
// "Вльора → Київ → Вльора (туди-назад)" for the return direction — summarizing the
// combined round-trip price probes that were already collected while syncing plain
// one-way prices for the same dates (no extra requests to ALF are made for this).
async function logRoundtripDirection(
  supabase: SupabaseClient,
  route: AlfRoute,
  direction: Direction,
  originCity: string,
  destinationCity: string,
  targetDates: string[],
  discoverySource: 'calendar' | 'fallback',
  results: AlfTourResult[],
) {
  const routeLabel = `${originCity} → ${destinationCity} → ${originCity} (туди-назад)`;
  const label = `${routeLabel} (${direction === 'forward' ? 'туди' : 'назад'})`;

  // Each date now discovers its own dynamic return-date calendar (see
  // enrichWithRoundtripPrices), so the "dates with a valid return option" count is
  // derived per-run from the actual results instead of one static pre-fetch.
  const validReturnDatesFound = results.filter((result) => result.roundtrip.returnDate !== null).length;

  let pricedCount = 0;
  let skippedCount = 0;
  let noDateOrEmptyCount = 0;
  const errors: { date: string; error: string }[] = [];

  // Unroll EVERY individually-priced departure+return combo into its OWN journal
  // row instead of collapsing them into a single "closest match" row per departure
  // date — otherwise e.g. "2026-10-10 → 2026-10-13", "→ 2026-10-20" and
  // "→ 2026-10-27" all get silently discarded except one.
  const resultsDebug: {
    date: string;
    status: string;
    price: number | null;
    returnDate: string | null;
    error: null;
    requestBody: Record<string, string>;
    responseSnippet: string;
  }[] = [];

  for (const result of results) {
    if (result.roundtripCombos.length > 0) {
      for (const combo of result.roundtripCombos) {
        pricedCount += 1;
        resultsDebug.push({
          date: result.isoDate,
          status: result.sourceStatus,
          price: combo.price,
          returnDate: combo.returnDate,
          error: null,
          requestBody: combo.requestBody,
          responseSnippet: combo.responseSnippet.slice(0, 2500),
        });
      }
      continue;
    }

    if (result.roundtrip.status === 'skipped') skippedCount += 1;
    else noDateOrEmptyCount += 1;

    // A departure date with genuinely no operator-scheduled return combo (off-season)
    // is expected real-world data, not a failure — don't surface it in the errors list.
    if (result.roundtrip.status === 'empty' && result.roundtrip.responseSnippet !== NO_SEASONAL_RETURN_DATES_MESSAGE) {
      errors.push({ date: result.isoDate, error: 'ALF не повернув комбо-ціну для цієї пари дат' });
    }

    resultsDebug.push({
      date: result.isoDate,
      status: result.roundtrip.status,
      price: result.roundtrip.price,
      returnDate: result.roundtrip.returnDate,
      error: null,
      requestBody: result.roundtrip.requestBody ?? {},
      responseSnippet: result.roundtrip.responseSnippet.slice(0, 2500),
    });
  }

  const sample = resultsDebug.find((item) => item.price !== null) ?? resultsDebug[0];

  console.log(`[sync-alf] [${label}] Комбо-ціни туди-назад: знайдено=${pricedCount}, порожньо/без дати=${noDateOrEmptyCount}, пропущено=${skippedCount}`);

  try {
    const { error: logError } = await supabase.from('alf_sync_runs').insert({
      route_id: route.id,
      route_name: routeLabel,
      sync_type: 'roundtrip',
      direction,
      calendar_source: discoverySource,
      calendar_dates_found: validReturnDatesFound,
      active_dates: targetDates,
      tours_updated: results.length,
      available_count: pricedCount,
      few_count: 0,
      sold_out_count: skippedCount,
      error_count: noDateOrEmptyCount,
      sample_request: sample?.requestBody ?? null,
      sample_response_snippet: sample?.responseSnippet ?? null,
      calendar_snippet: null,
      errors,
      results_debug: resultsDebug,
      fatal_error: null,
    });
    if (logError) console.error(`[sync-alf] [${label}] Не вдалося записати журнал комбо-цін`, logError.message);
  } catch (error) {
    console.error(`[sync-alf] [${label}] Виняток запису журналу комбо-цін`, error instanceof Error ? error.message : error);
  }
}

async function syncPricesDirection(
  supabase: SupabaseClient,
  route: AlfRoute,
  direction: Direction,
  routeConfig: RouteConfig,
  originCity: string,
  destinationCity: string,
) {
  const label = `${route.name} (${direction === 'forward' ? 'туди' : 'назад'})`;
  console.log(`[sync-alf] [${label}] Запуск синхронізації цін/місць`);

  let discoverySource: 'calendar' | 'fallback' = 'fallback';
  let calendarDatesFound = 0;
  let calendarSnippet = '';
  let targetDates: string[] = [];
  const results: AlfTourResult[] = [];
  let fatalError: string | null = null;

  try {
    const discovery = await discoverActiveDates(routeConfig);
    discoverySource = discovery.source;
    calendarDatesFound = discovery.isoDates.length;
    calendarSnippet = discovery.calendarSnippet;
    targetDates = discovery.isoDates.slice(0, MAX_DATES_PER_RUN);

    console.log(`[sync-alf] [${label}] Знайдено ${calendarDatesFound} активних дат (джерело: ${discoverySource}), опрацьовуємо ${targetDates.length}`);

    for (let i = 0; i < targetDates.length; i += CONCURRENCY) {
      if (i > 0) await sleep(BATCH_DELAY_MS);
      const batch = targetDates.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map((isoDate) => fetchTourForDate(routeConfig, isoDate, 1)));
      results.push(...batchResults);
    }

    // Combo ("туди-назад") prices are probed in a separate, strictly sequential pass
    // AFTER all one-way results are in — see enrichWithRoundtripPrices for why this
    // can't run concurrently with the one-way batch above. Each date's own valid
    // return-date calendar is now (re-)discovered dynamically inside this call.
    if (routeConfig.typicalRoundtripDays) {
      await enrichWithRoundtripPrices(routeConfig, results);
    }
  } catch (error) {
    fatalError = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(`[sync-alf] [${label}] Критична помилка виконання`, fatalError);
  }

  let availableCount = 0;
  let fewCount = 0;
  let soldOutCount = 0;
  let errorCount = 0;
  const errors: { date: string; error: string }[] = [];

  for (const result of results) {
    if (result.sourceStatus === 'available') availableCount += 1;
    else if (result.sourceStatus === 'few') fewCount += 1;
    else if (result.sourceStatus === 'sold_out') soldOutCount += 1;
    else errorCount += 1;

    if (result.error) errors.push({ date: result.isoDate, error: result.error });

    if (result.roundtripCombos.length > 0) {
      const { error: comboError } = await supabase.from('roundtrip_combos').upsert(
        result.roundtripCombos.map((combo) => ({
          route_id: route.id,
          direction,
          departure_date: result.isoDate,
          return_date: combo.returnDate,
          price: combo.price,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: 'route_id,direction,departure_date,return_date' },
      );
      if (comboError) {
        console.error(`[sync-alf] [${label}] Помилка запису roundtrip_combos`, result.isoDate, comboError.message);
      }
    }

    try {
      const { error: upsertError } = await supabase.from('tours').upsert(
        {
          route_id: route.id,
          direction,
          origin: originCity,
          destination: destinationCity,
          departure_date: result.isoDate,
          departure_time: route.base_departure_time,
          arrival_time: route.base_departure_time,
          price: result.price,
          roundtrip_price: result.roundtripPrice,
          child_price: result.childPrice,
          duration_text: result.durationText,
          available_seats: result.availableSeats,
          seats_available: result.sourceStatus === 'available' || result.sourceStatus === 'few',
          source_status: result.sourceStatus,
          source_reference: route.route_class_text,
          carrier_name: route.carrier_name,
          route_class: route.route_class_text,
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'route_id,direction,departure_date' },
      );
      if (upsertError) {
        console.error(`[sync-alf] [${label}] Помилка запису tours`, result.isoDate, upsertError.message);
        errors.push({ date: result.isoDate, error: `DB: ${upsertError.message}` });
        errorCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[sync-alf] [${label}] Виняток запису tours`, result.isoDate, message);
      errors.push({ date: result.isoDate, error: `DB exception: ${message}` });
      errorCount += 1;
    }
  }

  const resultsDebug = results.map((result) => ({
    date: result.isoDate,
    status: result.sourceStatus,
    price: result.price,
    durationText: result.durationText,
    availableSeats: result.availableSeats,
    error: result.error ?? null,
    requestBody: result.requestBody,
    responseSnippet: result.responseSnippet.slice(0, 2500),
  }));

  const sample = results[0];

  try {
    const { error: logError } = await supabase.from('alf_sync_runs').insert({
      route_id: route.id,
      route_name: route.name,
      sync_type: 'prices',
      direction,
      calendar_source: discoverySource,
      calendar_dates_found: calendarDatesFound,
      active_dates: targetDates,
      tours_updated: results.length,
      available_count: availableCount,
      few_count: fewCount,
      sold_out_count: soldOutCount,
      error_count: errorCount,
      sample_request: sample?.requestBody ?? null,
      sample_response_snippet: sample?.responseSnippet.slice(0, 4000) ?? null,
      calendar_snippet: calendarSnippet.slice(0, 20000),
      errors,
      results_debug: resultsDebug,
      fatal_error: fatalError,
    });
    if (logError) console.error(`[sync-alf] [${label}] Не вдалося записати журнал синхронізації`, logError.message);
  } catch (error) {
    console.error(`[sync-alf] [${label}] Виняток запису журналу синхронізації`, error instanceof Error ? error.message : error);
  }

  if (routeConfig.typicalRoundtripDays && results.length > 0) {
    await logRoundtripDirection(supabase, route, direction, originCity, destinationCity, targetDates, discoverySource, results);
  }

  console.log(`[sync-alf] [${label}] Завершено: available=${availableCount} few=${fewCount} sold_out=${soldOutCount} error=${errorCount} fatal=${fatalError ? 'так' : 'ні'}`);

  return { direction, toursUpdated: results.length, available: availableCount, few: fewCount, soldOut: soldOutCount, errors: errorCount, fatalError };
}

// Re-parses the published schedule page for ONE direction of a route — locations,
// geo-links and times can change on ALF's side, so this refreshes the stop
// timetable instead of relying on a value that was hardcoded once. Writes a
// separate alf_sync_runs log row (sync_type='schedule') since this runs on its
// own, much longer, interval than the price sync.
async function syncScheduleDirection(supabase: SupabaseClient, route: AlfRoute, direction: Direction, url: string | null) {
  const label = `${route.name} (${direction === 'forward' ? 'туди' : 'назад'})`;
  let status: 'ok' | 'warning' | 'skipped' | 'error' = 'skipped';
  let stopsFound = 0;
  let parseError: string | null = null;
  let snippet = '';

  if (url) {
    const result = await parseScheduleStops(url, direction);
    status = result.status;
    snippet = result.snippet;
    parseError = result.error ?? null;

    if (result.status !== 'error') {
      stopsFound = result.stops.length;
      try {
        await supabase.from('alf_route_stops').delete().eq('route_id', route.id).eq('direction', direction);
        const { error: stopsError } = await supabase.from('alf_route_stops').insert(
          result.stops.map((stop, index) => ({
            route_id: route.id,
            direction,
            sort_order: index,
            city: stop.city,
            country: stop.country,
            hours_from_start: stop.hoursFromStart,
            clock_time: stop.clockTime,
            note: stop.note,
            geo_link: stop.geoLink,
          })),
        );
        if (stopsError) {
          status = 'error';
          parseError = `DB: ${stopsError.message}`;
        }
      } catch (error) {
        status = 'error';
        parseError = error instanceof Error ? error.message : String(error);
      }
    }
    if (status === 'error') console.error(`[sync-alf] [${label}] Не вдалося розпарсити розклад`, parseError);
    else console.log(`[sync-alf] [${label}] Розклад оновлено (${status}), зупинок знайдено: ${stopsFound}`);
  }

  try {
    const { error: logError } = await supabase.from('alf_sync_runs').insert({
      route_id: route.id,
      route_name: route.name,
      sync_type: 'schedule',
      direction,
      schedule_source_url: url,
      schedule_parse_status: status,
      schedule_stops_found: stopsFound,
      schedule_parse_error: parseError,
      schedule_snippet: snippet.slice(0, 6000),
    });
    if (logError) console.error(`[sync-alf] [${label}] Не вдалося записати журнал розкладу`, logError.message);
  } catch (error) {
    console.error(`[sync-alf] [${label}] Виняток запису журналу розкладу`, error instanceof Error ? error.message : error);
  }

  return { direction, status, stopsFound, parseError };
}

async function processRoute(supabase: SupabaseClient, route: AlfRoute, task: 'prices' | 'schedule' | 'both', force: boolean) {
  const shouldRunPrices = task !== 'schedule' && (force || isDue(route.last_price_sync_at, route.price_sync_interval_minutes));
  const shouldRunSchedule = task !== 'prices' && (force || isDue(route.last_schedule_sync_at, route.schedule_sync_interval_minutes));

  const priceResults: Awaited<ReturnType<typeof syncPricesDirection>>[] = [];
  const scheduleResults: Awaited<ReturnType<typeof syncScheduleDirection>>[] = [];

  if (shouldRunPrices) {
    const forwardConfig: RouteConfig = {
      townFromInc: route.town_from_inc,
      townToInc: route.town_to_inc,
      portToInc: route.port_to_inc,
      classCode: route.class_code,
      routeClassText: route.route_class_text,
      carrierName: route.carrier_name,
      typicalRoundtripDays: route.typical_roundtrip_days,
    };
    priceResults.push(await syncPricesDirection(supabase, route, 'forward', forwardConfig, route.origin_city, route.destination_city));

    if (route.return_town_from_inc && route.return_town_to_inc && route.return_port_to_inc) {
      const returnConfig: RouteConfig = {
        townFromInc: route.return_town_from_inc,
        townToInc: route.return_town_to_inc,
        portToInc: route.return_port_to_inc,
        isInbound: true,
        classCode: route.class_code,
        routeClassText: route.route_class_text,
        carrierName: route.carrier_name,
        // A customer can just as well start their round trip FROM the destination
        // city (e.g. searching Вльора → Київ first) — ALF's combo pricing/date
        // pairing is anchored to whichever city the customer departs from first,
        // so the return-direction rows need their own probed combo price too,
        // instead of only ever falling back to the naive sum of two one-way prices.
        typicalRoundtripDays: route.typical_roundtrip_days,
      };
      priceResults.push(await syncPricesDirection(supabase, route, 'return', returnConfig, route.destination_city, route.origin_city));
    }

    await supabase.from('alf_routes').update({ last_price_sync_at: new Date().toISOString() }).eq('id', route.id);
  }

  if (shouldRunSchedule) {
    scheduleResults.push(await syncScheduleDirection(supabase, route, 'forward', route.forward_schedule_source_url));
    scheduleResults.push(await syncScheduleDirection(supabase, route, 'return', route.return_schedule_source_url ?? route.forward_schedule_source_url));
    await supabase.from('alf_routes').update({ last_schedule_sync_at: new Date().toISOString() }).eq('id', route.id);
  }

  return { routeId: route.id, routeName: route.name, ranPrices: shouldRunPrices, ranSchedule: shouldRunSchedule, priceResults, scheduleResults };
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Optional body: { routeId, task, force } — used by the admin UI's "sync prices
  // now" / "parse schedule now" buttons scoped to one route. The scheduled cron
  // tick calls this with no body, which checks every active route's own configured
  // interval instead of forcing anything.
  let requestedRouteId: string | null = null;
  let requestedTask: 'prices' | 'schedule' | 'both' = 'both';
  let force = false;
  try {
    const body = await req.json();
    requestedRouteId = typeof body?.routeId === 'string' ? body.routeId : null;
    if (body?.task === 'prices' || body?.task === 'schedule') requestedTask = body.task;
    force = Boolean(body?.force);
  } catch {
    // No/invalid JSON body — run the full interval-gated sync across all active routes.
  }

  let routesQuery = supabase.from('alf_routes').select('*').order('sort_order', { ascending: true });
  routesQuery = requestedRouteId ? routesQuery.eq('id', requestedRouteId) : routesQuery.eq('is_active', true);
  const { data: routes, error: routesError } = await routesQuery;

  if (routesError) {
    console.error('[sync-alf] Не вдалося завантажити список маршрутів', routesError.message);
    return new Response(JSON.stringify({ error: `Не вдалося завантажити маршрути: ${routesError.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  if (!routes || routes.length === 0) {
    console.log('[sync-alf] Немає маршрутів для синхронізації');
    return new Response(JSON.stringify({ routes: [] }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  console.log(`[sync-alf] Запуск для ${routes.length} маршрут(ів), задача=${requestedTask}, примусово=${force}`);

  const routeSummaries = [];
  for (const route of routes as AlfRoute[]) {
    routeSummaries.push(await processRoute(supabase, route, requestedTask, force));
  }

  return new Response(
    JSON.stringify({ routes: routeSummaries }),
    { headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}

Deno.serve(handler);
