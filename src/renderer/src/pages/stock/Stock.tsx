import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PageBody, PageHeader, SubTabs } from '@/components/Page';
import { StockScanner } from '@/components/StockScanner';
import { SECTION_ICONS, SECTION_TABS } from '@/lib/sections';
import { ItemsTab } from './ItemsTab';
import { CountsTab } from './CountsTab';
import { PhonesTab } from './PhonesTab';
import { PurchasesTab } from './PurchasesTab';
import { SuppliersTab } from './SuppliersTab';

type Tab = (typeof SECTION_TABS.stock)[number];

export function Stock() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (SECTION_TABS.stock as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'phones';
  // Requests from the scanner: open an item, or start a new phone / item with a scanned code.
  const open = params.get('open');
  const created = params.get('new');
  const handled = useCallback(() => setParams({ tab }, { replace: true }), [setParams, tab]);

  return (
    <PageBody>
      <StockScanner />
      <PageHeader icon={SECTION_ICONS.stock} title={t('sections.stock')} subtitle={t('stock.subtitle')} />
      <SubTabs value={tab} onChange={(id) => setParams({ tab: id })} tabs={SECTION_TABS.stock.map((id) => ({ id, label: t(`tabs.stock.${id}`) }))} />
      {tab === 'phones' && <PhonesTab newImei={created} onHandled={handled} />}
      {tab === 'items' && <ItemsTab openId={open} newBarcode={created} onHandled={handled} />}
      {tab === 'purchases' && <PurchasesTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'counts' && <CountsTab />}
    </PageBody>
  );
}
