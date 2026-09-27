import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import type { Session } from '@supabase/supabase-js';
import { ArrowLeft, ChevronDown, CircleUserRound, LayoutDashboard, LogOut, RefreshCw, Search, ShieldCheck, Ticket, UsersRound } from 'lucide-react';
import { supabase, SUPABASE_PUBLISHABLE_KEY } from '@/integrations/supabase/client';
import { formatDate, formatPrice, statusLabels, type BookingStatus } from '@/lib/alf';

type Booking = {
  id: string;
  booking_reference: string;
  status: BookingStatus;
  origin: string;
  destination: string;
  departure_date: string;
  passenger_count: number;
  passengers: { fullName: string; type?: 'adult' | 'child'; age?: number }[];
  contact_name: string;
  phone: string;
  email: string;
  total_price: number;
};

type Customer = { id: string; full_name: string; phone: string; email: string; booking_count: number; last_booking_at: string };
type Tab = 'bookings' | 'customers';
type Filter = 'all' | BookingStatus;

// TEMPORARY: login requirement disabled for the agency dashboard. Set back to true
// (and re-enable the matching RLS policies check) to require manager login again.
const REQUIRE_LOGIN = false;

const Admin = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('bookings');
  const [statusFilter, setStatusFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncElapsedSeconds, setSyncElapsedSeconds] = useState(0);
  const [openBooking, setOpenBooking] = useState<string | null>(null);

  const loadDashboard = async () => {
    const [{ data: bookingRows }, { data: customerRows }] = await Promise.all([
      supabase.from('bookings').select('*').order('created_at', { ascending: false }),
      supabase.from('customers').select('*').order('last_booking_at', { ascending: false }),
    ]);
    setBookings((bookingRows ?? []) as Booking[]);
    setCustomers((customerRows ?? []) as Customer[]);
  };

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

  useEffect(() => {
    if (session || !REQUIRE_LOGIN) void loadDashboard();
  }, [session]);

  const counts = useMemo(() => ({
    all: bookings.length,
    new: bookings.filter((booking) => booking.status === 'new').length,
    in_progress: bookings.filter((booking) => booking.status === 'in_progress').length,
    confirmed: bookings.filter((booking) => booking.status === 'confirmed').length,
    cancelled: bookings.filter((booking) => booking.status === 'cancelled').length,
  }), [bookings]);

  const filteredBookings = useMemo(() => bookings.filter((booking) => {
    const statusMatches = statusFilter === 'all' || booking.status === statusFilter;
    const text = `${booking.contact_name} ${booking.phone} ${booking.booking_reference}`.toLowerCase();
    return statusMatches && text.includes(search.toLowerCase());
  }), [bookings, search, statusFilter]);

  const updateStatus = async (booking: Booking, status: BookingStatus) => {
    const { error } = await supabase.from('bookings').update({ status, updated_at: new Date().toISOString() }).eq('id', booking.id);
    if (error) return;

    if (status === 'confirmed') {
      const { data: existing } = await supabase.from('customers').select('id, booking_count').eq('phone', booking.phone).eq('email', booking.email).maybeSingle();
      if (existing) {
        await supabase.from('customers').update({ booking_count: existing.booking_count + 1, last_booking_at: new Date().toISOString(), full_name: booking.contact_name, updated_at: new Date().toISOString() }).eq('id', existing.id);
      } else {
        await supabase.from('customers').insert({ full_name: booking.contact_name, phone: booking.phone, email: booking.email });
      }
    }
    await loadDashboard();
  };

  const syncSchedules = async () => {
    setIsSyncing(true);
    setSyncElapsedSeconds(0);
    const timer = window.setInterval(() => setSyncElapsedSeconds((seconds) => seconds + 1), 1000);
    // Explicitly force the project's public key as the auth header instead of
    // relying on supabase-js's default session-derived Authorization header — a
    // stale/expired auth session in this browser can otherwise make the Edge
    // Function gateway reject the call with 401 before the function ever runs.
    const { data, error } = await supabase.functions.invoke('sync-alf', {
      body: { task: 'prices', force: true },
      headers: { Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` },
    });
    window.clearInterval(timer);
    setIsSyncing(false);
    if (error) {
      alert(`Оновлення цін не завершилось: ${error.message}. Деталі дивіться на сторінці «Дані парсера».`);
      return;
    }
    type PriceResult = { direction: 'forward' | 'return'; toursUpdated: number; available: number; few: number; soldOut: number; errors: number; fatalError: string | null };
    const routes = (data?.routes ?? []) as { routeName: string; priceResults: PriceResult[] }[];
    if (routes.length === 0) {
      alert('Немає активних маршрутів для синхронізації. Додайте маршрут на сторінці «Дані парсера».');
      return;
    }
    const summary = routes
      .map((route) => {
        const directions = route.priceResults
          .map((result) => `${result.direction === 'forward' ? 'туди' : 'назад'}: дат ${result.toursUpdated}, є місця ${result.available}, мало ${result.few}, розпродано ${result.soldOut}, помилок ${result.errors}${result.fatalError ? ` (критична помилка: ${result.fatalError})` : ''}`)
          .join('; ');
        return `«${route.routeName}»: ${directions || 'без даних'}`;
      })
      .join('\n');
    alert(`Кеш ALF оновлено по всіх маршрутах (ціни):\n${summary}\n\nДеталі на сторінці «Дані парсера».`);
  };

  if (REQUIRE_LOGIN && authLoading) return <LoadingState />;
  if (REQUIRE_LOGIN && !session) return <AdminLogin />;

  return (
    <div className="min-h-screen bg-[#f4f7f4] text-[#123b4a]">
      <header className="border-b border-[#dce9e3] bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 lg:px-8">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#147d92] text-white"><Ticket size={20} /></span>
            <span><strong className="block font-display text-lg leading-tight">Морський Шлях</strong><span className="text-[10px] font-bold uppercase tracking-[.18em] text-[#8ba09f]">кабінет агенції</span></span>
          </Link>
          <div className="flex items-center gap-3">
            {session ? (
              <>
                <span className="hidden items-center gap-2 rounded-full bg-[#e8f3f1] px-3 py-2 text-xs font-semibold text-[#147d92] sm:flex"><CircleUserRound size={15} /> {session.user.email}</span>
                <button onClick={() => supabase.auth.signOut()} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold text-[#718484] hover:bg-[#f4f7f4]"><LogOut size={16} /><span className="hidden sm:inline">Вийти</span></button>
              </>
            ) : (
              <span className="flex items-center gap-2 rounded-full bg-[#fff1d9] px-3 py-2 text-xs font-bold text-[#a86c25]"><ShieldCheck size={15} /> Тимчасовий режим без входу</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 py-8 lg:px-8">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-4"><Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-[#147d92]"><ArrowLeft size={16} /> До сайту</Link><Link to="/parser-data" className="inline-flex items-center gap-2 text-sm font-semibold text-[#147d92] hover:text-[#0d6577]">Дані парсера</Link></div>
            <p className="eyebrow">Операційна панель</p>
            <h1 className="section-title">Доброго дня, команда</h1>
            <p className="mt-2 text-sm text-[#718484]">Керуйте заявками, клієнтами та локальним кешем цін ALF.</p>
          </div>
          <button onClick={syncSchedules} disabled={isSyncing} className="flex items-center justify-center gap-2 rounded-2xl bg-[#147d92] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-[#147d92]/15 transition hover:bg-[#0d6577] disabled:opacity-60">
            <RefreshCw size={17} className={isSyncing ? 'animate-spin' : ''} />
            {isSyncing ? `Оновлюємо ціни… (${syncElapsedSeconds} с)` : 'Оновити ціни з Альф зараз'}
          </button>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Нові заявки" value={counts.new} hint="потребують уваги" accent="orange" />
          <StatCard label="В роботі" value={counts.in_progress} hint="опрацьовуються" accent="blue" />
          <StatCard label="Підтверджено" value={counts.confirmed} hint="у базі клієнтів" accent="green" />
          <StatCard label="Всього заявок" value={counts.all} hint="за весь час" accent="sand" />
        </div>

        <div className="mt-8 flex flex-col gap-4 rounded-[26px] border border-[#dce9e3] bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2">
            <TabButton active={activeTab === 'bookings'} onClick={() => setActiveTab('bookings')}><LayoutDashboard size={17} /> Заявки</TabButton>
            <TabButton active={activeTab === 'customers'} onClick={() => setActiveTab('customers')}><UsersRound size={17} /> Клієнти</TabButton>
          </div>
          {activeTab === 'bookings' && <label className="flex items-center gap-2 rounded-xl bg-[#f4f7f4] px-3 py-2 text-sm text-[#718484]"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Пошук заявки…" className="w-full bg-transparent outline-none placeholder:text-[#9badab] sm:w-52" /></label>}
        </div>

        {activeTab === 'bookings' ? (
          <section className="mt-4">
            <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
              {(['all', 'new', 'in_progress', 'confirmed', 'cancelled'] as const).map((status) => <button key={status} onClick={() => setStatusFilter(status)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold ${statusFilter === status ? 'bg-[#123b4a] text-white' : 'bg-white text-[#718484] hover:bg-[#e8f3f1]'}`}>{status === 'all' ? 'Усі заявки' : statusLabels[status]} <span className="ml-1 opacity-60">{counts[status]}</span></button>)}
            </div>
            <div className="grid gap-3">{filteredBookings.length === 0 ? <EmptyState text="Нових заявок поки немає" /> : filteredBookings.map((booking) => <BookingRow key={booking.id} booking={booking} open={openBooking === booking.id} onToggle={() => setOpenBooking(openBooking === booking.id ? null : booking.id)} onStatusChange={(status) => updateStatus(booking, status)} />)}</div>
          </section>
        ) : <CustomerTable customers={customers} />}
      </main>
    </div>
  );
};

