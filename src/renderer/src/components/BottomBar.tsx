import clsx from 'clsx';
import { Lock, LockOpen, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { SECTIONS } from '@shared/app.config';
import { api } from '@/lib/api';
import { useAction, useAuth } from '@/lib/hooks';
import { SECTION_ICONS } from '@/lib/sections';

const TAB = 'flex flex-1 flex-col items-center justify-center gap-1 border-t-[3px] py-2.5 text-xs font-bold transition';

/** Fixed bottom navigation: one tab per section, with the Lock tab placed before Settings. */
export function BottomBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuth().data;
  const [menu, setMenu] = useState(false);
  const lock = useAction(() => api('auth.lock'), { success: t('lock.locked'), invalidate: [['auth']], onDone: () => navigate('/') });

  const canLock = !!auth?.hasPassword && auth.unlocked && auth.protectedSections.length > 0;
  const tabs = SECTIONS.filter((s) => s.id !== 'settings');
  const settings = SECTIONS.find((s) => s.id === 'settings')!;

  const tab = (s: (typeof SECTIONS)[number]) => {
    const Icon = SECTION_ICONS[s.id];
    return (
      <NavLink
        key={s.id}
        to={s.path}
        end={s.path === '/'}
        data-accent={s.accent}
        className={({ isActive }) => clsx(TAB, 'text-accent', isActive ? 'border-accent bg-accent-soft' : 'border-transparent bg-accent-faint hover:bg-accent-soft')}
      >
        <Icon size={20} aria-hidden />
        {t(`sections.${s.id}`)}
      </NavLink>
    );
  };

  return (
    <nav className="flex shrink-0 border-t border-line bg-card" aria-label={t('common.navigation')}>
      {tabs.map(tab)}
      <div className="relative flex flex-1" data-accent="neutral">
        <button className={clsx(TAB, 'border-transparent text-ink hover:bg-paper')} onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
          {auth?.hasPassword && !auth.unlocked ? <Lock size={20} aria-hidden /> : <LockOpen size={20} aria-hidden />}
          {t('lock.tab')}
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
            <div className="absolute bottom-full start-1/2 z-30 mb-2 w-56 -translate-x-1/2 rounded-xl border border-line bg-card p-1.5 shadow-xl rtl:translate-x-1/2">
              <button
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold hover:bg-paper disabled:opacity-50"
                disabled={!canLock}
                onClick={() => {
                  setMenu(false);
                  lock.mutate(undefined);
                }}
              >
                <Lock size={16} /> {t('lock.now')}
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold hover:bg-paper"
                onClick={() => {
                  setMenu(false);
                  navigate('/settings#security');
                }}
              >
                <SlidersHorizontal size={16} /> {t('lock.sections')}
              </button>
            </div>
          </>
        )}
      </div>
      {tab(settings)}
    </nav>
  );
}
