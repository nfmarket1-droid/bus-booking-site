import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import type { Session } from '@supabase/supabase-js';
import { ArrowLeft, Clock3, FileSearch, ListTree, MapPin, Plus, RefreshCw, Route as RouteIcon, ShieldCheck, Trash2 } from 'lucide-react';
import { supabase, SUPABASE_PUBLISHABLE_KEY } from '@/integrations/supabase/client';

type Direction = 'forward' | 'return';

type SyncRun = {
  id: string;
  run_at: string;
  route_id: string | null;
  route_name: string | null;
  sync_type: 'prices' | 'schedule' | 'roundtrip';
  direction: Direction;
  calendar_source: string;
  calendar_dates_found: number;
  active_dates: string[];
  tours_updated: number;
  available_count: number;
  few_count: number;
  sold_out_count: number;
  error_count: number;
  sample_request: Record<string, string> | null;
  sample_response_snippet: string | null;
  calendar_snippet: string | null;
  errors: { date: string; error: string }[];
  results_debug: {
    date: string;
    status: string;
    price: number | null;
    durationText?: string | null;
    availableSeats?: number | null;
    returnDate?: string | null;
    error: string | null;
    requestBody: Record<string, string>;
    responseSnippet: string;
  }[];
  fatal_error: string | null;
  schedule_source_url: string | null;
  schedule_parse_status: 'ok' | 'warning' | 'skipped' | 'error' | null;
  schedule_stops_found: number | null;
  schedule_parse_error: string | null;
  schedule_snippet: string | null;
};

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

type RouteStop = {
  id: string;
  route_id: string;
  direction: Direction;
  sort_order: number;
  city: string;
  country: string | null;
  hours_from_start: number;
  clock_time: string | null;
  note: string | null;
  geo_link: string | null;
};

type RouteDraft = {
  forward_schedule_source_url: string;
  return_schedule_source_url: string;
  return_town_from_inc: string;
  return_town_to_inc: string;
  return_port_to_inc: string;
  price_sync_interval_minutes: string;
  schedule_sync_interval_minutes: string;
  typical_roundtrip_days: string;
};

const emptyRouteForm = {
  name: '',
  origin_city: '',
  destination_city: '',
  town_from_inc: '',
  town_to_inc: '',
  port_to_inc: '',
  return_town_from_inc: '',
  return_town_to_inc: '',
  return_port_to_inc: '',
  forward_schedule_source_url: '',
  return_schedule_source_url: '',
};

const PRICE_INTERVAL_PRESETS = [
  { label: '30 хв', minutes: 30 },
  { label: '1 год', minutes: 60 },
  { label: '3 год', minutes: 180 },
  { label: '6 год', minutes: 360 },
  { label: '12 год', minutes: 720 },
];

const SCHEDULE_INTERVAL_PRESETS = [
  { label: '1 день', minutes: 1440 },
  { label: '3 дні', minutes: 4320 },
  { label: '1 тиждень', minutes: 10080 },
  { label: '1 місяць', minutes: 43200 },
];

// TEMPORARY: login requirement disabled for the parser log page. Set back to true
// to require manager login again.
const REQUIRE_LOGIN = false;

const draftFromRoute = (route: AlfRoute): RouteDraft => ({
  forward_schedule_source_url: route.forward_schedule_source_url ?? '',
  return_schedule_source_url: route.return_schedule_source_url ?? '',
  return_town_from_inc: route.return_town_from_inc ?? '',
  return_town_to_inc: route.return_town_to_inc ?? '',
  return_port_to_inc: route.return_port_to_inc ?? '',
  price_sync_interval_minutes: String(route.price_sync_interval_minutes),
  schedule_sync_interval_minutes: String(route.schedule_sync_interval_minutes),
  typical_roundtrip_days: String(route.typical_roundtrip_days),
});