const LoadingState = () => <div className="flex min-h-screen items-center justify-center bg-[#f8f6f1] text-[#147d92]"><RefreshCw className="animate-spin" /></div>;

const AdminLogin = () => (
  <div className="min-h-screen bg-[#f8f6f1] px-5 py-8">
    <div className="mx-auto flex max-w-5xl flex-col overflow-hidden rounded-[32px] bg-white shadow-[0_24px_80px_rgba(18,59,74,.12)] lg:min-h-[660px] lg:flex-row">
      <div className="relative flex flex-1 flex-col justify-between overflow-hidden bg-[#123b4a] p-8 text-white sm:p-12">
        <Link to="/" className="inline-flex items-center gap-2 text-sm font-bold text-white/80 hover:text-white"><ArrowLeft size={16} /> На головну</Link>
        <div className="mt-20 max-w-sm"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f1bf6b] text-[#123b4a]"><ShieldCheck /></div><h1 className="mt-6 font-display text-4xl font-semibold">Кабінет агенції</h1><p className="mt-4 leading-7 text-white/65">Безпечний простір для команди Морського Шляху.</p></div>
        <p className="text-xs text-white/40">Доступ лише для уповноважених менеджерів</p>
      </div>
      <div className="flex flex-1 items-center p-6 sm:p-12"><div className="w-full max-w-md"><p className="eyebrow">Вхід для менеджера</p><h2 className="mt-2 font-display text-3xl font-semibold">Раді вас бачити</h2><p className="mt-2 text-sm leading-6 text-[#718484]">Увійдіть за робочою електронною поштою та паролем.</p><div className="admin-auth mt-8"><Auth supabaseClient={supabase} providers={[]} view="sign_in" theme="light" appearance={{ theme: ThemeSupa, variables: { default: { colors: { brand: '#147d92', brandAccent: '#0d6577', inputBorder: '#d4e5e1', inputBorderFocus: '#147d92', inputBackground: '#fbfcfa', messageText: '#d27652' }, radii: { borderRadiusButton: '14px', buttonBorderRadius: '14px', inputBorderRadius: '14px' } } } }} /></div></div></div>
    </div>
  </div>
);

