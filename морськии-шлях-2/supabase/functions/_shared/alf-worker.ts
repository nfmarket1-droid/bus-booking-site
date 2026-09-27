// Shared background-worker logic for caching ALF (https://online.alf.ua) ticket-grid
// prices into the local `tours` table. This module never runs in the customer-facing
// request path — it is only invoked by the `sync-alf` scheduled/manual worker.
//
// Reverse-engineered against the live site (2026-09-26):
// - The public marketing site (alf.ua) only serves GET requests; the actual SAMO-Soft
//   ticket grid lives on the `online.alf.ua` subdomain at the `/tickets` route.
// - The calendar of active departure dates is embedded as a `data-calendar` JSON
//   attribute on the `CHECKIN` date input: {"valid":"<digit-per-day>","start":"DD.MM.YYYY"}.
//   Any non-'0' digit means that date has a scheduled departure for the selected route.
// - A full-page GET with DOLOAD=1 (no separate AJAX call needed) renders the real
//   result row server-side when TOWNFROMINC/TOWNTOINC/PORTTOINC/CHECKIN/CLASS are valid.
// - Every route now lives in the `alf_routes` table so more ALF routes can be added
//   without touching this file — the town/port IDs and class are passed in per call.

export const alfTicketsUrl = 'https://online.alf.ua/tickets';

const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Every outbound request MUST be time-boxed — the edge function runtime has a hard
// wall-clock limit, and a single hanging fetch would silently kill the whole run
// before any diagnostics get written to the database.
const REQUEST_TIMEOUT_MS = 25_000;

export type RouteConfig = {
  townFromInc: string;
  townToInc: string;
  portToInc: string;
  classCode: string;
  routeClassText: string;
  carrierName: string;
  // Only set on the FORWARD direction's config. When present, fetchTourForDate also
  // probes ALF's own combined round-trip price (the "туди і назад" checkbox on the
  // live site) using departureDate + this many days as the return date, and stores
  // the result in `roundtripPrice`.
  typicalRoundtripDays?: number;
  // True for the RETURN-direction config (e.g. Вльора → Київ) — the leg that lands
  // back at the route's own hub/origin city. In SAMO-Soft, PORTTOINC selects a
  // specific arrival terminal inside a foreign destination city; it never applies
  // when the destination is the domestic origin city itself, so any PORTTOINC
  // configured for the OUTBOUND leg (e.g. Vlora's port ID) must never be reused
  // for this direction — see buildRequestParams below.
  isInbound?: boolean;
};

export type CalendarDiscovery = {
  isoDates: string[];
  calendarSnippet: string;
  source: 'calendar' | 'fallback';
};

// Diagnostic record of the combined round-trip ("туди і назад") price probe run
// alongside the plain one-way lookup for the same departure date — this is what
// lets the worker log show its own dedicated "туди-назад" journal entries instead
// of only the resulting cached price.
export type RoundtripProbeResult = {
  status: 'priced' | 'empty' | 'skipped';
  price: number | null;
  returnDate: string | null;
  requestBody: Record<string, string> | null;
  responseSnippet: string;
};

// One specific, individually-priced departure+return date combination — every
// valid combo found for a departure date gets its own entry here (not just the one
// closest to the route's typical round-trip length), so all of them can be stored.
export type RoundtripComboItem = {
  returnDate: string;
  price: number;
  requestBody: Record<string, string>;
  responseSnippet: string;
};

export type AlfTourResult = {
  isoDate: string;
  price: number | null;
  // ALF's own combined round-trip price (checking "туди і назад" on the live site),
  // probed with ONEWAY=0 + FREIGHTBACK=1 + CHECKOUT=<return date> — confirmed against
  // the live site's own tickets.js to be the correct combo-search flag combination.
  roundtripPrice: number | null;
  roundtrip: RoundtripProbeResult;
  // ALL individually-priced departure+return combinations found for this departure
  // date (not just the one closest to typicalRoundtripDays) — populated by
  // enrichWithRoundtripPrices, one entry per valid CHECKOUT date that ALF actually
  // returned a combo price for.
  roundtripCombos: RoundtripComboItem[];
  childPrice: number | null;
  durationText: string | null;
  availableSeats: number | null;
  sourceStatus: 'available' | 'few' | 'sold_out' | 'error';
  error?: string;
  requestBody: Record<string, string>;
  responseSnippet: string;
};

