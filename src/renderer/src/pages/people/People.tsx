import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageBody, PageHeader, SubTabs } from '@/components/Page';
import { SECTION_ICONS, SECTION_TABS } from '@/lib/sections';
import { CustomersTab } from './CustomersTab';
import { EmployeesTab } from './EmployeesTab';

type Tab = (typeof SECTION_TABS.people)[number];

export function People() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('customers');
  return (
    <PageBody>
      <PageHeader icon={SECTION_ICONS.people} title={t('sections.people')} subtitle={t('customers.subtitle')} />
      <SubTabs value={tab} onChange={setTab} tabs={SECTION_TABS.people.map((id) => ({ id, label: t(`tabs.people.${id}`) }))} />
      {tab === 'customers' && <CustomersTab />}
      {tab === 'employees' && <EmployeesTab />}
    </PageBody>
  );
}
