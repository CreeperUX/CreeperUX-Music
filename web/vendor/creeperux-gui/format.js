// Locale-aware formatting on Intl (D30). One formatter per locale; Intl objects are cached per option set.
const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];

export function createFormatter(locale = 'en') {
  const cache = new Map();
  const get = (Ctor, opts) => { const k = Ctor.name + JSON.stringify(opts); let f = cache.get(k); if (!f) { f = new Ctor(locale, opts); cache.set(k, f); } return f; };
  const toDate = d => (d instanceof Date ? d : new Date(d));
  const f = {
    locale,
    number: (v, o = {}) => (v == null || Number.isNaN(v) ? '—' : get(Intl.NumberFormat, o).format(v)),
    integer: v => f.number(v, { maximumFractionDigits: 0 }),
    currency: (v, currency, o = {}) => f.number(v, { style: 'currency', currency, ...o }),
    percent: (v, digits = 1) => f.number(v, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }),
    unit: (v, unit, o = {}) => f.number(v, { style: 'unit', unit, unitDisplay: 'short', ...o }),
    // SI units: Intl's kilobyte is 1,000 bytes
    bytes: b => { let i = 0, v = b; while (Math.abs(v) >= 1000 && i < BYTE_UNITS.length - 1) { v /= 1000; i++; } return f.number(v, { style: 'unit', unit: BYTE_UNITS[i], unitDisplay: 'short', maximumFractionDigits: i ? 1 : 0 }); },
    compact: v => f.number(v, { notation: 'compact', maximumFractionDigits: 1 }),
    date: (d, o = { dateStyle: 'medium' }) => get(Intl.DateTimeFormat, o).format(toDate(d)),
    time: (d, o = { timeStyle: 'short' }) => get(Intl.DateTimeFormat, o).format(toDate(d)),
    dateTime: (d, o = { dateStyle: 'medium', timeStyle: 'short' }) => get(Intl.DateTimeFormat, o).format(toDate(d)),
    dateRange: (a, b, o = { dateStyle: 'medium' }) => { const df = get(Intl.DateTimeFormat, o); return df.formatRange ? df.formatRange(toDate(a), toDate(b)) : `${df.format(toDate(a))} – ${df.format(toDate(b))}`; },
    /** Relative time from `then` to `now` (ms timestamps or Dates). */
    relative: (then, now = Date.now()) => {
      const s = (toDate(then).getTime() - toDate(now).getTime()) / 1000, r = get(Intl.RelativeTimeFormat, { numeric: 'auto' }), a = Math.abs(s);
      if (a < 45) return r.format(Math.round(s), 'second');
      if (a < 2700) return r.format(Math.round(s / 60), 'minute');
      if (a < 64800) return r.format(Math.round(s / 3600), 'hour');
      if (a < 2592000) return r.format(Math.round(s / 86400), 'day');
      if (a < 31536000) return r.format(Math.round(s / 2592000), 'month');
      return r.format(Math.round(s / 31536000), 'year');
    },
    list: (items, type = 'conjunction') => get(Intl.ListFormat, { type }).format(items),
    /**
     * A length of time in seconds (2.5.0, G59). 'clock' (default): "3:05", "1:02:03" (hours when needed or `hours: true`),
     * in the locale's digits; 'long': "3 minutes, 5 seconds", for screen readers (aria-valuetext). Unknown → "—".
     */
    duration(seconds, { style = 'clock', hours } = {}) {
      if (seconds == null || !Number.isFinite(seconds)) return '—';
      const neg = seconds < 0, t = Math.floor(Math.abs(seconds)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
      if (style === 'long') {
        const D = Intl.DurationFormat;
        if (D) return (neg ? '−' : '') + get(D, { style: 'long' }).format({ hours: h, minutes: m, seconds: s });
        const parts = [[h, 'hour'], [m, 'minute'], [s, 'second']].filter(([v], i) => v || (i === 2 && !h && !m)).map(([v, u]) => f.unit(v, u, { unitDisplay: 'long' }));
        return (neg ? '−' : '') + f.list(parts, 'unit');
      }
      const two = v => f.number(v, { minimumIntegerDigits: 2, useGrouping: false });
      return (neg ? '−' : '') + (h || hours ? `${f.number(h, { useGrouping: false })}:${two(m)}:${two(s)}` : `${f.number(m, { useGrouping: false })}:${two(s)}`);
    },
    /** Parses a number typed in this locale ("1.234,5" in de, "1,234.5" in en). Returns NaN when invalid. */
    parseNumber(text) {
      const parts = get(Intl.NumberFormat, {}).formatToParts(12345.6);
      const group = parts.find(p => p.type === 'group')?.value ?? ',', decimal = parts.find(p => p.type === 'decimal')?.value ?? '.';
      let s = String(text).trim().replace(/[\s  ]/g, '');
      // Native digits (e.g. Arabic-Indic) → Latin
      s = s.replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6f0).replace(/[０-９]/g, d => d.charCodeAt(0) - 0xff10);
      s = s.split(group).join('').replace(decimal, '.').replace(/[−–]/g, '-');
      return /^-?\d*(\.\d+)?$/.test(s) && s !== '' && s !== '-' ? Number(s) : NaN;
    },
    /** First day of the week for this locale (0 = Sunday … 6 = Saturday). */
    weekStart() {
      try { const info = new Intl.Locale(locale).getWeekInfo?.() ?? new Intl.Locale(locale).weekInfo; if (info?.firstDay) return info.firstDay % 7; } catch { /* older engines */ }
      const region = (locale.split('-')[1] || '').toUpperCase();
      return ['US', 'CA', 'JP', 'MX', 'BR', 'IL', 'KR', 'TW', 'HK', 'PH', 'IN', 'SA', 'ZA'].includes(region) || locale === 'ja' || locale === 'en' ? 0 : ['AE', 'EG', 'QA', 'KW', 'BH', 'OM', 'IQ', 'JO', 'SY', 'LB', 'DZ', 'LY', 'SD'].includes(region) ? 6 : 1;
    },
  };
  return f;
}
