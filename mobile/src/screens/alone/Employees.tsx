import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyField, ScreenHeader, Sheet, useFormatMoney } from '@/components/common';
import { Button, Empty, Field, inputClass, Refreshable, Row } from '@/components/ui';
import { api } from '@/lib/api';
import { Panel, useDo } from './kit';

const ROLES = ['SELLER', 'TECHNICIAN', 'CASHIER', 'OTHER'] as const;

export function EmployeesScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const money = useFormatMoney();
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<{ id: string; name: string; salary: number } | null>(null);
  const list = useQuery({ queryKey: ['employees', 'overview'], queryFn: () => api('employee.list') });
  return (
    <div className="flex h-full flex-col" data-accent="purple">
      <ScreenHeader title={t('m.alone.employees')} onBack={onBack} right={<Button icon={Plus} variant="primary" onClick={() => setAdding(true)}>{t('common.add')}</Button>} />
      <div className="min-h-0 flex-1">
        <Refreshable onRefresh={() => list.refetch()}>
          {(list.data ?? []).filter((e) => !e.deletedAt).length === 0 && <Empty>{t('m.alone.noEmployees')}</Empty>}
          {(list.data ?? []).filter((e) => !e.deletedAt).map((e) => (
            <Row key={e.id} title={e.name} subtitle={`${t(`employees.roles.${e.role}`, { defaultValue: e.role })}${e.advanceBalance > 0 ? ` · ${t('m.alone.advance')} ${money(e.advanceBalance)}` : ''}`} right={money(e.monthlySalary)} onClick={() => setPaying({ id: e.id, name: e.name, salary: e.monthlySalary })} />
          ))}
        </Refreshable>
      </div>
      {adding && <AddEmployee onClose={() => setAdding(false)} />}
      {paying && <PaySalary employee={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

function AddEmployee({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('SELLER');
  const [phone, setPhone] = useState('');
  const [salary, setSalary] = useState<number | null>(null);
  const save = useDo(() => api('employee.create', { name, role, phone, monthlySalary: salary ?? 0, commissionSalesBp: 0, commissionRepairsBp: 0 }), { success: t('common.saved'), onDone: onClose });
  return (
    <Sheet title={t('m.alone.addEmployee')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('m.alone.name')}>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`employees.roles.${r}`, { defaultValue: r })}
            </option>
          ))}
        </select>
        <Field label={t('m.alone.phone')}>
          <input dir="ltr" inputMode="tel" className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={t('m.alone.salary')}>
          <MoneyField value={salary} onChange={setSalary} />
        </Field>
        <Button variant="primary" className="w-full" busy={save.isPending} disabled={!name.trim()} onClick={() => save.mutate(undefined)}>
          {t('common.save')}
        </Button>
      </div>
    </Sheet>
  );
}

function PaySalary({ employee, onClose }: { employee: { id: string; name: string; salary: number }; onClose: () => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState<number | null>(employee.salary || null);
  const pay = useDo(() => api('employee.paySalary', { employeeId: employee.id, amount: amount ?? 0, deduct: 0, note: '', method: 'CASH', date: new Date().toISOString() }), { success: t('common.saved'), onDone: onClose });
  return (
    <Sheet title={`${t('m.alone.paySalary')} · ${employee.name}`} onClose={onClose}>
      <Panel>
        <MoneyField value={amount} onChange={setAmount} />
        <Button variant="primary" className="mt-3 w-full" busy={pay.isPending} disabled={!amount} onClick={() => pay.mutate(undefined)}>
          {t('m.alone.paySalary')}
        </Button>
      </Panel>
    </Sheet>
  );
}