const TabButton = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => <button onClick={onClick} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold ${active ? 'bg-[#e8f3f1] text-[#147d92]' : 'text-[#718484] hover:bg-[#f4f7f4]'}`}>{children}</button>;

const StatCard = ({ label, value, hint, accent }: { label: string; value: number; hint: string; accent: 'orange' | 'blue' | 'green' | 'sand' }) => {
  const colors = { orange: 'bg-[#fff1d9] text-[#c17a2c]', blue: 'bg-[#e8f3f1] text-[#147d92]', green: 'bg-[#ddf2e8] text-[#299066]', sand: 'bg-[#f3eee5] text-[#8a6d43]' };
  const color = colors[accent];
  return <div className="rounded-[22px] border border-[#dce9e3] bg-white p-5"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-[#718484]">{label}</p><span className={`flex h-8 w-8 items-center justify-center rounded-xl ${color}`}><Ticket size={15} /></span></div><p className="mt-5 font-display text-4xl font-semibold">{value}</p><p className="mt-1 text-xs text-[#8ba09f]">{hint}</p></div>;
};

const BookingRow = ({ booking, open, onToggle, onStatusChange }: { booking: Booking; open: boolean; onToggle: () => void; onStatusChange: (status: BookingStatus) => void }) => (
  <article className="overflow-hidden rounded-[24px] border border-[#dce9e3] bg-white">
    <button onClick={onToggle} className="flex w-full flex-col gap-4 p-5 text-left transition hover:bg-[#fbfcfa] sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3"><span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e8f3f1] text-[#147d92]"><Ticket size={18} /></span><span><span className="flex flex-wrap items-center gap-2"><strong className="text-[#315b62]">{booking.contact_name}</strong><StatusBadge status={booking.status} /></span><span className="mt-1 block text-sm text-[#718484]">{booking.origin} → {booking.destination} · {formatDate(booking.departure_date)} · {booking.passenger_count} пас.</span></span></div>
      <span className="flex items-center gap-4 sm:pl-4"><span className="text-left sm:text-right"><span className="block text-xs text-[#8ba09f]">{booking.booking_reference}</span><strong className="block text-lg text-[#123b4a]">{formatPrice(booking.total_price)}</strong></span><ChevronDown size={18} className={`text-[#8ba09f] transition ${open ? 'rotate-180' : ''}`} /></span>
    </button>
    {open && <div className="border-t border-[#edf2ef] bg-[#fbfcfa] p-5"><div className="grid gap-6 lg:grid-cols-[1fr_auto]"><div><p className="detail-label">Пасажири</p><ul className="mt-2 space-y-1 text-sm font-semibold text-[#315b62]">{booking.passengers?.map((passenger, index) => <li key={index}>{passenger.fullName}{passenger.type === 'child' && <span className="ml-1.5 rounded-full bg-[#fff1d9] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.06em] text-[#a86c25]">дитина, {passenger.age} р.</span>}</li>)}</ul><p className="detail-label mt-5">Контакт</p><p className="mt-2 text-sm text-[#315b62]">{booking.phone} (Telegram / Viber)<br />{booking.email}</p></div><div className="min-w-[180px]"><p className="detail-label">Змінити статус</p><select value={booking.status} onChange={(event) => onStatusChange(event.target.value as BookingStatus)} className="mt-2 w-full rounded-xl border border-[#d4e5e1] bg-white px-3 py-2.5 text-sm font-bold text-[#315b62] outline-none focus:border-[#147d92]"><option value="new">Нова</option><option value="in_progress">В роботі</option><option value="confirmed">Підтверджено</option><option value="cancelled">Скасовано</option></select><p className="mt-3 text-xs leading-5 text-[#8ba09f]">Підтвердження автоматично додає контакт до CRM.</p></div></div></div>}
  </article>
);

