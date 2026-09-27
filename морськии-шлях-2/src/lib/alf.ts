export type TripType = 'one_way' | 'roundtrip';
export type Direction = 'forward' | 'return';
export type BookingStatus = 'new' | 'in_progress' | 'confirmed' | 'cancelled';
export type SourceStatus = 'available' | 'few' | 'sold_out' | 'error' | 'demo';

export type Stop = {
  city: string;
  country?: string;
  time?: string;
  note?: string;
};

export type Tour = {
  id: string;
  route_id: string;
  direction: Direction;
  origin: string;
  destination: string;
  departure_date: string;
  departure_time: string;
  arrival_time: string;
  price: number | null;
  roundtrip_price: number | null;
  child_price: number | null;
  duration_text: string | null;
  available_seats: number | null;
  source_status: SourceStatus;
  carrier_name: string;
  route_class: string;
  synced_at: string | null;
};

export const forwardStops: Stop[] = [
  { city: 'Київ', time: '17:00', note: 'АС «Дачна»' },
  { city: 'Житомир' },
  { city: 'Рівне' },
  { city: 'Львів' },
  { city: 'Стрий' },
  { city: 'Мукачево' },
  { city: 'Берегове' },
  { city: 'Тімішоара', country: 'Румунія' },
  { city: 'Белград', country: 'Сербія' },
  { city: 'Подгориця', country: 'Чорногорія' },
  { city: 'Сутоморе' },
  { city: 'Бар' },
  { city: 'Добра Вода' },
  { city: 'Ульцинь' },
  { city: 'Тирана', country: 'Албанія' },
  { city: 'Дуррес' },
  { city: 'Вльора', time: '10:00', note: '+2 дні' },
];

export const returnStops: Stop[] = [...forwardStops]
  .reverse()
  .map((stop, index, all) => {
    // Очищаємо часові мітки forward-напрямку, щоб вони не накладалися
    const cleanedStop = { ...stop };
    delete cleanedStop.time;
    delete cleanedStop.note;

    return {
      ...cleanedStop,
      time: index === 0 ? '11:00' : index === all.length - 1 ? '05:00' : undefined,
      note: index === all.length - 1 ? '+2 дні' : index === 0 ? 'АС Вльора' : undefined,
    };
  });

// All cities along the Kyiv→Vlora route (in order)
export const allRouteCities = [
  'Київ',
  'Житомир',
  'Рівне',
  'Львів',
  'Стрий',
  'Мукачево',
  'Берегове',
  'Тімішоара',
  'Белград',
  'Подгориця',
  'Сутоморе',
  'Бар',
  'Добра Вода',
  'Ульцинь',
  'Тирана',
  'Дуррес',
  'Вльора'
] as const;

// Either endpoint can be picked as origin or destination — the actual travel
// direction (and which cached "forward"/"return" tours row to use) is derived
// from the order the customer picked them in, via `getDirectionForCities`.
export const originCities = allRouteCities;
export const destinationCities = allRouteCities;

// Whether the customer's origin/destination pick is the Kyiv→Вльора leg
// ("forward") or the Вльора→Kyiv leg ("return") — determined purely by which
// city comes first along the fixed route order.
export const getDirectionForCities = (origin: string, destination: string): Direction => {
  const originIndex = allRouteCities.indexOf(origin as (typeof allRouteCities)[number]);
  const destinationIndex = allRouteCities.indexOf(destination as (typeof allRouteCities)[number]);
  if (originIndex === -1 || destinationIndex === -1) return 'forward';
  return originIndex < destinationIndex ? 'forward' : 'return';
};

