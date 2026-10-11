import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PageBody, PageHeader, SubTabs } from '@/components/Page';
import { Button } from '@/components/ui';
import { SECTION_ICONS, SECTION_TABS } from '@/lib/sections';
import { BoardTab } from './BoardTab';
import { NewRepairDialog } from './NewRepairDialog';
import { TicketsTab } from './TicketsTab';

type Tab = (typeof SECTION_TABS.repairs)[number];

export function Repairs() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? '';
  const tab: Tab = (SECTION_TABS.repairs as readonly string[]).includes(raw) ? (raw as Tab) : 'board';
  const adding = params.get('new') === '1';
  const setAdding = (on: boolean): void => setParams(on ? { tab, new: '1' } : { tab }, { replace: true });
  return (
    <PageBody>
      <PageHeader
        icon={SECTION_ICONS.repairs}
        title={t('sections.repairs')}
        subtitle={t('repairs.subtitle')}
        action={
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            {t('repairs.new')}
          </Button>
        }
      />
      <SubTabs value={tab} onChange={(id) => setParams({ tab: id })} tabs={SECTION_TABS.repairs.map((id) => ({ id, label: t(`tabs.repairs.${id}`) }))} />
      {tab === 'board' && <BoardTab />}
      {tab === 'tickets' && <TicketsTab />}
      {adding && <NewRepairDialog onClose={() => setAdding(false)} />}
    </PageBody>
  );
}