const StatusBadge = ({ status }: { status: BookingStatus }) => {
  const colors: Record<BookingStatus, string> = { new: 'bg-[#fff1d9] text-[#a86c25]', in_progress: 'bg-[#e8f3f1] text-[#147d92]', confirmed: 'bg-[#ddf2e8] text-[#299066]', cancelled: 'bg-[#f9e6e1] text-[#ba634c]' };
  const color = colors[status];
  const label = statusLabels[status];
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] ${color}`}>{label}</span>;
};

const CustomerTable = ({ customers }: { customers: Customer[] }) => <section className="mt-4 overflow-hidden rounded-[26px] border border-[#dce9e3] bg-white"><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b border-[#e8efeb] bg-[#fbfcfa] text-xs uppercase tracking-[.1em] text-[#8ba09f]"><tr><th className="px-5 py-4">Клієнт</th><th className="px-5 py-4">Контакти</th><th className="px-5 py-4">Поїздок</th><th className="px-5 py-4">Остання заявка</th></tr></thead><tbody className="divide-y divide-[#edf2ef]">{customers.length === 0 ? <tr><td colSpan={4} className="px-5 py-12 text-center text-[#718484]">Підтверджених клієнтів ще немає</td></tr> : customers.map((customer) => <tr key={customer.id} className="hover:bg-[#fbfcfa]"><td className="px-5 py-4 font-bold text-[#315b62]">{customer.full_name}</td><td className="px-5 py-4"><p>{customer.phone}</p><p className="text-xs text-[#8ba09f]">{customer.email}</p></td><td className="px-5 py-4 font-bold text-[#147d92]">{customer.booking_count}</td><td className="px-5 py-4 text-[#718484]">{formatDate(customer.last_booking_at.slice(0, 10))}</td></tr>)}</tbody></table></div></section>;

const EmptyState = ({ text }: { text: string }) => <div className="rounded-[24px] border border-dashed border-[#c7dcd5] bg-white p-12 text-center"><Ticket className="mx-auto text-[#147d92]" size={28} /><p className="mt-3 text-sm font-semibold text-[#718484]">{text}</p></div>;

export default Admin;