// Country for each city along the route — used to prevent picking origin and
// destination within the same country (e.g. Kyiv → Житомир isn't a real trip
// on this route, ALF only sells cross-border segments).
export const cityCountry: Record<string, string> = {
  'Київ': 'Україна',
  'Житомир': 'Україна',
  'Рівне': 'Україна',
  'Львів': 'Україна',
  'Стрий': 'Україна',
  'Мукачево': 'Україна',
  'Берегове': 'Україна',
  'Тімішоара': 'Румунія',
  'Белград': 'Сербія',
  'Подгориця': 'Чорногорія',
  'Сутоморе': 'Чорногорія',
  'Бар': 'Чорногорія',
  'Добра Вода': 'Чорногорія',
  'Ульцинь': 'Чорногорія',
  'Тирана': 'Албанія',
  'Дуррес': 'Албанія',
  'Вльора': 'Албанія',
};

// Filters out cities that share a country with the already-selected city on the
// other side of the search (origin/destination can't both be in the same country).
export const excludeSameCountry = (options: readonly string[], otherCity: string): string[] => {
  const otherCountry = otherCity ? cityCountry[otherCity] : undefined;
  if (!otherCountry) return [...options];
  return options.filter((city) => cityCountry[city] !== otherCountry);
};

// Fixed hours elapsed since the Kyiv departure (17:00) at which the bus reaches each
// stop, per ALF's published schedule (https://alf.ua/countries/albanija/info/bus).
// This is a static clock-time timetable — it does NOT get rescaled by a given tour's
// total duration text (that figure fluctuates slightly per date due to border-crossing
// notes and isn't a reliable basis for shifting fixed intermediate stop times).
// Кyiv (0h) and Вльора (41h, i.e. 10:00 +2 дні) are the two fixed route anchors;
// Мукачево (10.5h → 03:30 next day) is a confirmed timetable reference point.
export const stopHoursFromStart: Record<string, number> = {
  'Київ': 0,
  'Житомир': 1.5,
  'Рівне': 3.75,
  'Львів': 6.75,
  'Стрий': 8.25,
  'Мукачево': 10.5,
  'Берегове': 11.63,
  'Тімішоара': 16.15,
  'Белград': 22.93,
  'Подгориця': 29.7,
  'Сутоморе': 31.96,
  'Бар': 33.09,
  'Добра Вода': 34.22,
  'Ульцинь': 35.35,
  'Тирана': 38.74,
  'Дуррес': 39.87,
  'Вльора': 41,
};

// The route always departs Kyiv at 17:00 — used as the fixed anchor for computing
// which calendar day each stop's clock time actually falls on (a stop reached after
// 07:00 elapsed hours already lands on the next day, since 17:00 + 7h = 00:00).
const BASE_DEPARTURE_TIME = '17:00';
// The return leg departs Вльора at 11:00 per the published return timetable — used
// as the reverse-direction's own anchor time.
const RETURN_BASE_DEPARTURE_TIME = '11:00';
// Total elapsed hours for the whole route — used to mirror the forward stop-timing
// table into return-direction hours-from-departure (the return leg visits the exact
// same stops in reverse order, so a stop reached at hour H forward is reached at
// hour TOTAL-H on the way back).
const TOTAL_ROUTE_HOURS = stopHoursFromStart['Вльора'];

const getDirectionalHours = (city: string, direction: Direction): number | undefined => {
  const hours = stopHoursFromStart[city];
  if (hours === undefined) return undefined;
  return direction === 'forward' ? hours : TOTAL_ROUTE_HOURS - hours;
};

