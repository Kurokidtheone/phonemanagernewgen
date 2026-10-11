// "More" in the stand-alone edition: everything the connected phone does not have, plus People, Finance and Settings.
import { BarChart3, Banknote, Briefcase, Printer, Receipt, RotateCcw, Settings, Truck, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Row } from '@/components/ui';
import { Customers } from '../Customers';
import { BackupScreen } from './Backup';
import { CashScreen } from './Cash';
import { EmployeesScreen } from './Employees';
import { ExpensesScreen } from './Expenses';
import { FinanceScreen } from './Finance';
import { LicenseScreen } from './License';
import { ReturnsScreen } from './Returns';
import { SettingsScreen } from './Settings';
import { SuppliersScreen } from './Suppliers';
import { About } from '@/components/About';
import { ScreenHeader } from '@/components/common';
import { PrinterScreen } from '../Printer';

type Page = 'people' | 'suppliers' | 'returns' | 'employees' | 'expenses' | 'cash' | 'finance' | 'printer' | 'settings' | 'backup' | 'license';

const ITEMS: { id: Page; icon: LucideIcon; label: string }[] = [
  { id: 'people', icon: Users, label: 'm.alone.people' },
  { id: 'cash', icon: Banknote, label: 'm.alone.cash' },
  { id: 'expenses', icon: Receipt, label: 'm.alone.expenses' },
  { id: 'finance', icon: BarChart3, label: 'm.alone.finance' },
  { id: 'returns', icon: RotateCcw, label: 'm.alone.returns' },
  { id: 'suppliers', icon: Truck, label: 'm.alone.suppliers' },
  { id: 'employees', icon: Briefcase, label: 'm.alone.employees' },
  { id: 'printer', icon: Printer, label: 'm.printer.title' },
  { id: 'settings', icon: Settings, label: 'm.alone.settings' },
];

export function MoreAlone() {
  const { t } = useTranslation();
  const [page, setPage] = useState<Page | null>(null);
  const back = (): void => setPage(null);
  switch (page) {
    case 'people':
      return (
        <div className="flex h-full flex-col">
          <ScreenHeader title={t('m.alone.people')} onBack={back} />
          <div className="min-h-0 flex-1">
            <Customers />
          </div>
        </div>
      );
    case 'cash':
      return <CashScreen onBack={back} />;
    case 'expenses':
      return <ExpensesScreen onBack={back} />;
    case 'finance':
      return <FinanceScreen onBack={back} />;
    case 'returns':
      return <ReturnsScreen onBack={back} />;
    case 'suppliers':
      return <SuppliersScreen onBack={back} />;
    case 'employees':
      return <EmployeesScreen onBack={back} />;
    case 'printer':
      return <PrinterScreen onBack={back} />;
    case 'settings':
      return <SettingsScreen onBack={back} open={setPage} />;
    case 'backup':
      return <BackupScreen onBack={() => setPage('settings')} />;
    case 'license':
      return <LicenseScreen onBack={() => setPage('settings')} />;
    default:
      return (
        <div className="h-full overflow-y-auto" data-accent="olive">
          {ITEMS.map(({ id, icon: Icon, label }) => (
            <Row key={id} onClick={() => setPage(id)} title={<span className="flex items-center gap-3"><Icon className="h-5 w-5 text-accent" /> {t(label)}</span>} />
          ))}
          <About />
        </div>
      );
  }
}
