import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { formatDate } from '@/lib/hooks';

/** A small area chart without axes: the shape of the last days at a glance. */
export function Sparkline({ data, format, lang, label }: { data: { day: string; value: number }[]; format: (centimes: number) => string; lang: string; label: string }) {
  return (
    <div className="h-24 w-full" dir="ltr" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
          <XAxis dataKey="day" hide />
          <Tooltip
            formatter={(v) => [format(Number(v)), label]}
            labelFormatter={(day) => formatDate(String(day), lang)}
            contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--ink)' }}
          />
          <Area type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2} fill="var(--accent)" fillOpacity={0.15} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