export const formatHoursToDuration = (hours: number): string => {
  const totalMinutes = Math.round(hours * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${wholeHours} ч. ${minutes} хв.` : `${wholeHours} ч.`;
};

const addHoursToTimeOfDay = (baseTime: string, hoursToAdd: number): { time: string; daysElapsed: number } => {
  const [baseHours, baseMinutes] = baseTime.split(':').map(Number);
  const totalMinutes = baseHours * 60 + baseMinutes + Math.round(hoursToAdd * 60);
  const daysElapsed = Math.floor(totalMinutes / 1440);
  const minutesOfDay = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(minutesOfDay / 60);
  const minutes = minutesOfDay % 60;
  return { time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, daysElapsed };
};

// How many calendar days after that direction's departure date the bus reaches this
// city's clock time — used to shift the customer-facing calendar when they search
// from a city other than the route's starting endpoint (e.g. Мукачево's 03:30 stop
// is reached after the Kyiv departure date has already rolled over to the next day).
export const getCityDayOffset = (city: string, direction: Direction = 'forward'): number => {
  const hours = getDirectionalHours(city, direction);
  if (hours === undefined) return 0;
  const baseTime = direction === 'forward' ? BASE_DEPARTURE_TIME : RETURN_BASE_DEPARTURE_TIME;
  return addHoursToTimeOfDay(baseTime, hours).daysElapsed;
};

export type SegmentSchedule = {
  departureTime: string;
  arrivalTime: string;
  durationText: string;
  departureDayOffset: number;
  arrivalDayOffset: number;
};

// Derives the actual departure/arrival time and duration for the customer-selected
// origin/destination pair from the fixed route timetable — so a partial segment like
// Мукачево → Добра Вода shows its own realistic times instead of the full
// Kyiv → Вльора schedule.
export const computeSegmentSchedule = (
  originCity: string,
  destinationCity: string,
  tour: Tour, // Використовуємо повноцінний тип замість inline-об'єкта
  direction: Direction = 'forward',
): SegmentSchedule | null => {
  const originHours = getDirectionalHours(originCity, direction);
  const destinationHours = getDirectionalHours(destinationCity, direction);
  if (originHours === undefined || destinationHours === undefined || destinationHours <= originHours) return null;

  // The forward leg's actual departure time is stored per-route (defaults to
  // 17:00 but is configurable); the return leg always departs Вльора at 11:00
  // per the published timetable.
  const baseTime = direction === 'forward' ? tour.departure_time : RETURN_BASE_DEPARTURE_TIME;
  const departure = addHoursToTimeOfDay(baseTime, originHours);
  const arrival = addHoursToTimeOfDay(baseTime, destinationHours);

  return {
    departureTime: departure.time,
    arrivalTime: arrival.time,
    durationText: formatHoursToDuration(destinationHours - originHours),
    departureDayOffset: departure.daysElapsed,
    arrivalDayOffset: arrival.daysElapsed,
  };
};

export const formatPrice = (price: number | null | undefined) => {
  if (price === null || price === undefined || !Number.isFinite(price)) return 'Ціна недоступна';
  return `${price} грн`;
};

export const formatDate = (date: string | null | undefined) => {
  if (!date) return 'Дата уточнюється';
  const parsedDate = new Date(date.includes('T') ? date : `${date}T12:00:00`);
  if (Number.isNaN(parsedDate.getTime())) return 'Дата уточнюється';
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' }).format(parsedDate);
};

export const toInputDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Adds/subtracts whole days to an ISO date string without the JS Date engine
// dropping a day across DST/timezone boundaries.
export const addDaysIso = (iso: string, days: number): string => {
  const [year, month, day] = iso.split('-').map(Number);
  const utcMillis = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const shifted = new Date(utcMillis);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const pluralizeUk = (count: number, one: string, few: string, many: string) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

export const describePassengers = (adults: number, children: number, distinguishChildren: boolean = true) => {
  if (!distinguishChildren) {
    const total = adults + children;
    return `${total} ${pluralizeUk(total, 'пасажир', 'пасажири', 'пасажирів')}`;
  }
  const parts = [`${adults} ${pluralizeUk(adults, 'дорослий', 'дорослих', 'дорослих')}`];
  if (children > 0) parts.push(`${children} ${pluralizeUk(children, 'дитина', 'дитини', 'дітей')}`);
  return parts.join(', ');
};

export const statusLabels: Record<BookingStatus, string> = {
  new: 'Нова',
  in_progress: 'В роботі',
  confirmed: 'Підтверджено',
  cancelled: 'Скасовано',
};
