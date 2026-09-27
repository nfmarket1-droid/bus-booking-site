import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import { uk } from 'date-fns/locale';
import { toast } from 'sonner';
import {
  ArrowRight,
  Baby,
  CalendarDays,
  Clock3,
  Luggage,
  Mail,
  MapPin,
  Menu,
  MessageCircle,
  Minus,
  Phone,
  Plane,
  Plus,
  Route,
  ShieldCheck,
  Sparkles,
  Ticket,
  Users,
  X,
} from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import {
  addDaysIso,
  computeSegmentSchedule,
  describePassengers,
  destinationCities,
  excludeSameCountry,
  forwardStops,
  formatDate,
  getCityDayOffset,
  getDirectionForCities,
  originCities,
  toInputDate,
  type Direction,
  type SegmentSchedule,
  type SourceStatus,
  type Tour,
  type TripType,
} from '@/lib/alf';

const MAX_ADULTS = 9;
const MAX_CHILDREN = 6;
const MAX_CHILD_AGE = 17;
const DEFAULT_CHILD_AGE = 8;

type BookingForm = { passengerNames: string[]; phone: string; email: string };

const heroImage = 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=1800&q=85';

const Index = () => {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [tripType, setTripType] = useState<TripType>('one_way');
  // The cached tours table is keyed by each direction's own departure date, anchored
  // at that direction's starting endpoint (Київ for "forward", Вльора for "return")
  // — this holds that raw anchored date, while `departureDate` below (derived) is
  // the customer-facing date at whatever city they actually picked as origin.
  const [anchorDepartureDate, setAnchorDepartureDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [childAges, setChildAges] = useState<number[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [tour, setTour] = useState<Tour | null>(null);
  const [returnTour, setReturnTour] = useState<Tour | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [form, setForm] = useState<BookingForm>({ passengerNames: [''], phone: '', email: '' });
  const [isBookingOpen, setIsBookingOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [calendarByDirection, setCalendarByDirection] = useState<Record<Direction, Record<string, SourceStatus>>>({ forward: {}, return: {} });
  const [discountByDirection, setDiscountByDirection] = useState<Record<Direction, Record<string, boolean>>>({ forward: {}, return: {} });

  // Whether the customer's picked origin/destination is the Kyiv→Вльора leg or the
  // Вльора→Kyiv leg — this decides which cached direction we search, and (for
  // round trips) which direction the return leg needs to search instead.
  const searchDirection: Direction = origin && destination ? getDirectionForCities(origin, destination) : 'forward';
  const oppositeDirection: Direction = searchDirection === 'forward' ? 'return' : 'forward';

  useEffect(() => {
    // Loads BOTH directions' calendars up front — a round trip always needs
    // availability data for both legs regardless of which one the customer
    // searches "outward" first.
    const loadCalendars = async () => {
      const { data } = await supabase
        .from('tours')
        .select('direction, departure_date, source_status, price, child_price')
        .gte('departure_date', toInputDate(new Date()));
      if (!data) return;
      const statusMap: Record<Direction, Record<string, SourceStatus>> = { forward: {}, return: {} };
      const discountMap: Record<Direction, Record<string, boolean>> = { forward: {}, return: {} };
      for (const row of data) {
        const dir = row.direction as Direction;
        statusMap[dir][row.departure_date] = row.source_status as SourceStatus;
        // Some routes may charge less for children than adults, others don't — we
        // only surface the "Діти" picker for dates where ALF actually returned a
        // cheaper child fare, so agents/customers aren't offered a fake discount.
        discountMap[dir][row.departure_date] = row.child_price !== null && row.price !== null && Number(row.child_price) < Number(row.price);
      }
      setCalendarByDirection(statusMap);
      setDiscountByDirection(discountMap);
      setAnchorDepartureDate((current) => current || Object.keys(statusMap.forward).sort()[0] || '');
    };
    loadCalendars();
  }, []);

  const tourStatusByDate = calendarByDirection[searchDirection];
  const childDiscountByDate = discountByDirection[searchDirection];
  const returnStatusByDate = calendarByDirection[oppositeDirection];

  useEffect(() => {
    // If flipping origin/destination changes which cached direction we're
    // searching, the previously selected date may not exist in that direction's
    // calendar — fall back to its earliest available date instead.
    setAnchorDepartureDate((current) => (tourStatusByDate[current] ? current : Object.keys(tourStatusByDate).sort()[0] || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDirection]);

  // A city further along the route departs on a later calendar day than that
  // direction's starting endpoint (e.g. Мукачево is +1 day from Kyiv) — shift the
  // anchored cache dates so the calendar and results show the date the customer
  // actually boards at their chosen city.
  const originDayOffset = origin ? getCityDayOffset(origin, searchDirection) : 0;
  const departureDate = anchorDepartureDate ? addDaysIso(anchorDepartureDate, originDayOffset) : '';
  const displayStatusByDate: Record<string, SourceStatus> = {};
  for (const [anchorDate, status] of Object.entries(tourStatusByDate)) {
    displayStatusByDate[addDaysIso(anchorDate, originDayOffset)] = status;
  }

  // The return leg's own "origin" is the outward destination — its calendar dates
  // are anchored at the opposite direction's starting endpoint, so they're shifted
  // the same way using that city's offset in the opposite direction.
  const destinationDayOffsetForReturn = destination ? getCityDayOffset(destination, oppositeDirection) : 0;
  const displayReturnStatusByDate: Record<string, SourceStatus> = {};
  for (const [anchorDate, status] of Object.entries(returnStatusByDate)) {
    displayReturnStatusByDate[addDaysIso(anchorDate, destinationDayOffsetForReturn)] = status;
  }
  const anchorReturnDate = returnDate ? addDaysIso(returnDate, -destinationDayOffsetForReturn) : '';

  const totalPassengers = adults + children;
  const outwardPrice = tour ? tour.price : null;
  const returnLegPrice = tripType === 'roundtrip' && returnTour ? returnTour.price : null;
  const separateLegsSum = outwardPrice !== null && returnLegPrice !== null ? outwardPrice + returnLegPrice : null;
  // ALF's own site can give a cheaper combined price when the "туди і назад"
  // checkbox is ticked than simply adding up the two one-way prices — the parser
  // caches that combined price on the outward tour row. We only ever show it when
  // it's actually cheaper than (or equal to) the separate legs added together;
  // otherwise the separate-legs sum is the honest, lower price.
  const roundtripComboPrice = tripType === 'roundtrip' && tour ? tour.roundtrip_price : null;
  const price =
    tripType === 'roundtrip'
      ? roundtripComboPrice !== null && separateLegsSum !== null
        ? Math.min(roundtripComboPrice, separateLegsSum)
        : roundtripComboPrice ?? separateLegsSum
      : outwardPrice;
  // ALF prices this route the same for adults and children, but other routes could
  // theoretically charge differently — the parser stores a separate child_price
  // whenever ALF's ticket grid actually returns one, falling back to the adult price.
  const outwardChildPrice = tour ? tour.child_price ?? outwardPrice : null;
  const returnLegChildPrice = tripType === 'roundtrip' && returnTour ? returnTour.child_price ?? returnLegPrice : null;
  const childPrice =
    tripType === 'roundtrip'
      ? outwardChildPrice !== null && returnLegChildPrice !== null
        ? outwardChildPrice + returnLegChildPrice
        : null
      : outwardChildPrice;
  const totalPrice = price === null ? null : price * adults + (childPrice ?? price) * children;
  const outwardOverCapacity = tour ? tour.available_seats !== null && tour.available_seats < totalPassengers : false;
  const returnOverCapacity = tripType === 'roundtrip' && returnTour ? returnTour.available_seats !== null && returnTour.available_seats < totalPassengers : false;
  const overCapacity = outwardOverCapacity || returnOverCapacity;
  const returnLegOk = tripType !== 'roundtrip' || (returnTour !== null && returnTour.source_status !== 'sold_out' && returnTour.source_status !== 'error');
  const canBook =
    tour !== null &&
    price !== null &&
    tour.source_status !== 'sold_out' &&
    tour.source_status !== 'error' &&
    !overCapacity &&
    returnLegOk;
  // ALF's own site still shows the flight card (with a red "немає місць" banner) even
  // when it's fully booked — we mirror that instead of hiding the whole card. We only
  // fall back to the "not found" state when we have no data at all for the date (or,
  // for round trips, when the return leg has no data either).
  const showCard =
    tour !== null &&
    tour.source_status !== 'error' &&
    (tripType !== 'roundtrip' || (returnTour !== null && returnTour.source_status !== 'error'));
  // The cached tour always stores the full route schedule for its direction — this
  // derives the actual departure/arrival time and duration for whatever segment the
  // customer searched for (e.g. Мукачево → Добра Вода), per ALF's published timetable.
  const segmentSchedule = tour ? computeSegmentSchedule(origin, destination, tour, searchDirection) : null;
  // Whether the currently selected departure date has an actual child discount on
  // ALF's ticket grid — this route may, other routes may not, so it's looked up
  // per date instead of assumed.
  const hasChildDiscount = childDiscountByDate[anchorDepartureDate] ?? false;

  const applyPassengerCounts = (nextAdults: number, nextChildren: number, nextChildAges: number[]) => {
    setAdults(nextAdults);
    setChildren(nextChildren);
    setChildAges(nextChildAges);
    const total = nextAdults + nextChildren;
    setForm((current) => ({ ...current, passengerNames: Array.from({ length: total }, (_, index) => current.passengerNames[index] ?? '') }));
  };
  const changeAdults = (delta: number) => applyPassengerCounts(Math.min(MAX_ADULTS, Math.max(1, adults + delta)), children, childAges);
  const changeChildren = (delta: number) => {
    const nextChildren = Math.min(MAX_CHILDREN, Math.max(0, children + delta));
    const nextChildAges = Array.from({ length: nextChildren }, (_, index) => childAges[index] ?? DEFAULT_CHILD_AGE);
    applyPassengerCounts(adults, nextChildren, nextChildAges);
  };
  const changeChildAge = (index: number, age: number) => setChildAges((current) => current.map((value, i) => (i === index ? age : value)));

  useEffect(() => {
    // If the selected date turns out to have no child discount, fold any already
    // selected children back into the adult count so pricing stays consistent.
    if (!hasChildDiscount && children > 0) applyPassengerCounts(adults + children, 0, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorDepartureDate, hasChildDiscount]);

  const startSearch = async () => {
    if (isSearching) return;
    if (!origin) {
      toast.error('Оберіть пункт відправлення');
      return;
    }
    if (!destination) {
      toast.error('Оберіть пункт прибуття');
      return;
    }
    if (!anchorDepartureDate) {
      toast.error('Оберіть дату виїзду');
      return;
    }
    if (tripType === 'roundtrip' && !returnDate) {
      toast.error('Оберіть дату повернення для маршруту "Туди і назад"');
      return;
    }
    setIsSearching(true);
    setTour(null);
    setReturnTour(null);
    // The customer search always queries our local cache instantly — never a live
    // scraper. The cache is keyed by each direction's own anchored departure date,
    // not the customer's origin-local date.
    const { data } = await supabase
      .from('tours')
      .select('*')
      .eq('direction', searchDirection)
      .eq('departure_date', anchorDepartureDate)
      .maybeSingle();
    let returnData: Tour | null = null;
    if (tripType === 'roundtrip') {
      const { data: returnLegData } = await supabase
        .from('tours')
        .select('*')
        .eq('direction', oppositeDirection)
        .eq('departure_date', anchorReturnDate)
        .maybeSingle();
      returnData = returnLegData as Tour | null;
    }
    setIsSearching(false);
    setHasSearched(true);
    setTour(data as Tour | null);
    setReturnTour(returnData);
    window.setTimeout(() => document.getElementById('результати')?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const openBooking = () => {
    if (!canBook) return;
    setIsSubmitted(false);
    setForm((current) => ({ ...current, passengerNames: Array.from({ length: totalPassengers }, (_, index) => current.passengerNames[index] ?? '') }));
    setIsBookingOpen(true);
  };

  const submitBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!tour || totalPrice === null) return;
    if (form.passengerNames.some((name) => !name.trim())) {
      toast.error('Вкажіть ПІБ кожного пасажира');
      return;
    }
    if (!form.phone.trim() || !form.email.trim()) {
      toast.error('Вкажіть контактний телефон та email');
      return;
    }
    setIsSubmitting(true);
    const { error } = await supabase.from('bookings').insert({
      origin,
      destination,
      departure_date: departureDate,
      return_date: tripType === 'roundtrip' ? returnDate || null : null,
      trip_type: tripType,
      passenger_count: totalPassengers,
      passengers: form.passengerNames.map((fullName, index) =>
        index < adults ? { fullName, type: 'adult' } : { fullName, type: 'child', age: childAges[index - adults] },
      ),
      extras: { adults, children, childAges },
      contact_name: form.passengerNames[0] ?? '',
      phone: form.phone,
      email: form.email,
      total_price: totalPrice,
    });
    setIsSubmitting(false);
    if (error) {
      toast.error('Не вдалося надіслати заявку. Спробуйте ще раз.');
      return;
    }
    setIsSubmitted(true);
    toast.success('Заявку отримано — ми зателефонуємо для підтвердження.');
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f8f6f1] text-[#123b4a]">
      <header className="relative z-30 border-b border-[#e2edf1] bg-white shadow-[0_3px_18px_rgba(18,59,74,.06)]">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between px-5 py-5 lg:px-8">
          <Link to="/" className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#147d92] text-white shadow-lg shadow-[#147d92]/20"><Route size={22} /></span><span><strong className="block font-display text-lg leading-tight">Морський Шлях</strong><span className="text-[10px] uppercase tracking-[0.2em] text-[#78939d]">автобусні подорожі</span></span></Link>
          <nav className="hidden items-center gap-8 text-sm font-semibold text-[#526f7a] lg:flex"><a href="#маршрут" className="transition hover:text-[#0b8fb5]">Маршрут</a><a href="#переваги" className="transition hover:text-[#0b8fb5]">Як це працює</a><a href="#контакти" className="transition hover:text-[#0b8fb5]">Контакти</a><Link to="/admin" className="rounded-xl border border-[#d4e5e1] px-4 py-2 text-[#147d92] transition hover:bg-[#eef7fa]">Кабінет агенції</Link></nav>
          <button className="rounded-xl border border-[#d4e5e1] p-2 text-[#147d92] lg:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Відкрити меню">{mobileMenuOpen ? <X size={21} /> : <Menu size={21} />}</button>
        </div>
        {mobileMenuOpen && <nav className="mx-5 mb-4 grid gap-2 rounded-2xl border border-[#e2edf1] bg-white p-4 text-sm font-semibold text-[#315b62] shadow-xl lg:hidden"><a href="#маршрут" onClick={() => setMobileMenuOpen(false)} className="rounded-xl px-3 py-2 hover:bg-[#eef7fa]">Маршрут</a><a href="#переваги" onClick={() => setMobileMenuOpen(false)} className="rounded-xl px-3 py-2 hover:bg-[#eef7fa]">Як це працює</a><Link to="/admin" className="rounded-xl px-3 py-2 hover:bg-[#eef7fa]">Кабінет агенції</Link></nav>}
      </header>

      <main>
        <section className="relative isolate min-h-[690px] overflow-visible bg-[#123b4a] pb-36 pt-32 lg:pb-32 lg:pt-40"><div className="absolute inset-0 -z-20 bg-[#123b4a]" /><div className="absolute inset-0 -z-10 bg-cover bg-center opacity-40" style={{ backgroundImage: `url(${heroImage})` }} /><div className="absolute inset-0 -z-10 bg-[#123b4a]/85" /><div className="mx-auto max-w-[1240px] px-5 lg:px-8"><div className="max-w-2xl text-white"><div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-[#f1bf6b]"><Sparkles size={14} /> ALF туроператор</div><h1 className="max-w-xl font-display text-5xl font-semibold leading-[0.97] tracking-[-0.055em] sm:text-6xl lg:text-[78px]">Київ <span className="text-[#f1bf6b]">— Вльора.</span></h1><p className="mt-6 max-w-lg text-base leading-7 text-white/75 sm:text-lg">Прямий маршрут ALF з Києва до Адріатики. Оберіть дату виїзду та отримайте ціну з нашого кешу ticket grid оператора.</p><div className="mt-8 flex flex-wrap gap-3 text-sm text-white/80"><span className="flex items-center gap-2"><ShieldCheck size={17} className="text-[#f1bf6b]" /> Без прихованих комісій</span><span className="flex items-center gap-2"><ShieldCheck size={17} className="text-[#f1bf6b]" /> Ціна оновлюється автоматично</span></div></div></div>
          <div className="absolute -bottom-24 left-1/2 z-10 w-[calc(100%-2.5rem)] max-w-[1160px] -translate-x-1/2 lg:-bottom-16"><div className="rounded-2xl border border-[#e2edf1] bg-white p-4 shadow-[0_26px_70px_rgba(18,59,74,.22)] lg:p-6"><div className="mb-5 flex items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#147d92]">Пошук квитка</p><h2 className="mt-1 font-display text-2xl font-semibold tracking-[-0.04em]">Знайдіть свій маршрут до моря</h2></div><div className="hidden rounded-full bg-[#e8f3f1] px-3 py-2 text-xs font-bold text-[#147d92] sm:flex sm:items-center sm:gap-2"><ShieldCheck size={15} /> Дані з ticket grid ALF</div></div><div className="grid gap-3 lg:grid-cols-[1.1fr_1.1fr_1fr_1fr_1.1fr_auto]"><CitySearch label="Пункт відправлення" value={origin} options={excludeSameCountry(originCities, destination)} onChange={setOrigin} /><CitySearch label="Пункт прибуття" value={destination} options={excludeSameCountry(destinationCities, origin)} onChange={setDestination} /><Field label="Дата виїзду" icon={<CalendarDays size={17} />}><DatePicker value={departureDate} minDate={toInputDate(new Date())} dateStatusMap={displayStatusByDate} onChange={(value) => setAnchorDepartureDate(addDaysIso(value, -originDayOffset))} /></Field><Field label="Дата повернення" icon={<CalendarDays size={17} />} muted={tripType !== 'roundtrip'}><DatePicker value={returnDate} minDate={departureDate} dateStatusMap={tripType === 'roundtrip' ? displayReturnStatusByDate : undefined} disabled={tripType !== 'roundtrip'} onChange={setReturnDate} /></Field><Field label="Кількість пасажирів" icon={<Users size={17} />}><PassengerPicker adults={adults} childCount={children} childAges={childAges} showChildren={hasChildDiscount} onAdultsChange={changeAdults} onChildrenChange={changeChildren} onChildAgeChange={changeChildAge} /></Field><button onClick={startSearch} disabled={isSearching} className="mt-auto flex h-[52px] items-center justify-center gap-2 rounded-2xl bg-[#147d92] px-5 font-bold text-white transition hover:-translate-y-0.5 hover:bg-[#0d6577] disabled:opacity-60">{isSearching ? 'Шукаємо…' : 'Знайти'} <ArrowRight size={18} /></button></div><label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm font-semibold text-[#42606a]"><input type="checkbox" checked={tripType === 'roundtrip'} onChange={(event) => setTripType(event.target.checked ? 'roundtrip' : 'one_way')} className="h-4 w-4 rounded border-[#a8c8c8] accent-[#147d92]" /> Туди і назад</label></div></div>
        </section>

        <section id="результати" className="mx-auto max-w-[1240px] px-5 pb-20 pt-36 lg:px-8 lg:pt-28">{hasSearched ? <div className="animate-fade-up"><div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="eyebrow">Доступні рейси</p><h2 className="section-title">{origin} <span className="text-[#b4c8c7]">→</span> {destination}</h2><p className="mt-2 text-sm text-[#63777b]">{formatDate(departureDate)} · {describePassengers(adults, children)}</p></div><span className="flex items-center gap-2 text-sm font-semibold text-[#147d92]"><span className="h-2 w-2 rounded-full bg-[#54b98d]" /> Дані з локального кешу ALF</span></div>{showCard && tour ? <RideCard tour={tour} returnTour={returnTour} origin={origin} destination={destination} segmentSchedule={segmentSchedule} tripType={tripType} passengers={totalPassengers} price={price} totalPrice={totalPrice} overCapacity={overCapacity} onBook={openBooking} /> : <EmptySearch />}</div> : <div className="grid gap-12 lg:grid-cols-[.9fr_1.1fr] lg:items-center"><div><p className="eyebrow">Подорож без поспіху</p><h2 className="section-title max-w-lg">Ваша відпустка починається ще в дорозі</h2><p className="mt-5 max-w-md leading-7 text-[#63777b]">Ми покажемо тільки ту вартість, яку зберіг наш кеш із офіційного ticket grid ALF для обраної дати.</p><div className="mt-7 flex flex-wrap gap-3"><span className="soft-pill"><Clock3 size={16} /> 40+ годин у дорозі</span><span className="soft-pill"><Route size={16} /> 17 зупинок</span></div></div><div className="relative overflow-hidden rounded-[32px] bg-[#dcece8] p-5 sm:p-8"><div className="relative"><div className="flex items-center justify-between text-sm font-bold text-[#147d92]"><span>КИЇВ</span><span className="rounded-full bg-white/75 px-3 py-1 text-xs text-[#718484]">+2 дні</span><span>ВЛЬОРА</span></div><div className="relative my-9 h-1 rounded-full bg-[#95c3bd]"><span className="absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-4 border-[#dcece8] bg-[#147d92]" /><span className="absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-4 border-[#dcece8] bg-[#f1a65b]" /></div><div className="grid grid-cols-4 gap-2 text-center text-xs font-semibold text-[#52747a]"><span>Україна</span><span>Румунія</span><span>Чорногорія</span><span>Албанія</span></div><div className="mt-10 flex items-end justify-between"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#6a8a8a]">Перший рейс</p><p className="mt-1 font-display text-2xl font-semibold">Щоп’ятниці</p></div><div className="rounded-2xl bg-[#147d92] p-4 text-white shadow-lg shadow-[#147d92]/20"><Plane size={25} /></div></div></div></div></div>}</section>
        <section id="маршрут" className="border-y border-[#deebe6] bg-white py-20"><div className="mx-auto max-w-[1240px] px-5 lg:px-8"><div className="max-w-xl"><p className="eyebrow">Маршрут подорожі</p><h2 className="section-title">Краєвиди змінюються — комфорт залишається</h2><p className="mt-4 leading-7 text-[#63777b]">Від київської ранкової кави до першого купання в Адріатичному морі.</p></div><div className="mt-12 overflow-x-auto pb-4"><div className="relative flex min-w-[980px] items-start px-3"><div className="absolute left-5 right-5 top-4 h-0.5 bg-[#b9d9d3]" />{forwardStops.map((stop, index) => <div key={stop.city} className="relative z-10 flex w-[58px] flex-1 flex-col items-center gap-4 text-center"><span className={`h-8 w-8 rounded-full border-4 border-white shadow-[0_0_0_1px_#b9d9d3] ${index === 0 ? 'bg-[#147d92]' : index === forwardStops.length - 1 ? 'bg-[#f1a65b]' : 'bg-[#d7eae5]'}`} /><div><p className="text-xs font-bold leading-4 text-[#315b62]">{stop.city}</p>{stop.country && <p className="mt-1 text-[10px] text-[#91a7a6]">{stop.country}</p>}</div></div>)}</div></div></div></section>
        <section id="переваги" className="mx-auto max-w-[1240px] px-5 py-20 lg:px-8"><div className="grid gap-5 md:grid-cols-3"><Benefit icon={<ShieldCheck />} title="Чесна ціна" text="Показуємо тільки значення, яке наш кеш зберіг з активної кнопки покупки на стороні ALF." /><Benefit icon={<Users />} title="Людяна підтримка" text="Менеджер зв’яжеться з вами та допоможе спокійно підготувати поїздку." /><Benefit icon={<Sparkles />} title="Все для дороги" text="Пряме сполучення без пересадок, з комфортними зупинками у дорозі." /></div></section>
      </main>
      <footer id="контакти" className="bg-[#123b4a] text-white"><div className="mx-auto grid max-w-[1240px] gap-10 px-5 py-12 lg:grid-cols-[1.5fr_1fr_1fr] lg:px-8"><div><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f1bf6b] text-[#123b4a]"><Route size={20} /></span><span className="font-display text-xl font-semibold">Морський Шлях</span></div><p className="mt-5 max-w-sm text-sm leading-6 text-white/60">Подорожі до Адріатики, які хочеться повторити.</p></div><div><p className="text-xs font-bold uppercase tracking-[.17em] text-[#f1bf6b]">Зв’язок</p><a href="tel:+380671234567" className="mt-4 flex items-center gap-2 text-sm text-white/80"><Phone size={16} /> +38 (067) 123-45-67</a><a href="mailto:hello@morskyishliakh.ua" className="mt-3 flex items-center gap-2 text-sm text-white/80"><Mail size={16} /> hello@morskyishliakh.ua</a></div><div><p className="text-xs font-bold uppercase tracking-[.17em] text-[#f1bf6b]">Для менеджерів</p><Link to="/admin" className="mt-4 inline-flex items-center gap-2 text-sm text-white/80 hover:text-white">Увійти до кабінету</Link></div></div><div className="border-t border-white/10 py-5 text-center text-xs text-white/35">© 2025 Морський Шлях · Працюємо з туроператором ALF</div></footer>
      {isBookingOpen && tour && <BookingModal tour={tour} origin={origin} destination={destination} departureDate={departureDate} totalPrice={totalPrice} adults={adults} childAges={childAges} form={form} setForm={setForm} isSubmitting={isSubmitting} isSubmitted={isSubmitted} onClose={() => setIsBookingOpen(false)} onSubmit={submitBooking} />}
    </div>
  );
};

const DatePicker = ({
  value,
  minDate,
  disabled = false,
  dateStatusMap,
  onChange,
}: {
  value: string;
  minDate?: string;
  disabled?: boolean;
  dateStatusMap?: Record<string, SourceStatus>;
  onChange: (value: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateInput(value);
  const minimumDate = parseDateInput(minDate ?? '');

  const availableDates: Date[] = [];
  const fewDates: Date[] = [];
  const soldOutDates: Date[] = [];
  if (dateStatusMap) {
    for (const [dateStr, status] of Object.entries(dateStatusMap)) {
      const parsed = parseDateInput(dateStr);
      if (!parsed) continue;
      if (status === 'available' || status === 'demo') availableDates.push(parsed);
      else if (status === 'few') fewDates.push(parsed);
      else if (status === 'sold_out') soldOutDates.push(parsed);
    }
  }

  const disabledMatchers = [];
  if (minimumDate) disabledMatchers.push({ before: minimumDate });
  if (dateStatusMap) disabledMatchers.push((date: Date) => !dateStatusMap[toInputDate(date)]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} className="form-control flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed">
          <span className={selectedDate ? 'text-[#315b62]' : 'text-[#9badab]'}>{selectedDate ? formatInputDate(selectedDate) : 'дд.мм.рррр'}</span>
          <CalendarDays size={17} className="shrink-0 text-[#78939d]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto rounded-2xl border-[#d7e5ea] bg-white p-2 shadow-[0_16px_35px_rgba(18,59,74,.16)]">
        <Calendar
          mode="single"
          locale={uk}
          selected={selectedDate}
          defaultMonth={selectedDate ?? minimumDate}
          disabled={disabledMatchers.length ? disabledMatchers : undefined}
          modifiers={dateStatusMap ? { tourAvailable: availableDates, tourFew: fewDates, tourSoldOut: soldOutDates } : undefined}
          modifiersClassNames={{
            tourAvailable: '!bg-[#ddf2e8] !text-[#1c7a52] font-bold rounded-full',
            tourFew: '!bg-[#fff1d9] !text-[#a86c25] font-bold rounded-full',
            tourSoldOut: '!bg-[#fbe4e4] !text-[#b33a3a] font-bold rounded-full',
          }}
          classNames={{ month_caption: 'relative flex min-h-10 items-center justify-center pt-1', nav: 'pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 items-center justify-between px-1', button_previous: 'pointer-events-auto h-8 w-8 rounded-lg border border-[#d7e5ea] bg-white p-0 text-[#147d92] hover:bg-[#eef7fa]', button_next: 'pointer-events-auto h-8 w-8 rounded-lg border border-[#d7e5ea] bg-white p-0 text-[#147d92] hover:bg-[#eef7fa]' }}
          onSelect={(date) => { if (date) { onChange(toInputDate(date)); setOpen(false); } }}
          initialFocus
        />
        {dateStatusMap && (
          <div className="mt-1 flex flex-wrap items-center gap-3 border-t border-[#eef2f2] px-2 pt-3 text-[11px] font-semibold text-[#63777b]">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#54b98d]" /> є місця</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#f1a65b]" /> мало місць</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#d9645a]" /> немає місць</span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
const parseDateInput = (value: string) => { if (!value) return undefined; const parsedDate = new Date(value.includes('T') ? value : `${value}T12:00:00`); return Number.isNaN(parsedDate.getTime()) ? undefined : parsedDate; };
const formatInputDate = (date: Date) => `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
const CitySearch = ({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const filtered = query.length > 0 ? options.filter((city) => city.toLowerCase().includes(query.toLowerCase())) : [];
  const showSuggestions = open && filtered.length > 0;

  useEffect(() => { setQuery(value); }, [value]);

  return (
    <Field label={label} icon={<MapPin size={17} />}>
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(event) => { setQuery(event.target.value); onChange(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder="Оберіть або введіть місто"
          className="form-control"
        />
        {showSuggestions && (
          <div className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-auto rounded-xl border border-[#d7e5ea] bg-white shadow-lg">
            {filtered.map((city) => (
              <button
                key={city}
                type="button"
                onMouseDown={() => { onChange(city); setQuery(city); setOpen(false); }}
                className="w-full px-4 py-2.5 text-left text-sm font-semibold text-[#315b62] transition hover:bg-[#eef7fa] first:rounded-t-xl last:rounded-b-xl"
              >
                {city}
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
};
const Field = ({ label, icon, children, muted = false }: { label: string; icon: ReactNode; children: ReactNode; muted?: boolean }) => <label className={`block ${muted ? 'opacity-45' : ''}`}><span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-[#719094]">{icon}{label}</span>{children}</label>;

const StepperRow = ({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (delta: number) => void }) => (
  <div className="flex items-center justify-between gap-3 py-1.5">
    <span className="text-sm font-semibold text-[#315b62]">{label}</span>
    <div className="flex items-center gap-3">
      <button type="button" onClick={() => onChange(-1)} disabled={value <= min} className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4e5e1] text-[#147d92] transition hover:bg-[#eef7fa] disabled:cursor-not-allowed disabled:opacity-40"><Minus size={15} /></button>
      <span className="w-4 text-center font-display text-base font-semibold text-[#123b4a]">{value}</span>
      <button type="button" onClick={() => onChange(1)} disabled={value >= max} className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4e5e1] text-[#147d92] transition hover:bg-[#eef7fa] disabled:cursor-not-allowed disabled:opacity-40"><Plus size={15} /></button>
    </div>
  </div>
);

const PassengerPicker = ({
  adults,
  childCount,
  childAges,
  showChildren,
  onAdultsChange,
  onChildrenChange,
  onChildAgeChange,
}: {
  adults: number;
  childCount: number;
  childAges: number[];
  showChildren: boolean;
  onAdultsChange: (delta: number) => void;
  onChildrenChange: (delta: number) => void;
  onChildAgeChange: (index: number, age: number) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="form-control flex items-center justify-between gap-2 text-left">
          <span className="truncate text-[#315b62]">{describePassengers(adults, showChildren ? childCount : 0, showChildren)}</span>
          <Users size={17} className="shrink-0 text-[#78939d]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 rounded-2xl border-[#d7e5ea] bg-white p-4 shadow-[0_16px_35px_rgba(18,59,74,.16)]">
        <StepperRow label={showChildren ? 'Дорослі' : 'Пасажири'} value={adults} min={1} max={MAX_ADULTS} onChange={onAdultsChange} />
        {showChildren && (
          <>
            <div className="my-2 h-px bg-[#eef2f2]" />
            <StepperRow label="Діти (до 18 років)" value={childCount} min={0} max={MAX_CHILDREN} onChange={onChildrenChange} />
            {childCount > 0 && (
              <div className="mt-3 space-y-2 border-t border-[#eef2f2] pt-3">
                <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-[#719094]"><Baby size={14} /> Вік дитини</p>
                {childAges.map((age, index) => (
                  <label key={index} className="flex items-center justify-between gap-2 text-sm font-semibold text-[#315b62]">
                    <span>Дитина {index + 1}</span>
                    <select value={age} onChange={(event) => onChildAgeChange(index, Number(event.target.value))} className="rounded-lg border border-[#d4e5e1] bg-white px-2 py-1.5 text-sm font-semibold text-[#315b62] outline-none focus:border-[#0b9bc1]">
                      {Array.from({ length: MAX_CHILD_AGE + 1 }, (_, value) => value).map((value) => <option key={value} value={value}>{value} р.</option>)}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
};

const RideCard = ({ tour, returnTour, origin, destination, segmentSchedule, tripType, passengers, price, totalPrice, overCapacity, onBook }: { tour: Tour; returnTour: Tour | null; origin: string; destination: string; segmentSchedule: SegmentSchedule | null; tripType: TripType; passengers: number; price: number | null; totalPrice: number | null; overCapacity: boolean; onBook: () => void }) => {
  const isRoundtrip = tripType === 'roundtrip';
  const isSoldOut = tour.source_status === 'sold_out' || (isRoundtrip && returnTour?.source_status === 'sold_out');
  const isFew = !isSoldOut && (tour.source_status === 'few' || (isRoundtrip && returnTour?.source_status === 'few'));
  const noSeatsForGroup = isSoldOut || overCapacity;
  const canBook = !noSeatsForGroup && price !== null && tour.source_status !== 'error' && (!isRoundtrip || (returnTour !== null && returnTour.source_status !== 'error'));
  const departureTime = segmentSchedule?.departureTime ?? tour.departure_time;
  const arrivalTime = segmentSchedule?.arrivalTime ?? tour.arrival_time;
  const durationText = segmentSchedule?.durationText ?? tour.duration_text;
  const arrivalDaysAhead = segmentSchedule ? segmentSchedule.arrivalDayOffset - segmentSchedule.departureDayOffset : null;
  return (
    <div className="overflow-hidden rounded-[26px] border border-[#dce9e3] bg-white shadow-[0_18px_50px_rgba(18,59,74,.06)]">
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="rounded-full bg-[#e8f3f1] px-3 py-1.5 text-xs font-bold text-[#147d92]">{tour.carrier_name}</span>{durationText && <span className="flex items-center gap-1.5 text-xs font-semibold text-[#718484]"><Clock3 size={14} /> час у дорозі {durationText}</span>}</div>
        <p className="mt-3 font-display text-lg font-semibold text-[#123b4a]">{tour.route_class}</p>
        <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-6">
            <div><p className="font-display text-3xl font-semibold">{departureTime}</p><p className="mt-1 text-xs font-bold uppercase tracking-[.12em] text-[#8ba09f]">{origin.toUpperCase()}</p></div>
            <div className="flex flex-1 items-center gap-2 text-[#b4c8c7]"><span className="h-px w-10 bg-[#c7dcd5] sm:w-16" /><Route size={18} /><span className="h-px w-10 bg-[#c7dcd5] sm:w-16" /></div>
            <div><p className="font-display text-3xl font-semibold">{arrivalTime}</p><p className="mt-1 text-xs font-bold uppercase tracking-[.12em] text-[#8ba09f]">{destination.toUpperCase()}{arrivalDaysAhead ? ` · +${arrivalDaysAhead} дн.` : ''}</p></div>
          </div>
          <span className="flex items-center gap-2 text-sm font-semibold text-[#718484]"><Luggage size={17} className="text-[#147d92]" /> Багаж: 💼</span>
        </div>
      </div>
      {noSeatsForGroup ? (
        <div className="bg-[#fbe4e4] px-5 py-4 text-center sm:px-7">
          <span className="text-sm font-bold text-[#b33a3a]">{isSoldOut ? 'Немає місць' : `Недостатньо місць: доступно ${Math.min(tour.available_seats ?? Infinity, isRoundtrip ? returnTour?.available_seats ?? Infinity : Infinity)} із ${passengers}`}</span>
        </div>
      ) : (
        <div className={`flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7 ${isFew ? 'bg-[#fff1d9]' : 'bg-[#ddf2e8]'}`}>
          <span className={`text-sm font-bold ${isFew ? 'text-[#a86c25]' : 'text-[#1c7a52]'}`}>{isFew ? 'місць мало' : 'є місця'}{tour.available_seats !== null && ` · вільно ${isRoundtrip && returnTour?.available_seats !== null && returnTour?.available_seats !== undefined ? Math.min(tour.available_seats, returnTour.available_seats) : tour.available_seats}`}</span>
          <button onClick={onBook} disabled={!canBook} className="flex items-center justify-center gap-2 rounded-2xl bg-[#147d92] px-5 py-3 font-bold text-white transition hover:-translate-y-0.5 hover:bg-[#0d6577] disabled:cursor-not-allowed disabled:opacity-60">{totalPrice !== null ? `${totalPrice} грн` : 'Ціна недоступна'} · {tripType === 'roundtrip' ? 'туди-назад' : 'в один бік'}</button>
        </div>
      )}
    </div>
  );
};

const EmptySearch = () => (
  <div className="rounded-[26px] border border-dashed border-[#e0c2b6] bg-white p-10 text-center"><Ticket className="mx-auto text-[#ba634c]" size={28} /><p className="mt-3 font-display text-lg font-semibold text-[#123b4a]">Рейс недоступний</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#718484]">Дані для цієї дати ще не синхронізовано з ALF. Спробуйте іншу дату або зверніться пізніше.</p></div>
);

const Benefit = ({ icon, title, text }: { icon: ReactNode; title: string; text: string }) => <div className="rounded-[24px] border border-[#e2edf1] bg-white p-6"><div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#e8f3f1] text-[#147d92]">{icon}</div><h3 className="mt-4 font-display text-lg font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-[#718484]">{text}</p></div>;

const BookingModal = ({ tour, origin, destination, departureDate, totalPrice, adults, childAges, form, setForm, isSubmitting, isSubmitted, onClose, onSubmit }: { tour: Tour; origin: string; destination: string; departureDate: string; totalPrice: number | null; adults: number; childAges: number[]; form: BookingForm; setForm: Dispatch<SetStateAction<BookingForm>>; isSubmitting: boolean; isSubmitted: boolean; onClose: () => void; onSubmit: (event: FormEvent) => void }) => (
  <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0d2530]/60 p-0 backdrop-blur-sm sm:items-center sm:p-5" onClick={onClose}>
    <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[32px] bg-white p-6 shadow-2xl sm:rounded-[32px] sm:p-8" onClick={(event) => event.stopPropagation()}>
      {isSubmitted ? (
        <div className="py-10 text-center"><div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[#ddf2e8] text-[#1c7a52]"><ShieldCheck size={30} /></div><h3 className="mt-6 font-display text-2xl font-semibold">Заявку прийнято!</h3><p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#718484]">Наш менеджер зв’яжеться з вами протягом робочого дня для підтвердження бронювання.</p><button onClick={onClose} className="mt-7 rounded-2xl bg-[#147d92] px-6 py-3 font-bold text-white hover:bg-[#0d6577]">Готово</button></div>
      ) : (
        <form onSubmit={onSubmit}>
          <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#147d92]">Оформлення заявки</p><h3 className="mt-1 font-display text-2xl font-semibold">{origin} → {destination}</h3><p className="mt-1 text-sm text-[#718484]">{formatDate(departureDate)} · {describePassengers(adults, childAges.length)}</p></div><button type="button" onClick={onClose} className="rounded-xl p-2 text-[#8ba09f] hover:bg-[#f4f7f4]"><X size={20} /></button></div>
          <div className="mt-6 grid gap-4">
            <p className="detail-label">ПІБ пасажирів</p>
            {form.passengerNames.map((name, index) => {
              const isChild = index >= adults;
              const placeholder = isChild
                ? `Пасажир ${index + 1} (дитина, ${childAges[index - adults]} р.): Прізвище Ім’я По батькові`
                : `Пасажир ${index + 1} (дорослий): Прізвище Ім’я По батькові`;
              return (
                <input key={index} value={name} onChange={(event) => setForm((current) => ({ ...current, passengerNames: current.passengerNames.map((n, i) => (i === index ? event.target.value : n)) }))} placeholder={placeholder} className="form-control" required />
              );
            })}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block"><span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-[#719094]"><Phone size={15} /> Телефон (Telegram / Viber)</span><input type="tel" value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} placeholder="+380 XX XXX XX XX" className="form-control" required /></label>
              <label className="block"><span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-[#719094]"><Mail size={15} /> Email</span><input type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} placeholder="email@example.com" className="form-control" required /></label>
            </div>
            <p className="flex items-center gap-2 text-xs text-[#8ba09f]"><MessageCircle size={14} /> Ми напишемо у Telegram або Viber за цим номером, якщо буде зручніше.</p>
          </div>
          <div className="mt-6 flex items-center justify-between rounded-2xl bg-[#f4f7f4] px-4 py-3"><span className="text-sm font-semibold text-[#718484]">До сплати</span><strong className="font-display text-2xl text-[#123b4a]">{totalPrice !== null ? `${totalPrice} грн` : '—'}</strong></div>
          <button type="submit" disabled={isSubmitting} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#147d92] py-3.5 font-bold text-white transition hover:bg-[#0d6577] disabled:opacity-60">{isSubmitting ? 'Надсилаємо…' : 'Надіслати заявку'} <ArrowRight size={18} /></button>
        </form>
      )}
    </div>
  </div>
);

export default Index;
