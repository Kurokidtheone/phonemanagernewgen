import { useQuery } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Button, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { CATEGORY_KINDS } from './shared';

type Kind = (typeof CATEGORY_KINDS)[number];
interface Entry {
  id: string;
  name: string;
  kind?: Kind;
}

/** Enter inside these rows acts on the row, not on the surrounding dialog. */
function enter(e: React.KeyboardEvent, action: () => void): void {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  e.stopPropagation();
  action();
}

/** Brands and categories in one small dialog: add, rename, delete (only while nothing uses them). */
export function CatalogDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api('brands.list') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api('categories.list') });

  return (
    <Dialog wide title={t('stock.catalog.title')} hint={t('stock.catalog.hint')} onClose={onClose}>
      <div className="grid gap-6 md:grid-cols-2">
        <Section
          title={t('stock.catalog.brands')}
          entries={brands.data ?? []}
          addPlaceholder={t('stock.catalog.newBrand')}
          onCreate={(name) => api('brands.create', { name })}
          onRename={(id, name) => api('brands.rename', { id, name })}
          onDelete={(id) => api('brands.delete', { id })}
          invalidate={[['brands'], ['models'], ['units']]}
          searchable
          extra={<AddPopular />}
        />
        <Section
          title={t('stock.catalog.categories')}
          entries={categories.data ?? []}
          kinds
          addPlaceholder={t('stock.catalog.newCategory')}
          onCreate={(name, kind) => api('categories.create', { name, kind: kind ?? 'ACCESSORY' })}
          onRename={(id, name) => api('categories.rename', { id, name })}
          onDelete={(id) => api('categories.delete', { id })}
          invalidate={[['categories'], ['items']]}
        />
      </div>
      <Button onClick={onClose}>{t('common.close')}</Button>
    </Dialog>
  );
}

function Section({ title, entries, kinds, searchable, extra, addPlaceholder, onCreate, onRename, onDelete, invalidate }: {
  title: string;
  entries: Entry[];
  kinds?: boolean;
  /** A search bar above the list (brands are many). */
  searchable?: boolean;
  extra?: React.ReactNode;
  addPlaceholder: string;
  onCreate: (name: string, kind?: Kind) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  invalidate: string[][];
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<Kind>('ACCESSORY');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);

  const create = useAction(() => onCreate(name.trim(), kind), { success: t('stock.catalog.saved'), invalidate, onDone: () => setName('') });
  const rename = useAction((e: { id: string; name: string }) => onRename(e.id, e.name.trim()), { success: t('stock.catalog.saved'), invalidate, onDone: () => setEditing(null) });
  const remove = useAction((id: string) => onDelete(id), { success: t('stock.catalog.deleted'), invalidate, onDone: () => setDeleting(null) });

  return (
    <section>
      <h3 className="mb-2 flex items-center justify-between gap-2 font-bold">
        {title}
        {extra}
      </h3>
      {searchable && <Input className="mb-2" value={filter} placeholder={t('stock.catalog.searchBrands')} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} />}
      <div className="mb-3 flex gap-2" onKeyDown={(e) => enter(e, () => name.trim() && create.mutate(undefined))}>
        <Input value={name} placeholder={addPlaceholder} onChange={(e) => setName(e.target.value)} />
        {kinds && (
          <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label={t('stock.catalog.kindLabel')}>
            {CATEGORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`stock.catalog.kind.${k}`)}
              </option>
            ))}
          </select>
        )}
        <Button variant="primary" icon={Plus} disabled={!name.trim() || create.isPending} onClick={() => create.mutate(undefined)} aria-label={t('common.add')} />
      </div>
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {entries.filter((e) => !filter.trim() || e.name.toLowerCase().includes(filter.trim().toLowerCase())).map((entry) => (
          <li key={entry.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            {editing?.id === entry.id ? (
              <div className="flex flex-1 gap-2" onKeyDown={(e) => enter(e, () => editing.name.trim() && rename.mutate(editing))}>
                <Input autoFocus value={editing.name} onChange={(e) => setEditing({ id: entry.id, name: e.target.value })} />
                <Button icon={Check} onClick={() => editing.name.trim() && rename.mutate(editing)} aria-label={t('common.save')} />
              </div>
            ) : (
              <>
                <span className="flex-1 font-semibold">{entry.name}</span>
                {entry.kind && <span className="text-xs text-muted">{t(`stock.catalog.kind.${entry.kind}`)}</span>}
                <button type="button" className="rounded-md p-1.5 text-muted hover:bg-paper" onClick={() => setEditing({ id: entry.id, name: entry.name })} aria-label={t('stock.catalog.rename')}>
                  <Pencil size={15} />
                </button>
                <button type="button" className="rounded-md p-1.5 text-danger hover:bg-paper" onClick={() => setDeleting(entry)} aria-label={t('common.delete')}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {deleting && (
        <ConfirmDialog
          title={t('stock.catalog.deleteTitle', { name: deleting.name })}
          body={t('stock.catalog.deleteBody')}
          confirmLabel={t('common.delete')}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

/** Adds the popular phone and accessory brands (world market and Algeria) that are not in the list yet. */
function AddPopular() {
  const { t } = useTranslation();
  const add = useAction(() => api('brands.addPopular'), {
    invalidate: [['brands']],
    onDone: ({ added }) => toast.ok(added > 0 ? t('stock.catalog.popularAdded', { count: added }) : t('stock.catalog.popularNone')),
  });
  return (
    <Button disabled={add.isPending} onClick={() => add.mutate(undefined)}>
      {t('stock.catalog.addPopular')}
    </Button>
  );
}