// --- date helpers (avoid the JS Date engine dropping days across timezones) ---

export const isoToCompactDate = (iso: string): string => iso.replace(/-/g, '');

const ddmmyyyyToIso = (value: string): string | null => {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
};

export const addDaysIso = (iso: string, days: number): string => {
  const [year, month, day] = iso.split('-').map(Number);
  const utcMillis = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const shifted = new Date(utcMillis);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const todayIso = (): string => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const buildHeaders = (referer: string) => ({
  'user-agent': userAgent,
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'uk-UA,uk;q=0.9',
  referer,
});

// --- Step 1: discover active calendar dates from the route-scoped tickets page ---

const parseCalendarDates = (html: string, fieldName: 'CHECKIN' | 'CHECKOUT'): string[] | null => {
  const calendarMatch = html.match(new RegExp(`name="${fieldName}"[^>]*data-calendar='(\{[^']*\})'`));
  if (!calendarMatch) return null;

  let calendar: { valid?: string; start?: string };
  try {
    calendar = JSON.parse(calendarMatch[1]);
  } catch {
    return null;
  }

  const startIso = calendar.start ? ddmmyyyyToIso(calendar.start) : null;
  const valid = calendar.valid ?? '';
  if (!startIso || !valid) return null;

  const isoDates: string[] = [];
  for (let i = 0; i < valid.length; i += 1) {
    if (valid[i] !== '0') isoDates.push(addDaysIso(startIso, i));
  }
  return isoDates.length > 0 ? isoDates : null;
};

export const discoverActiveDates = async (route: RouteConfig): Promise<CalendarDiscovery> => {
  const url = `${alfTicketsUrl}?TOWNFROMINC=${route.townFromInc}&TOWNTOINC=${route.townToInc}&PORTTOINC=${route.portToInc}&LANG=ukr`;
  try {
    const response = await fetch(url, {
      headers: buildHeaders(alfTicketsUrl),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const html = await response.text();
    const isoDates = parseCalendarDates(html, 'CHECKIN');

    if (!isoDates) {
      return { isoDates: buildFallbackDates(), calendarSnippet: html.slice(0, 4000), source: 'fallback' };
    }

    return { isoDates, calendarSnippet: html.slice(0, 4000), source: 'calendar' };
  } catch (error) {
    return {
      isoDates: buildFallbackDates(),
      calendarSnippet: error instanceof Error ? error.message : 'Помилка запиту календаря',
      source: 'fallback',
    };
  }
};

const buildFallbackDates = (maxWeeks = 12): string[] => {
  const start = todayIso();
  const dates: string[] = [];
  let candidate = addDaysIso(start, 4);
  for (let i = 0; i < maxWeeks; i += 1) {
    dates.push(candidate);
    candidate = addDaysIso(candidate, 7);
  }
  return dates;
};

// --- Step 2: payload injection — GET the real ticket-grid result page ---

const buildRequestParams = (
  route: RouteConfig,
  checkinCompact: string,
  oneWay: boolean,
  adults: number,
  childAges: number[] = [],
): Record<string, string> => {
  const params: Record<string, string> = {
    TOWNFROMINC: route.townFromInc,
    TOWNTOINC: route.townToInc,
    // See RouteConfig.isInbound: a foreign-city port terminal ID never applies when
    // arriving back at the domestic origin city, regardless of whether this is a
    // plain one-way lookup or a round-trip combo probe — it must not be sent here.
    PORTTOINC: route.isInbound ? '0' : route.portToInc,
    CHECKIN: checkinCompact,
    ONEWAY: oneWay ? '1' : '0',
    ADULT: String(adults),
    CHILD: String(childAges.length),
    CLASS: route.classCode,
    CURRENCYINC: '1',
    LANG: 'ukr',
    DOLOAD: '1',
  };
  if (childAges.length > 0) {
    params.AGES = [...childAges].sort((a, b) => a - b).join(',');
  }
  return params;
};

const buildRoundtripRequestParams = (route: RouteConfig, checkinCompact: string, checkoutCompact: string): Record<string, string> => ({
  ...buildRequestParams(route, checkinCompact, false, 1),
  ONEWAY: '0',
  FREIGHTBACK: '1',
  CHECKOUT: checkoutCompact,
});

const ROUNDTRIP_RETRY_DELAYS_MS = [1200, 2500];
const ONEWAY_RETRY_DELAYS_MS = [1200, 2500];

const discoverReturnDatesForCheckin = async (route: RouteConfig, checkinCompact: string): Promise<string[]> => {
  const params = { ...buildRequestParams(route, checkinCompact, false, 1), ONEWAY: '0', FREIGHTBACK: '1' };
  const url = `${alfTicketsUrl}?${new URLSearchParams(params).toString()}`;
  try {
    const response = await fetch(url, {
      // FIX: Динамічний referer для обходу блокувань Cloudflare
      headers: buildHeaders(url),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const html = await response.text();
    return parseCalendarDates(html, 'CHECKOUT') ?? [];
  } catch {
    return [];
  }
};

const fetchRoundtripPriceForDate = async (
  route: RouteConfig,
  checkinCompact: string,
  checkoutCompact: string,
): Promise<{ price: number | null; requestBody: Record<string, string>; responseSnippet: string }> => {
  const params = buildRoundtripRequestParams(route, checkinCompact, checkoutCompact);
  const url = `${alfTicketsUrl}?${new URLSearchParams(params).toString()}`;

  for (let attempt = 0; attempt <= ROUNDTRIP_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(ROUNDTRIP_RETRY_DELAYS_MS[attempt - 1]);

    try {
      const response = await fetch(url, {
        headers: buildHeaders(url),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const cfRay = response.headers.get('cf-ray');
      const server = response.headers.get('server');
      if (!response.ok) {
        if (attempt < ROUNDTRIP_RETRY_DELAYS_MS.length) continue;
        return { price: null, requestBody: params, responseSnippet: `HTTP ${response.status} | server=${server} cf-ray=${cfRay}` };
      }
      const html = await response.text();
      const flightIndex = html.indexOf('class="airline"');
      if (flightIndex === -1) {
        if (attempt < ROUNDTRIP_RETRY_DELAYS_MS.length) continue;
        const responseSnippet = `[len=${html.length} status=${response.status} server=${server} cf-ray=${cfRay} attempts=${attempt + 1}]
--- HEAD ---
${html.slice(0, 2000)}
--- TAIL ---
${html.slice(-2000)}`;
        return { price: null, requestBody: params, responseSnippet };
      }
      const windowText = html.slice(flightIndex, flightIndex + 20000);
      const priceMatch = windowText.match(/data-cat-price="(\d+)"/);
      if (!priceMatch && attempt < ROUNDTRIP_RETRY_DELAYS_MS.length) continue;
      return { price: priceMatch ? Number(priceMatch[1]) : null, requestBody: params, responseSnippet: html.slice(0, 4000) };
    } catch (error) {
      if (attempt < ROUNDTRIP_RETRY_DELAYS_MS.length) continue;
      return { price: null, requestBody: params, responseSnippet: error instanceof Error ? `EXCEPTION: ${error.message}` : 'Помилка запиту комбо-ціни' };
    }
  }
  return { price: null, requestBody: params, responseSnippet: '' };
};

const CHILD_PROBE_AGE = 10;

const durationRegex = /Час\s*у\s*дороз[іi]\s*([\d]+\s*ч\.?(?:\s*\d+\s*хв\.?)?)/i;
const seatStatusRegex = /<span class="(\w*place)">\s*([^<]+?)\s*<\/span>/i;

const normalizeDurationText = (raw: string): string => {
  const match = raw.match(/^(\d+)\s*ч\.?(?:\s*(\d+)\s*хв\.?)?$/i);
  if (!match) return raw;
  const [, hours, minutes] = match;
  return minutes ? `${hours} год. ${minutes} хв.` : `${hours} год.`;
};

const classifySeatStatus = (text: string): 'available' | 'few' | 'sold_out' => {
  if (/немає|no\s*seats|sold\s*out/i.test(text)) return 'sold_out';
  if (/мало|few/i.test(text)) return 'few';
  return 'available';
};

const probeSeatStatusForAdults = async (
  route: RouteConfig,
  checkinCompact: string,
  adults: number,
): Promise<'available' | 'few' | 'sold_out' | null> => {
  const params = buildRequestParams(route, checkinCompact, true, adults);
  const url = `${alfTicketsUrl}?${new URLSearchParams(params).toString()}`;
  try {
    const response = await fetch(url, {
      headers: buildHeaders(url),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const flightIndex = html.indexOf('class="airline"');
    if (flightIndex === -1) {
      return html.includes('empty-result') ? 'sold_out' : null;
    }
    const windowText = html.slice(flightIndex, flightIndex + 8000);
    if (!/data-cat-price="\d+"/.test(windowText)) return null;
    const seatMatch = windowText.match(seatStatusRegex);
    const seatText = seatMatch ? seatMatch[2].trim() : '';
    return seatMatch ? classifySeatStatus(seatText) : 'available';
  } catch {
    return null;
  }
};

const FEW_SEATS_SEARCH_CAP = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveFewSeatsCount = async (route: RouteConfig, checkinCompact: string): Promise<number | null> => {
  let lastFewCount = 1;
  for (let adults = 2; adults <= FEW_SEATS_SEARCH_CAP; adults += 1) {
    await sleep(400);
    const status = await probeSeatStatusForAdults(route, checkinCompact, adults);
    if (status === 'sold_out' || status === null) break;
    lastFewCount = adults;
  }
  return lastFewCount;
};

const fetchChildPriceForDate = async (route: RouteConfig, checkinCompact: string): Promise<number | null> => {
  const params = buildRequestParams(route, checkinCompact, true, 0, [CHILD_PROBE_AGE]);
  const url = `${alfTicketsUrl}?${new URLSearchParams(params).toString()}`;
  try {
    const response = await fetch(url, {
      headers: buildHeaders(url),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const flightIndex = html.indexOf('class="airline"');
    if (flightIndex === -1) return null;
    const windowText = html.slice(flightIndex, flightIndex + 8000);
    const priceMatch = windowText.match(/data-cat-price="(\d+)"/);
    return priceMatch ? Number(priceMatch[1]) : null;
  } catch {
    return null;
  }
};

const skippedRoundtrip: RoundtripProbeResult = { status: 'skipped', price: null, returnDate: null, requestBody: null, responseSnippet: '' };

export const fetchTourForDate = async (
  route: RouteConfig,
  isoDate: string,
  adults = 1,
): Promise<AlfTourResult> => {
  const checkinCompact = isoToCompactDate(isoDate);
  const params = buildRequestParams(route, checkinCompact, true, adults);
  const url = `${alfTicketsUrl}?${new URLSearchParams(params).toString()}`;

  try {
    let html = '';
    let responseSnippet = '';
    let response: Response | null = null;
    let flightIndex = -1;
    let isNoData = false;

    for (let attempt = 0; attempt <= ONEWAY_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await sleep(ONEWAY_RETRY_DELAYS_MS[attempt - 1]);

      response = await fetch(url, {
        headers: buildHeaders(url),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) break;

      html = await response.text();
      responseSnippet = html.slice(0, 6000);
      flightIndex = html.indexOf('class="airline"');
      isNoData = html.includes('empty-result');
      if (flightIndex !== -1 || isNoData) break;
    }

    if (!response!.ok) {
      return {
        isoDate,
        price: null,
        roundtripPrice: null,
        roundtrip: skippedRoundtrip,
        roundtripCombos: [],
        childPrice: null,
        durationText: null,
        availableSeats: null,
        sourceStatus: 'error',
        error: `ALF повернув HTTP ${response!.status}`,
        requestBody: params,
        responseSnippet,
      };
    }

    if (flightIndex === -1) {
      // Only the operator's own explicit "empty-result" marker means this date
      // genuinely has no scheduled departure (sold_out) — anything else missing the
      // .airline block (e.g. a Cloudflare/anti-bot block page) must surface as a
      // real error, otherwise a blocked request silently corrupts the cached data
      // by reporting a date as sold_out when it may well have available seats.
      return {
        isoDate,
        price: null,
        roundtripPrice: null,
        roundtrip: skippedRoundtrip,
        roundtripCombos: [],
        childPrice: null,
        durationText: null,
        availableSeats: 0,
        sourceStatus: isNoData ? 'sold_out' : 'error',
        error: isNoData ? undefined : 'Блок результату .airline не знайдено у відповіді ALF',
        requestBody: params,
        responseSnippet,
      };
    }

    const windowText = html.slice(flightIndex, flightIndex + 8000);
    const priceMatch = windowText.match(/data-cat-price="(\d+)"/);
    const price = priceMatch ? Number(priceMatch[1]) : null;
    const durationMatch = windowText.match(durationRegex);
    const seatMatch = windowText.match(seatStatusRegex);
    const seatText = seatMatch ? seatMatch[2].trim() : '';
    const sourceStatus = seatMatch ? classifySeatStatus(seatText) : (price !== null ? 'available' : 'error');

    if (price === null) {
      return {
        isoDate,
        price: null,
        roundtripPrice: null,
        roundtrip: skippedRoundtrip,
        roundtripCombos: [],
        childPrice: null,
        durationText: durationMatch ? normalizeDurationText(durationMatch[1].trim()) : null,
        availableSeats: null,
        sourceStatus: 'error',
        error: 'Не вдалося знайти data-cat-price у відповіді ALF',
        requestBody: params,
        responseSnippet,
      };
    }

    const [availableSeats, probedChildPrice] = await Promise.all([
      sourceStatus === 'sold_out' ? Promise.resolve(0) : sourceStatus === 'few' ? resolveFewSeatsCount(route, checkinCompact) : Promise.resolve(null),
      sourceStatus === 'sold_out' ? Promise.resolve(null) : fetchChildPriceForDate(route, checkinCompact),
    ]);

    return {
      isoDate,
      price,
      roundtripPrice: null,
      roundtrip: skippedRoundtrip,
      roundtripCombos: [],
      childPrice: probedChildPrice,
      durationText: durationMatch ? normalizeDurationText(durationMatch[1].trim()) : null,
      availableSeats,
      sourceStatus,
      requestBody: params,
      responseSnippet,
    };
  } catch (error) {
    return {
      isoDate,
      price: null,
      roundtripPrice: null,
      roundtrip: skippedRoundtrip,
      roundtripCombos: [],
      childPrice: null,
      durationText: null,
      availableSeats: null,
      sourceStatus: 'error',
      error: error instanceof Error ? error.message : 'Невідома помилка запиту до ALF',
      requestBody: params,
      responseSnippet: '',
    };
  }
};

export const NO_SEASONAL_RETURN_DATES_MESSAGE = 'No seasonal return dates scheduled by operator';
const MAX_COMBO_PROBES_PER_DEPARTURE = 5;

export const enrichWithRoundtripPrices = async (
  route: RouteConfig,
  results: AlfTourResult[],
): Promise<void> => {
  if (!route.typicalRoundtripDays) return;

  for (const result of results) {
    if (result.sourceStatus === 'sold_out') continue;

    await sleep(350);

    const checkinCompact = isoToCompactDate(result.isoDate);
    const dynamicReturnDates = await discoverReturnDatesForCheckin(route, checkinCompact);
    const departureMillis = new Date(result.isoDate).getTime();
    
    // FIX: Знято штучні обмеження. Дозволені будь-які комбінації від +1 дня
    const allCandidateReturnDates = dynamicReturnDates.filter(
      (date) => new Date(date).getTime() > departureMillis,
    );

    if (allCandidateReturnDates.length === 0) {
      result.roundtrip = {
        status: 'empty',
        price: null,
        returnDate: null,
        requestBody: null,
        responseSnippet: NO_SEASONAL_RETURN_DATES_MESSAGE,
      };
      continue;
    }

    const targetMillis = new Date(addDaysIso(result.isoDate, route.typicalRoundtripDays)).getTime();
    const candidateReturnDates = [...allCandidateReturnDates]
      .sort((a, b) => Math.abs(new Date(a).getTime() - targetMillis) - Math.abs(new Date(b).getTime() - targetMillis))
      .slice(0, MAX_COMBO_PROBES_PER_DEPARTURE);
    let closestPriced: RoundtripProbeResult | null = null;
    let closestDiff = Infinity;

    for (const returnDate of candidateReturnDates) {
      await sleep(350);
      const probe = await fetchRoundtripPriceForDate(route, checkinCompact, isoToCompactDate(returnDate));
      if (probe.price === null) continue;

      result.roundtripCombos.push({
        returnDate,
        price: probe.price,
        requestBody: probe.requestBody,
        responseSnippet: probe.responseSnippet,
      });

      const diff = Math.abs(new Date(returnDate).getTime() - targetMillis);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestPriced = {
          status: 'priced',
          price: probe.price,
          returnDate,
          requestBody: probe.requestBody,
          responseSnippet: probe.responseSnippet,
        };
      }
    }

    result.roundtrip = closestPriced ?? { status: 'empty', price: null, returnDate: candidateReturnDates[0], requestBody: null, responseSnippet: '' };
    result.roundtripPrice = closestPriced?.price ?? null;
  }
};

// --- Step 3: schedule scraping ---

export type ParsedScheduleStop = {
  city: string;
  country: string | null;
  hoursFromStart: number;
  clockTime: string | null;
  note: string | null;
  geoLink: string | null;
};

export type ScheduleParseResult = {
  stops: ParsedScheduleStop[];
  snippet: string;
  status: 'ok' | 'warning' | 'error';
  error?: string;
};

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&ndash;/g, '–').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const timeRegex = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const geoLinkRegex = /<a[^>]+href="([^"]*(?:google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|yandex\.[a-z.]+\/maps)[^"]*)"/gi;
const directionLabelRegex = /З\s+[А-ЯЇІЄҐ][А-ЯЇІЄҐ'\s]{2,20}:/g;

const extractGeoLink = (html: string): string | null => {
  geoLinkRegex.lastIndex = 0;
  const match = geoLinkRegex.exec(html);
  return match ? match[1] : null;
};

const extractAddressNote = (html: string): string | null => {
  const withoutStrong = html.replace(/<strong>[\s\S]*?<\/strong>/gi, ' ');
  const text = stripTags(withoutStrong).replace(directionLabelRegex, '').trim();
  return text.length > 0 ? text.slice(0, 300) : null;
};

type RawTableRow = { city: string; forwardTime: string | null; returnTime: string | null; cellHtml: string };

const extractStopTableRows = (html: string): string[] | null => {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi);
  const stopTable = tables?.find((table) => />\s*Зупинка\s*</i.test(table));
  if (!stopTable) return null;

  const rows = stopTable.match(/<tr[\s\S]*?<\/tr>/gi);
  if (!rows || rows.length < 2) return null;

  return rows.filter((row) => !/>\s*Зупинка\s*</i.test(row));
};

const parseRow = (row: string): RawTableRow | null => {
  const cells = row.match(/<td[\s\S]*?<\/td>/gi);
  if (!cells || cells.length < 3) return null;

  const cityMatch = cells[1].match(/<strong>([\s\S]*?)<\/strong>/i);
  const city = cityMatch ? stripTags(cityMatch[1]) : null;
  if (!city) return null;

  const forwardTimeMatch = stripTags(cells[0]).match(timeRegex);
  const returnTimeMatch = stripTags(cells[2]).match(timeRegex);
  if (!forwardTimeMatch && !returnTimeMatch) return null;

  return {
    city,
    forwardTime: forwardTimeMatch ? `${forwardTimeMatch[1].padStart(2, '0')}:${forwardTimeMatch[2]}` : null,
    returnTime: returnTimeMatch ? `${returnTimeMatch[1].padStart(2, '0')}:${returnTimeMatch[2]}` : null,
    cellHtml: cells[1],
  };
};

const splitAddressByDirection = (cellHtml: string): { forward: string; return: string } => {
  const labelMatches = [...cellHtml.matchAll(/З\s+[А-ЯЇІЄҐ][А-ЯЇІЄҐ'\s]{2,20}:/g)];
  if (labelMatches.length < 2) return { forward: cellHtml, return: cellHtml };

  const [first, second] = labelMatches;
  return {
    forward: cellHtml.slice(first.index, second.index),
    return: cellHtml.slice(second.index),
  };
};

const computeHoursFromStart = (
  stops: { city: string; time: string; geoLink: string | null; note: string | null }[],
): ParsedScheduleStop[] => {
  const [firstHour, firstMinute] = stops[0].time.split(':').map(Number);
  const firstMinutes = firstHour * 60 + firstMinute;
  let cumulativeDays = 0;
  let previousMinutesOfDay = firstMinutes;

  return stops.map((stop, index) => {
    const [hour, minute] = stop.time.split(':').map(Number);
    const minutesOfDay = hour * 60 + minute;
    if (index > 0 && minutesOfDay < previousMinutesOfDay) cumulativeDays += 1;
    previousMinutesOfDay = minutesOfDay;

    const hoursFromStart = cumulativeDays * 24 + (minutesOfDay - firstMinutes) / 60;

    return {
      city: stop.city,
      country: null,
      hoursFromStart: Math.round(hoursFromStart * 100) / 100,
      clockTime: stop.time,
      note: stop.note,
      geoLink: stop.geoLink,
    };
  });
};

export const parseScheduleStops = async (url: string, direction: 'forward' | 'return'): Promise<ScheduleParseResult> => {
  if (!url) return { stops: [], snippet: '', status: 'error', error: 'Посилання на розклад не вказане' };

  let html: string;
  try {
    const response = await fetch(url, {
      headers: buildHeaders(url),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { stops: [], snippet: '', status: 'error', error: `Сторінка розкладу повернула HTTP ${response.status}` };
    }
    html = await response.text();
  } catch (error) {
    return { stops: [], snippet: '', status: 'error', error: error instanceof Error ? error.message : 'Помилка запиту сторінки розкладу' };
  }

  const snippet = html.slice(0, 6000);
  const rawRows = extractStopTableRows(html);
  if (!rawRows) {
    return { stops: [], snippet, status: 'error', error: 'Не вдалося знайти таблицю розкладу (очікується колонка "Зупинка")' };
  }

  const parsedRows = rawRows.map(parseRow).filter((row): row is RawTableRow => row !== null);
  if (parsedRows.length < 2) {
    return { stops: [], snippet, status: 'error', error: `Знайдено таблицю, але лише ${parsedRows.length} рядків містять час зупинки (потрібно щонайменше 2)` };
  }

  const relevantRows = direction === 'forward'
    ? parsedRows.filter((row) => row.forwardTime !== null)
    : [...parsedRows].reverse().filter((row) => row.returnTime !== null);

  if (relevantRows.length < 2) {
    return { stops: [], snippet, status: 'error', error: `Для напрямку "${direction === 'forward' ? 'туди' : 'назад'}" знайдено лише ${relevantRows.length} зупинок з часом` };
  }

  const stopsWithAddress = relevantRows.map((row) => {
    const { forward, return: returnBlock } = splitAddressByDirection(row.cellHtml);
    const addressBlock = direction === 'forward' ? forward : returnBlock;
    return {
      city: row.city,
      time: (direction === 'forward' ? row.forwardTime : row.returnTime)!,
      geoLink: extractGeoLink(addressBlock),
      note: extractAddressNote(addressBlock),
    };
  });

  return { stops: computeHoursFromStart(stopsWithAddress), snippet, status: 'ok' };
};