const formatMinutes = (minutes: number): string => {
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} год.`;
  return `${minutes} хв.`;
};

const formatRelativeTime = (iso: string | null): string => {
  if (!iso) return 'ще не запускався';
  return new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
};

// logRoundtripDirection (sync-alf) stores route_name as e.g. "Київ → Вльора →
// Київ (туди-назад)" — this strips it down to a clean "Київ ⇄ Вльора" title for
// the journal card header.
const formatRoundtripTitle = (routeName: string | null): string => {
  if (!routeName) return 'Невідомий маршрут';
  const match = routeName.match(/^(.+?) → (.+?) → \1 \(туди-назад\)$/);
  return match ? `${match[1]} ⇄ ${match[2]}` : routeName;
};

const ParserData = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [routes, setRoutes] = useState<AlfRoute[]>([]);
  const [stopsByRouteDirection, setStopsByRouteDirection] = useState<Record<string, RouteStop[]>>({});
  const [routeFilter, setRouteFilter] = useState<'all' | string>('all');
  const [syncTypeFilter, setSyncTypeFilter] = useState<'all' | 'prices' | 'schedule' | 'roundtrip'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [expandedStops, setExpandedStops] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RouteDraft>>({});
  const [savingRouteId, setSavingRouteId] = useState<string | null>(null);
  const [syncingRouteTask, setSyncingRouteTask] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ routeId: string; task: 'prices' | 'schedule'; elapsedSeconds: number; seenDirections: Direction[] } | null>(null);
  const [showAddRoute, setShowAddRoute] = useState(false);
  const [newRoute, setNewRoute] = useState(emptyRouteForm);
  const [savingNewRoute, setSavingNewRoute] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const loadRuns = async () => {
    const { data } = await supabase.from('alf_sync_runs').select('*').order('run_at', { ascending: false }).limit(60);
    setRuns((data ?? []) as SyncRun[]);
  };

  const loadRoutes = async () => {
    const { data } = await supabase.from('alf_routes').select('*').order('sort_order', { ascending: true });
    const routeRows = (data ?? []) as AlfRoute[];
    setRoutes(routeRows);
    setDrafts(Object.fromEntries(routeRows.map((route) => [route.id, draftFromRoute(route)])));

    const { data: stopRows } = await supabase.from('alf_route_stops').select('*').order('sort_order', { ascending: true });
    const grouped: Record<string, RouteStop[]> = {};
    for (const stop of (stopRows ?? []) as RouteStop[]) {
      const key = `${stop.route_id}:${stop.direction}`;
      grouped[key] = grouped[key] ?? [];
      grouped[key].push(stop);
    }
    setStopsByRouteDirection(grouped);
  };

  useEffect(() => {
    if (!session && REQUIRE_LOGIN) return;
    void loadRuns();
    void loadRoutes();
  }, [session]);

  const filteredRuns = useMemo(
    () =>
      runs.filter(
        (run) => (routeFilter === 'all' || run.route_id === routeFilter) && (syncTypeFilter === 'all' || run.sync_type === syncTypeFilter),
      ),
    [runs, routeFilter, syncTypeFilter],
  );

  const routeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const run of runs) {
      const key = run.route_id ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [runs]);

  const updateDraft = (routeId: string, patch: Partial<RouteDraft>) => setDrafts((current) => ({ ...current, [routeId]: { ...current[routeId], ...patch } }));

  const saveRouteSettings = async (route: AlfRoute) => {
    const draft = drafts[route.id];
    if (!draft) return;
    setSavingRouteId(route.id);
    const { error } = await supabase
      .from('alf_routes')
      .update({
        forward_schedule_source_url: draft.forward_schedule_source_url || null,
        return_schedule_source_url: draft.return_schedule_source_url || null,
        return_town_from_inc: draft.return_town_from_inc || null,
        return_town_to_inc: draft.return_town_to_inc || null,
        return_port_to_inc: draft.return_port_to_inc || null,
        price_sync_interval_minutes: Math.max(5, Number(draft.price_sync_interval_minutes) || route.price_sync_interval_minutes),
        schedule_sync_interval_minutes: Math.max(60, Number(draft.schedule_sync_interval_minutes) || route.schedule_sync_interval_minutes),
        typical_roundtrip_days: Math.max(1, Number(draft.typical_roundtrip_days) || route.typical_roundtrip_days),
        updated_at: new Date().toISOString(),
      })
      .eq('id', route.id);
    setSavingRouteId(null);
    if (error) {
      alert(`Не вдалося зберегти налаштування: ${error.message}`);
      return;
    }
    await loadRoutes();
  };

  const toggleRouteActive = async (route: AlfRoute) => {
    const { error } = await supabase.from('alf_routes').update({ is_active: !route.is_active, updated_at: new Date().toISOString() }).eq('id', route.id);
    if (error) {
      alert(`Не вдалося змінити статус маршруту: ${error.message}`);
      return;
    }
    await loadRoutes();
  };

  const deleteRoute = async (route: AlfRoute) => {
    if (!confirm(`Видалити маршрут «${route.name}» разом з його розкладом та кешем цін?`)) return;
    const { error } = await supabase.from('alf_routes').delete().eq('id', route.id);
    if (error) {
      alert(`Не вдалося видалити маршрут: ${error.message}`);
      return;
    }
    if (routeFilter === route.id) setRouteFilter('all');
    await Promise.all([loadRoutes(), loadRuns()]);
  };

  const runTask = async (route: AlfRoute, task: 'prices' | 'schedule') => {
    const key = `${route.id}:${task}`;
    const startedAt = new Date().toISOString();
    setSyncingRouteTask(key);
    setSyncProgress({ routeId: route.id, task, elapsedSeconds: 0, seenDirections: [] });

    // Each direction writes its own alf_sync_runs row as soon as it finishes, well
    // before the whole request resolves — polling lets the UI show real progress
    // ("туди готово, обробляємо назад…") instead of a plain frozen spinner.
    const elapsedTimer = window.setInterval(() => {
      setSyncProgress((current) => (current ? { ...current, elapsedSeconds: current.elapsedSeconds + 1 } : current));
    }, 1000);
    const pollTimer = window.setInterval(async () => {
      const { data: seenRuns } = await supabase
        .from('alf_sync_runs')
        .select('direction')
        .eq('route_id', route.id)
        .eq('sync_type', task)
        .gte('run_at', startedAt);
      const seenDirections = [...new Set((seenRuns ?? []).map((r) => r.direction as Direction))];
      setSyncProgress((current) => (current ? { ...current, seenDirections } : current));
    }, 1500);

    // Explicitly force the project's public key as the auth header instead of
    // relying on supabase-js's default session-derived Authorization header — a
    // stale/expired auth session in this browser (e.g. from a previous admin login
    // attempt) was causing the Edge Function gateway to reject the call with 401
    // before the function code ever ran.
    const { data, error } = await supabase.functions.invoke('sync-alf', {
      body: { routeId: route.id, task, force: true },
      headers: { Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` },
    });

    window.clearInterval(elapsedTimer);
    window.clearInterval(pollTimer);
    setSyncProgress(null);
    setSyncingRouteTask(null);

    if (error) {
      alert(`Синхронізація не завершилась: ${error.message}`);
      return;
    }
    const summary = data?.routes?.[0];
    if (task === 'prices') {
      const parts = (summary?.priceResults ?? []).map((r: { direction: Direction; toursUpdated: number }) => `${r.direction === 'forward' ? 'туди' : 'назад'}: ${r.toursUpdated} дат`);
      alert(`«${route.name}» — ціни оновлено: ${parts.join(', ') || 'без даних'}.`);
    } else {
      const parts = (summary?.scheduleResults ?? []).map(
        (r: { direction: Direction; status: string; stopsFound: number; parseError: string | null }) =>
          `${r.direction === 'forward' ? 'туди' : 'назад'}: ${r.status === 'ok' || r.status === 'warning' ? `${r.stopsFound} зупинок${r.status === 'warning' ? ' (потребує перевірки)' : ''}` : r.status === 'error' ? `помилка — ${r.parseError}` : 'посилання не задане'}`,
      );
      alert(`«${route.name}» — розклад оновлено: ${parts.join('; ') || 'без даних'}.`);
    }
    await Promise.all([loadRuns(), loadRoutes()]);
  };

  const createRoute = async () => {
    if (!newRoute.name || !newRoute.origin_city || !newRoute.destination_city || !newRoute.town_from_inc || !newRoute.town_to_inc || !newRoute.port_to_inc) {
      alert('Заповніть назву, міста та ALF-ідентифікатори маршруту "туди" (TOWNFROMINC/TOWNTOINC/PORTTOINC).');
      return;
    }
    setSavingNewRoute(true);
    const slug = newRoute.name.toLowerCase().trim().replace(/[^a-zа-яїієґ0-9]+/gi, '-').replace(/^-+|-+$/g, '') || `route-${Date.now()}`;
    const { error } = await supabase.from('alf_routes').insert({
      slug,
      name: newRoute.name,
      origin_city: newRoute.origin_city,
      destination_city: newRoute.destination_city,
      town_from_inc: newRoute.town_from_inc,
      town_to_inc: newRoute.town_to_inc,
      port_to_inc: newRoute.port_to_inc,
      return_town_from_inc: newRoute.return_town_from_inc || null,
      return_town_to_inc: newRoute.return_town_to_inc || null,
      return_port_to_inc: newRoute.return_port_to_inc || null,
      route_class_text: `${newRoute.origin_city}-${newRoute.destination_city} (Автобус (econom))`,
      forward_schedule_source_url: newRoute.forward_schedule_source_url || null,
      return_schedule_source_url: newRoute.return_schedule_source_url || null,
      sort_order: routes.length,
    });
    setSavingNewRoute(false);
    if (error) {
      alert(`Не вдалося створити маршрут: ${error.message}`);
      return;
    }
    setNewRoute(emptyRouteForm);
    setShowAddRoute(false);
    await loadRoutes();
  };

  if (REQUIRE_LOGIN && authLoading) return <div className="flex min-h-screen items-center justify-center bg-[#f8f6f1] text-[#147d92]"><RefreshCw className="animate-spin" /></div>;

  if (REQUIRE_LOGIN && !session) {
    return (
      <div className="min-h-screen bg-[#f8f6f1] px-5 py-8 text-[#123b4a]">
        <div className="mx-auto max-w-md">
          <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-bold text-[#147d92] hover:text-[#0d6577]"><ArrowLeft size={16} /> До кабінету агенції</Link>
          <div className="mt-8 rounded-[26px] border border-[#dce9e3] bg-white p-6"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#e8f3f1] text-[#147d92]"><ShieldCheck /></div><h1 className="mt-4 font-display text-2xl font-semibold">Дані парсера — лише для менеджерів</h1><p className="mt-2 text-sm text-[#718484]">Увійдіть, щоб переглянути журнал синхронізації воркера ALF.</p><div className="admin-auth mt-6"><Auth supabaseClient={supabase} providers={[]} view="sign_in" theme="light" appearance={{ theme: ThemeSupa }} /></div></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f8f6f1] text-[#123b4a]">
      <header className="border-b border-[#e2edf1] bg-white">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-4 px-5 py-5 lg:px-8">
          <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-bold text-[#147d92] hover:text-[#0d6577]"><ArrowLeft size={16} /> До кабінету агенції</Link>
          <div className="text-right"><p className="text-xs font-bold uppercase tracking-[.16em] text-[#147d92]">ALF worker log</p><p className="mt-1 text-xs text-[#8ba09f]">Останні {runs.length} запусків синхронізації</p></div>
        </div>
      </header>

      <main className="mx-auto max-w-[1240px] px-5 py-8 lg:px-8 lg:py-12">
        <p className="text-xs font-bold uppercase tracking-[.18em] text-[#147d92]">Журнал воркера</p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-[-.05em] sm:text-5xl">Дані фонового парсера</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#718484]">Ціни/місця та розклад руху синхронізуються окремо, зі своїми інтервалами, для кожного напрямку (туди / назад) кожного маршруту.</p>

        {/* Route registry & schedule source management */}
        <section className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-display text-2xl font-semibold"><RouteIcon size={20} className="text-[#147d92]" /> Маршрути</h2>
            <button onClick={() => setShowAddRoute((v) => !v)} className="flex items-center gap-2 rounded-xl bg-[#147d92] px-3 py-2 text-xs font-bold text-white hover:bg-[#0d6577]"><Plus size={15} /> Додати маршрут</button>
          </div>

          {showAddRoute && (
            <div className="mt-4 grid gap-3 rounded-[22px] border border-[#dce9e3] bg-white p-5 sm:grid-cols-2">
              <input value={newRoute.name} onChange={(e) => setNewRoute({ ...newRoute, name: e.target.value })} placeholder="Назва маршруту (напр. Київ → Тирана)" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92] sm:col-span-2" />
              <input value={newRoute.origin_city} onChange={(e) => setNewRoute({ ...newRoute, origin_city: e.target.value })} placeholder="Місто відправлення" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
              <input value={newRoute.destination_city} onChange={(e) => setNewRoute({ ...newRoute, destination_city: e.target.value })} placeholder="Місто прибуття" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />

              <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f] sm:col-span-2">Напрямок «туди»</p>
              <input value={newRoute.town_from_inc} onChange={(e) => setNewRoute({ ...newRoute, town_from_inc: e.target.value })} placeholder="TOWNFROMINC" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
              <input value={newRoute.town_to_inc} onChange={(e) => setNewRoute({ ...newRoute, town_to_inc: e.target.value })} placeholder="TOWNTOINC" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
              <input value={newRoute.port_to_inc} onChange={(e) => setNewRoute({ ...newRoute, port_to_inc: e.target.value })} placeholder="PORTTOINC" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92] sm:col-span-2" />
              <input value={newRoute.forward_schedule_source_url} onChange={(e) => setNewRoute({ ...newRoute, forward_schedule_source_url: e.target.value })} placeholder="Посилання на графік руху «туди»" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92] sm:col-span-2" />

              <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f] sm:col-span-2">Напрямок «назад» (необов'язково — на ALF може мати інші ID/сторінку)</p>
              <input value={newRoute.return_town_from_inc} onChange={(e) => setNewRoute({ ...newRoute, return_town_from_inc: e.target.value })} placeholder="TOWNFROMINC (назад)" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
              <input value={newRoute.return_town_to_inc} onChange={(e) => setNewRoute({ ...newRoute, return_town_to_inc: e.target.value })} placeholder="TOWNTOINC (назад)" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
              <input value={newRoute.return_port_to_inc} onChange={(e) => setNewRoute({ ...newRoute, return_port_to_inc: e.target.value })} placeholder="PORTTOINC (назад)" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92] sm:col-span-2" />
              <input value={newRoute.return_schedule_source_url} onChange={(e) => setNewRoute({ ...newRoute, return_schedule_source_url: e.target.value })} placeholder="Посилання на графік руху «назад»" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92] sm:col-span-2" />

              <p className="text-xs leading-5 text-[#8ba09f] sm:col-span-2">TOWNFROMINC/TOWNTOINC/PORTTOINC — числові ідентифікатори міст на online.alf.ua/tickets. Якщо для зворотного напрямку їх не вказати, синхронізація цін «назад» просто не запускатиметься.</p>
              <div className="flex gap-2 sm:col-span-2">
                <button onClick={createRoute} disabled={savingNewRoute} className="rounded-xl bg-[#147d92] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#0d6577] disabled:opacity-60">{savingNewRoute ? 'Зберігаємо…' : 'Створити маршрут'}</button>
                <button onClick={() => { setShowAddRoute(false); setNewRoute(emptyRouteForm); }} className="rounded-xl bg-[#f4f7f4] px-4 py-2.5 text-sm font-bold text-[#718484]">Скасувати</button>
              </div>
            </div>
          )}

          <div className="mt-4 grid gap-3">
            {routes.length === 0 && <div className="rounded-[22px] border border-dashed border-[#c7dcd5] bg-white p-8 text-center text-sm text-[#718484]">Маршрутів ще немає. Додайте перший вище.</div>}
            {routes.map((route) => {
              const draft = drafts[route.id];
              const forwardStops = stopsByRouteDirection[`${route.id}:forward`] ?? [];
              const returnStops = stopsByRouteDirection[`${route.id}:return`] ?? [];
              const hasReturnIds = Boolean(route.return_town_from_inc && route.return_town_to_inc && route.return_port_to_inc);
              return (
                <article key={route.id} className="rounded-[22px] border border-[#dce9e3] bg-white p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <strong className="text-lg text-[#123b4a]">{route.name}</strong>
                        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] ${route.is_active ? 'bg-[#ddf2e8] text-[#1c7a52]' : 'bg-[#f4f7f4] text-[#8ba09f]'}`}>{route.is_active ? 'активний' : 'вимкнено'}</span>
                        {!hasReturnIds && <span className="rounded-full bg-[#fff1d9] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#a86c25]">немає ID для «назад»</span>}
                      </div>
                      <p className="mt-1 text-xs text-[#8ba09f]">{route.origin_city} → {route.destination_city} · синхронізацій у журналі: {routeCounts[route.id] ?? 0}</p>
                      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#8ba09f]">
                        <span className="flex items-center gap-1"><Clock3 size={12} /> ціни: кожні {formatMinutes(route.price_sync_interval_minutes)}, востаннє — {formatRelativeTime(route.last_price_sync_at)}</span>
                        <span className="flex items-center gap-1"><Clock3 size={12} /> розклад: кожні {formatMinutes(route.schedule_sync_interval_minutes)}, востаннє — {formatRelativeTime(route.last_schedule_sync_at)}</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => runTask(route, 'prices')} disabled={syncingRouteTask === `${route.id}:prices`} className="flex items-center gap-1.5 rounded-xl bg-[#e8f3f1] px-3 py-2 text-xs font-bold text-[#147d92] hover:bg-[#d9ecec] disabled:opacity-60"><RefreshCw size={13} className={syncingRouteTask === `${route.id}:prices` ? 'animate-spin' : ''} /> Ціни зараз</button>
                      <button onClick={() => runTask(route, 'schedule')} disabled={syncingRouteTask === `${route.id}:schedule`} className="flex items-center gap-1.5 rounded-xl bg-[#e8f3f1] px-3 py-2 text-xs font-bold text-[#147d92] hover:bg-[#d9ecec] disabled:opacity-60"><RefreshCw size={13} className={syncingRouteTask === `${route.id}:schedule` ? 'animate-spin' : ''} /> Розклад зараз</button>
                      <button onClick={() => setExpandedStops(expandedStops === route.id ? null : route.id)} className="flex items-center gap-1.5 rounded-xl bg-[#f4f7f4] px-3 py-2 text-xs font-bold text-[#718484] hover:bg-[#e8f3f1]"><ListTree size={13} /> Зупинки</button>
                      <button onClick={() => toggleRouteActive(route)} className="rounded-xl bg-[#f4f7f4] px-3 py-2 text-xs font-bold text-[#718484] hover:bg-[#e8f3f1]">{route.is_active ? 'Вимкнути' : 'Увімкнути'}</button>
                      <button onClick={() => deleteRoute(route)} className="flex items-center gap-1.5 rounded-xl bg-[#f9e6e1] px-3 py-2 text-xs font-bold text-[#ba634c] hover:bg-[#f5d5cd]"><Trash2 size={13} /></button>
                    </div>
                  </div>

                  {syncProgress && syncProgress.routeId === route.id && (
                    <div className="mt-4 rounded-2xl border border-[#d7e5ea] bg-[#eef7fa] px-4 py-3">
                      <p className="flex items-center gap-2 text-xs font-bold text-[#147d92]"><RefreshCw size={13} className="animate-spin" /> {syncProgress.task === 'prices' ? 'Синхронізуємо ціни/місця…' : 'Парсимо розклад руху…'} ({syncProgress.elapsedSeconds} с)</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold">
                        <span className={`rounded-full px-2.5 py-1 ${syncProgress.seenDirections.includes('forward') ? 'bg-[#ddf2e8] text-[#1c7a52]' : 'bg-white text-[#8ba09f]'}`}>{syncProgress.seenDirections.includes('forward') ? '✓' : '⏳'} туди</span>
                        {(route.return_town_from_inc || syncProgress.task === 'schedule') && <span className={`rounded-full px-2.5 py-1 ${syncProgress.seenDirections.includes('return') ? 'bg-[#ddf2e8] text-[#1c7a52]' : 'bg-white text-[#8ba09f]'}`}>{syncProgress.seenDirections.includes('return') ? '✓' : '⏳'} назад</span>}
                      </div>
                    </div>
                  )}

                  {draft && (
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <div className="rounded-2xl border border-[#edf2ef] p-4">
                        <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f]">Розклад — туди</p>
                        <input value={draft.forward_schedule_source_url} onChange={(e) => updateDraft(route.id, { forward_schedule_source_url: e.target.value })} placeholder="Посилання на графік руху «туди»" className="mt-2 w-full rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
                      </div>
                      <div className="rounded-2xl border border-[#edf2ef] p-4">
                        <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f]">Розклад — назад</p>
                        <input value={draft.return_schedule_source_url} onChange={(e) => updateDraft(route.id, { return_schedule_source_url: e.target.value })} placeholder="Посилання на графік руху «назад» (якщо відрізняється)" className="mt-2 w-full rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
                      </div>

                      <div className="rounded-2xl border border-[#edf2ef] p-4 sm:col-span-2">
                        <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f]">ALF-ідентифікатори «назад» (для пошуку цін)</p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-3">
                          <input value={draft.return_town_from_inc} onChange={(e) => updateDraft(route.id, { return_town_from_inc: e.target.value })} placeholder="TOWNFROMINC" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
                          <input value={draft.return_town_to_inc} onChange={(e) => updateDraft(route.id, { return_town_to_inc: e.target.value })} placeholder="TOWNTOINC" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
                          <input value={draft.return_port_to_inc} onChange={(e) => updateDraft(route.id, { return_port_to_inc: e.target.value })} placeholder="PORTTOINC" className="rounded-xl border border-[#d4e5e1] px-3 py-2.5 text-sm outline-none focus:border-[#147d92]" />
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[#edf2ef] p-4">
                        <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f]">Автопарсинг цін/місць кожні</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {PRICE_INTERVAL_PRESETS.map((preset) => (
                            <button key={preset.minutes} onClick={() => updateDraft(route.id, { price_sync_interval_minutes: String(preset.minutes) })} className={`rounded-full px-2.5 py-1 text-xs font-bold ${Number(draft.price_sync_interval_minutes) === preset.minutes ? 'bg-[#123b4a] text-white' : 'bg-[#f4f7f4] text-[#718484] hover:bg-[#e8f3f1]'}`}>{preset.label}</button>
                          ))}
                        </div>
                        <input type="number" min={5} value={draft.price_sync_interval_minutes} onChange={(e) => updateDraft(route.id, { price_sync_interval_minutes: e.target.value })} className="mt-2 w-full rounded-xl border border-[#d4e5e1] px-3 py-2 text-sm outline-none focus:border-[#147d92]" />
                        <p className="mt-1 text-[11px] text-[#8ba09f]">хвилин (мінімум 5)</p>
                      </div>
                      <div className="rounded-2xl border border-[#edf2ef] p-4">
                        <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f]">Типова тривалість туру «туди-назад» (днів)</p>
                        <input type="number" min={1} value={draft.typical_roundtrip_days} onChange={(e) => updateDraft(route.id, { typical_roundtrip_days: e.target.value })} className="mt-2 w-full rounded-xl border border-[#d4e5e1] px-3 py-2 text-sm outline-none focus:border-[#147d92]" />
                        <p className="mt-1 text-[11px] text-[#8ba09f]">Парсер вмикає чекбокс «туди і назад» на сайті ALF та підбирає найближчу до цієї кількості днів дату повернення, яку сайт ALF реально підтримує для комбінованої ціни.</p>
                      </div>
                      <div className="rounded-2xl border border-[#edf2ef] p-4">
                        <p className="text-xs font-bold uppercase tracking-[.1em] text-[#8ba09f]">Автопарсинг розкладу кожні</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {SCHEDULE_INTERVAL_PRESETS.map((preset) => (
                            <button key={preset.minutes} onClick={() => updateDraft(route.id, { schedule_sync_interval_minutes: String(preset.minutes) })} className={`rounded-full px-2.5 py-1 text-xs font-bold ${Number(draft.schedule_sync_interval_minutes) === preset.minutes ? 'bg-[#123b4a] text-white' : 'bg-[#f4f7f4] text-[#718484] hover:bg-[#e8f3f1]'}`}>{preset.label}</button>
                          ))}
                        </div>
                        <input type="number" min={60} value={draft.schedule_sync_interval_minutes} onChange={(e) => updateDraft(route.id, { schedule_sync_interval_minutes: e.target.value })} className="mt-2 w-full rounded-xl border border-[#d4e5e1] px-3 py-2 text-sm outline-none focus:border-[#147d92]" />
                        <p className="mt-1 text-[11px] text-[#8ba09f]">хвилин (мінімум 60) — розклад міняється рідко, тож інтервал може бути значно довшим за ціни</p>
                      </div>

                      <div className="sm:col-span-2">
                        <button onClick={() => saveRouteSettings(route)} disabled={savingRouteId === route.id} className="rounded-xl bg-[#123b4a] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#0a2833] disabled:opacity-60">{savingRouteId === route.id ? 'Зберігаємо…' : 'Зберегти налаштування маршруту'}</button>
                      </div>
                    </div>
                  )}

                  {expandedStops === route.id && (
                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <StopsTable title="Зупинки — туди" stops={forwardStops} />
                      <StopsTable title="Зупинки — назад" stops={returnStops} />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {/* Worker run log, broken down by route, direction & sync type */}
        <section className="mt-12">
          <h2 className="font-display text-2xl font-semibold">Журнал запусків</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => setSyncTypeFilter('all')} className={`rounded-full px-3 py-1.5 text-xs font-bold ${syncTypeFilter === 'all' ? 'bg-[#123b4a] text-white' : 'bg-white text-[#718484] hover:bg-[#e8f3f1]'}`}>Усе</button>
            <button onClick={() => setSyncTypeFilter('prices')} className={`rounded-full px-3 py-1.5 text-xs font-bold ${syncTypeFilter === 'prices' ? 'bg-[#123b4a] text-white' : 'bg-white text-[#718484] hover:bg-[#e8f3f1]'}`}>Тільки ціни</button>
            <button onClick={() => setSyncTypeFilter('schedule')} className={`rounded-full px-3 py-1.5 text-xs font-bold ${syncTypeFilter === 'schedule' ? 'bg-[#123b4a] text-white' : 'bg-white text-[#718484] hover:bg-[#e8f3f1]'}`}>Тільки розклад</button>
            <button onClick={() => setSyncTypeFilter('roundtrip')} className={`rounded-full px-3 py-1.5 text-xs font-bold ${syncTypeFilter === 'roundtrip' ? 'bg-[#123b4a] text-white' : 'bg-white text-[#718484] hover:bg-[#e8f3f1]'}`}>Тільки туди-назад</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => setRouteFilter('all')} className={`rounded-full px-3 py-1.5 text-xs font-bold ${routeFilter === 'all' ? 'bg-[#123b4a] text-white' : 'bg-white text-[#718484] hover:bg-[#e8f3f1]'}`}>Усі маршрути <span className="ml-1 opacity-60">{runs.length}</span></button>
            {routes.map((route) => (
              <button key={route.id} onClick={() => setRouteFilter(route.id)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${routeFilter === route.id ? 'bg-[#123b4a] text-white' : 'bg-white text-[#718484] hover:bg-[#e8f3f1]'}`}>{route.name} <span className="ml-1 opacity-60">{routeCounts[route.id] ?? 0}</span></button>
            ))}
          </div>

          {filteredRuns.length === 0 ? (
            <div className="mt-6 rounded-[30px] border border-dashed border-[#c7dcd5] bg-white p-12 text-center"><FileSearch className="mx-auto text-[#147d92]" size={30} /><p className="mt-4 text-sm font-semibold text-[#718484]">Синхронізацій ще не було. Натисніть «Ціни зараз» або «Розклад зараз» біля потрібного маршруту.</p></div>
          ) : (
            <div className="mt-6 grid gap-4">
              {filteredRuns.map((run) => (
                <article key={run.id} className="overflow-hidden rounded-[26px] border border-[#dce9e3] bg-white">
                  <button onClick={() => setExpanded(expanded === run.id ? null : run.id)} className="flex w-full flex-col gap-3 p-5 text-left hover:bg-[#fbfcfa] sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="flex flex-wrap items-center gap-2 font-display text-lg font-semibold">
                        {run.sync_type === 'roundtrip' ? formatRoundtripTitle(run.route_name) : run.route_name ?? 'Невідомий маршрут'}
                        <span className="rounded-full bg-[#f4f7f4] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.06em] text-[#718484]">{run.direction === 'forward' ? 'туди' : 'назад'}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.06em] ${run.sync_type === 'prices' ? 'bg-[#e8f3f1] text-[#147d92]' : run.sync_type === 'roundtrip' ? 'bg-[#e6ecf7] text-[#3a4f9c]' : 'bg-[#f3eee5] text-[#8a6d43]'}`}>{run.sync_type === 'prices' ? 'ціни' : run.sync_type === 'roundtrip' ? 'туди-назад' : 'розклад'}</span>
                        <span className="text-xs font-normal text-[#8ba09f]">{new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.run_at))}</span>
                      </p>
                      {run.sync_type === 'schedule' ? (
                        <p className="mt-1 text-xs text-[#8ba09f]">{run.schedule_source_url || 'посилання не задане'} · {run.schedule_parse_status === 'ok' ? `${run.schedule_stops_found} зупинок` : run.schedule_parse_status === 'warning' ? `${run.schedule_stops_found} зупинок (потребує перевірки)` : run.schedule_parse_status === 'error' ? 'помилка парсингу' : 'пропущено'}</p>
                      ) : run.sync_type === 'roundtrip' ? (
                        <p className="mt-1 text-xs text-[#8ba09f]">Комбо-ціни туди-назад · валідних дат повернення знайдено: {run.calendar_dates_found}</p>
                      ) : (
                        <p className="mt-1 text-xs text-[#8ba09f]">Джерело дат: {run.calendar_source === 'calendar' ? 'календар ALF' : 'резервний щотижневий розклад'} · знайдено {run.calendar_dates_found} дат</p>
                      )}
                    </div>
                    {run.sync_type === 'schedule' ? (
                      <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${run.schedule_parse_status === 'ok' ? 'bg-[#ddf2e8] text-[#1c7a52]' : run.schedule_parse_status === 'warning' ? 'bg-[#fff1d9] text-[#a86c25]' : run.schedule_parse_status === 'error' ? 'bg-[#f9e6e1] text-[#ba634c]' : 'bg-[#f4f7f4] text-[#8ba09f]'}`}>{run.schedule_parse_status ?? 'skipped'}</span>
                    ) : (
                      <div className="flex flex-wrap gap-2 text-xs font-bold"><span className="rounded-full bg-[#ddf2e8] px-3 py-1.5 text-[#1c7a52]">Є місця: {run.available_count}</span><span className="rounded-full bg-[#fff1d9] px-3 py-1.5 text-[#a86c25]">Мало: {run.few_count}</span><span className="rounded-full bg-[#f9e6e1] px-3 py-1.5 text-[#ba634c]">Розпродано: {run.sold_out_count}</span><span className="rounded-full bg-[#e8f3f1] px-3 py-1.5 text-[#147d92]">Помилки: {run.error_count}</span></div>
                    )}
                  </button>
                  {expanded === run.id && (
                    <div className="border-t border-[#edf2ef] bg-[#fbfcfa] p-5 sm:p-7">
                      {run.fatal_error && <><p className="detail-label text-[#ba634c]">Критична помилка запуску</p><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-2xl bg-[#f9e6e1] p-4 text-xs leading-6 text-[#ba634c]">{run.fatal_error}</pre></>}

                      {run.sync_type === 'schedule' ? (
                        <>
                          {run.schedule_parse_status === 'error' && <pre className="mt-2 whitespace-pre-wrap rounded-2xl bg-[#f9e6e1] p-4 text-xs leading-6 text-[#ba634c]">{run.schedule_parse_error}</pre>}
                          {run.schedule_parse_status === 'warning' && <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-[#fff1d9] p-4 text-xs leading-6 text-[#a86c25]">{run.schedule_parse_error}</p>}
                          {run.schedule_parse_status === 'ok' && <p className="mt-2 text-xs text-[#1c7a52]">Успішно оновлено {run.schedule_stops_found} зупинок.</p>}
                          {run.schedule_snippet && <><p className="detail-label mt-4">Фрагмент сторінки розкладу</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-xs leading-6 text-[#63777b]">{run.schedule_snippet}</pre></>}
                        </>
                      ) : (
                        <>
                          <p className="detail-label mt-1">Опрацьовані дати</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">{run.active_dates.map((date) => <span key={date} className="rounded-lg bg-white px-2 py-1 text-xs text-[#315b62] shadow-sm">{date}</span>)}</div>
                          <p className="detail-label mt-5">Результати по кожній даті (натисніть, щоб побачити відповідь ALF)</p>
                          <div className="mt-2 grid gap-2">
                            {run.results_debug.map((item, index) => {
                              // A single departure date can now have SEVERAL distinct
                              // priced combos (one per valid return date), so the date
                              // alone is no longer a unique key/expand-toggle id.
                              const rowKey = `${item.date}__${item.returnDate ?? 'none'}__${index}`;
                              return (
                              <div key={rowKey} className="rounded-2xl border border-[#e2ebe7] bg-white">
                                <button onClick={() => setExpandedDate(expandedDate === rowKey ? null : rowKey)} className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left text-xs font-semibold">
                                  <span className="text-[#315b62]">{item.returnDate ? `${item.date} → ${item.returnDate}` : item.date}</span>
                                  <span className={`rounded-full px-2 py-1 ${item.status === 'available' || item.status === 'priced' ? 'bg-[#ddf2e8] text-[#1c7a52]' : item.status === 'few' ? 'bg-[#fff1d9] text-[#a86c25]' : item.status === 'sold_out' ? 'bg-[#f9e6e1] text-[#ba634c]' : 'bg-[#e8f3f1] text-[#147d92]'}`}>{item.status}</span>
                                  <span className="text-[#8ba09f]">{item.price !== null ? `${item.price} грн` : 'без ціни'}</span>
                                  {item.error && <span className="text-[#ba634c]">{item.error}</span>}
                                </button>
                                {expandedDate === rowKey && (
                                  <div className="border-t border-[#edf2ef] p-3">
                                    <p className="detail-label">POST тіло запиту</p>
                                    <pre className="mt-2 overflow-auto rounded-xl bg-[#fbfcfa] p-3 text-xs leading-6 text-[#63777b]">{JSON.stringify(item.requestBody, null, 2)}</pre>
                                    <p className="detail-label mt-3">Текст відповіді ALF</p>
                                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-[#fbfcfa] p-3 text-xs leading-6 text-[#63777b]">{item.responseSnippet || 'Порожня відповідь'}</pre>
                                  </div>
                                )}
                              </div>
                              );
                            })}
                          </div>
                          {run.errors.length > 0 && <><p className="detail-label mt-5">Помилки</p><ul className="mt-2 space-y-1 text-xs text-[#ba634c]">{run.errors.map((item, index) => <li key={index}>{item.date}: {item.error}</li>)}</ul></>}
                        </>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

const StopsTable = ({ title, stops }: { title: string; stops: RouteStop[] }) => (
  <div className="overflow-hidden rounded-xl border border-[#e2ebe7]">
    <p className="border-b border-[#e2ebe7] bg-[#fbfcfa] px-3 py-2 text-xs font-bold uppercase tracking-[.08em] text-[#8ba09f]">{title}</p>
    {stops.length === 0 ? (
      <p className="p-4 text-sm text-[#8ba09f]">Зупинок ще не спарсено. Натисніть «Розклад зараз» після збереження посилання.</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-[#fbfcfa] text-xs uppercase tracking-[.08em] text-[#8ba09f]"><tr><th className="px-3 py-2">#</th><th className="px-3 py-2">Місто</th><th className="px-3 py-2">Час відправлення</th><th className="px-3 py-2">Год.</th><th className="px-3 py-2">Адреса</th><th className="px-3 py-2">Гео</th></tr></thead>
          <tbody className="divide-y divide-[#edf2ef]">
            {stops.map((stop, index) => (
              <tr key={stop.id}>
                <td className="px-3 py-2 text-[#8ba09f]">{index + 1}</td>
                <td className="px-3 py-2 font-semibold text-[#315b62]">{stop.city}</td>
                <td className="px-3 py-2 font-semibold text-[#147d92]">{stop.clock_time ?? '—'}</td>
                <td className="px-3 py-2 text-[#718484]">{stop.hours_from_start}</td>
                <td className="px-3 py-2 text-[#718484]">{stop.note ?? '—'}</td>
                <td className="px-3 py-2">{stop.geo_link ? <a href={stop.geo_link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[#147d92] hover:underline"><MapPin size={13} /> мапа</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

export default ParserData;
