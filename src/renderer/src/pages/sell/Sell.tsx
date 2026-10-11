import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PageBody, PageHeader, SubTabs } from '@/components/Page';
import { api } from '@/lib/api';
import { SECTION_ICONS, SECTION_TABS } from '@/lib/sections';
import { NewSaleTab } from './NewSaleTab';
import { ReturnsTab } from './ReturnsTab';
import { ReviewTab } from './ReviewTab';
import { SalesHistoryTab } from './SalesHistoryTab';

type Tab = (typeof SECTION_TABS.sell)[number];

export function Sell() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? '';
  const review = useQuery({ queryKey: ['sync', 'count'], queryFn: () => api('sync.conflictCount'), refetchInterval: 30_000 }).data ?? 0;
  const tab: Tab = (SECTION_TABS.sell as readonly string[]).includes(raw) ? (raw as Tab) : 'newSale';
  return (
    <PageBody>
      <PageHeader icon={SECTION_ICONS.sell} title={t('sections.sell')} subtitle={t('sell.subtitle')} />
      <SubTabs value={tab} onChange={(id) => setParams({ tab: id })} tabs={SECTION_TABS.sell.map((id) => ({ id, label: id === 'review' && review > 0 ? `${t(`tabs.sell.${id}`)} (${review})` : t(`tabs.sell.${id}`) }))} />
      {tab === 'newSale' && <NewSaleTab />}
      {tab === 'history' && <SalesHistoryTab />}
      {tab === 'returns' && <ReturnsTab />}
      {tab === 'review' && <ReviewTab />}
    </PageBody>
  );
}
