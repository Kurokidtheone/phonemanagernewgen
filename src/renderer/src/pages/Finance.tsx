// Sample feature page: list, filters, stat cards, create dialog, delete with confirmation.
// Copy this file's shape for every new page.
import { useQuery } from '@tanstack/react-query';
import { Paperclip, Plus, Receipt, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type Column } from '@/components/DataTable';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { PageBody, PageHeader, SubTabs } from '@/components/Page';
import { Button, Card, EmptyState, Field, Input, MoneyInput, StatCard } from '@/components/ui';
import { api, fileUrl } from '@/lib/api';
import { useSearchParams } from 'react-router-dom';
import { AnalyticsTab } from './finance/AnalyticsTab';
import { CashTab } from './finance/CashTab';
import { ReportsTab } from './finance/ReportsTab';
import { ServicesTab } from './finance/ServicesTab';
import { formatDate, today, useAction, useMoney } from '@/lib/hooks';
import { FilePicker } from '@/components/FilePicker';
import { DOCUMENT_EXTENSIONS } from '@/lib/files';

type Tab = 'cash' | 'expenses' | 'debts' | 'services' | 'analytics' | 'reports';
const TABS: Tab[] = ['cash', 'expenses', 'debts', 'services', 'analytics', 'reports'];

export function Finance() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const fromUrl = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(fromUrl && TABS.includes(fromUrl) ? fromUrl : 'cash');
  return (
    <PageBody>
      <PageHeader icon={Wallet} title={t('sections.finance')} subtitle={t('expenses.subtitle')} />
      <SubTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'cash', label: t('tabs.finance.cash') },
          { id: 'expenses', label: t('tabs.finance.expenses') },
          { id: 'debts', label: t('tabs.finance.debts') },
          { id: 'services', label: t('tabs.finance.services') },
          { id: 'analytics', label: t('tabs.finance.analytics') },
          { id: 'reports', label: t('tabs.finance.reports') },
        ]}
      />
      {tab === 'cash' ? (
        <CashTab />
      ) : tab === 'expenses' ? (
        <Expenses />
      ) : tab === 'services' ? (
        <ServicesTab />
      ) : tab === 'analytics' ? (
        <AnalyticsTab />
      ) : tab === 'reports' ? (
        <ReportsTab />
      ) : (
        <Card>
          <EmptyState title={t('placeholder.title')} hint={t('placeholder.hint')} />
        </Card>
      )}
    </PageBody>
  );
}

function Expenses() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const [categoryId, setCategoryId] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const categories = useQuery({ queryKey: ['expenses', 'categories'], queryFn: () => api('expenses.categories') });
  const list = useQuery({
    queryKey: ['expenses', 'list', categoryId],
    queryFn: () => api('expenses.list', categoryId ? { categoryId } : {}),
  });
  const remove = useAction((id: string) => api('expenses.delete', { id }), {
    success: t('expenses.deleted'),
    invalidate: [['expenses'], ['cash']],
    onDone: () => setDeleting(null),
  });

  type Row = NonNullable<typeof list.data>[number];
  const month = today().slice(0, 7);
  const rows = list.data ?? [];
  const monthTotal = rows.filter((r) => r.date.startsWith(month)).reduce((sum, r) => sum + r.amount, 0);

  const columns: Column<Row>[] = [
    { header: t('expenses.date'), cell: (r) => formatDate(r.date, i18n.language), width: '130px' },
    { header: t('expenses.buyer'), cell: (r) => <span className="font-semibold">{r.buyer}</span> },
    { header: t('expenses.category'), cell: (r) => r.categoryName },
    { header: t('expenses.note'), cell: (r) => <span className="text-muted">{r.note || '—'}</span> },
    { header: t('expenses.amount'), cell: (r) => <span className="font-bold">{money(r.amount)}</span>, align: 'end' },
    {
      header: '',
      width: '90px',
      align: 'end',
      cell: (r) => (
        <span className="inline-flex gap-1">
          {r.receiptFile && (
            <a href={fileUrl(r.receiptFile)} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted hover:bg-paper" aria-label={t('expenses.receipt')}>
              <Paperclip size={16} />
            </a>
          )}
          <button className="rounded-md p-1.5 text-danger hover:bg-paper" onClick={() => setDeleting(r.id)} aria-label={t('common.delete')}>
            <Trash2 size={16} />
          </button>
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3">
        <StatCard icon={Wallet} label={t('expenses.thisMonth')} value={money(monthTotal)} />
        <StatCard icon={Receipt} label={t('expenses.count')} value={rows.length} />
      </div>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        searchText={(r) => `${r.buyer} ${r.note} ${r.categoryName}`}
        searchPlaceholder={t('expenses.search')}
        emptyTitle={t('expenses.empty')}
        emptyHint={t('expenses.emptyHint')}
        filters={
          <select className="input w-auto" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label={t('expenses.category')}>
            <option value="">{t('expenses.allCategories')}</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        }
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            {t('expenses.add')}
          </Button>
        }
      />
      {adding && <ExpenseDialog categories={categories.data ?? []} onClose={() => setAdding(false)} />}
      {deleting && (
        <ConfirmDialog
          title={t('expenses.deleteTitle')}
          body={t('expenses.deleteBody')}
          confirmLabel={t('common.delete')}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function ExpenseDialog({ categories, onClose }: { categories: { id: string; name: string }[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [buyer, setBuyer] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [newCategory, setNewCategory] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [fromCash, setFromCash] = useState(true);

  const addCategory = useAction((name: string) => api('expenses.createCategory', { name }), {
    invalidate: [['expenses', 'categories']],
    onDone: (c) => {
      setCategoryId(c.id);
      setNewCategory('');
    },
  });
  const save = useAction(() => api('expenses.create', { buyer, categoryId, date, amount: amount ?? 0, note, receiptPath, fromCash }), {
    success: t('expenses.saved'),
    invalidate: [['expenses'], ['cash']],
    onDone: onClose,
  });

  const valid = buyer.trim() && categoryId && amount !== null && amount > 0;

  return (
    <Dialog title={t('expenses.add')} onClose={onClose} onSubmit={() => valid && save.mutate(undefined)} busy={save.isPending || !valid}>
      <Field label={t('expenses.buyer')} required>
        <Input autoFocus value={buyer} onChange={(e) => setBuyer(e.target.value)} />
      </Field>
      <Field label={t('expenses.category')} required>
        <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {categories.length === 0 && <option value="">{t('expenses.noCategory')}</option>}
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-2">
        <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder={t('expenses.newCategory')} aria-label={t('expenses.newCategory')} />
        <Button icon={Plus} disabled={!newCategory.trim() || addCategory.isPending} onClick={() => addCategory.mutate(newCategory)}>
          {t('common.add')}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('expenses.date')} required>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('expenses.amount')} required>
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
      </div>
      <Field label={t('expenses.note')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={fromCash} onChange={(e) => setFromCash(e.target.checked)} />
        {t('expenses.fromCash')}
      </label>
      <Field label={t('expenses.receipt')}>
        <FilePicker value={receiptPath} onChange={setReceiptPath} extensions={DOCUMENT_EXTENSIONS} />
      </Field>
    </Dialog>
  );
}
