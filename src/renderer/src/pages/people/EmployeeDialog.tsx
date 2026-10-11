import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EMPLOYEE_ROLES } from '@shared/schemas';
import { Dialog } from '@/components/Dialog';
import { Field, Input, MoneyInput } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';

interface Editable {
  id: string;
  name: string;
  role: string;
  phone: string;
  monthlySalary: number;
  commissionSalesBp: number;
  commissionRepairsBp: number;
}

const toBp = (percent: string): number => Math.min(10_000, Math.max(0, Math.round((Number(percent.replace(',', '.')) || 0) * 100)));

export function EmployeeDialog({ employee, onClose }: { employee?: Editable; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(employee?.name ?? '');
  const [role, setRole] = useState<(typeof EMPLOYEE_ROLES)[number]>((EMPLOYEE_ROLES as readonly string[]).includes(employee?.role ?? '') ? (employee!.role as (typeof EMPLOYEE_ROLES)[number]) : 'SELLER');
  const [phone, setPhone] = useState(employee?.phone ?? '');
  const [salary, setSalary] = useState<number | null>(employee?.monthlySalary ?? null);
  const [salesPct, setSalesPct] = useState(String((employee?.commissionSalesBp ?? 0) / 100));
  const [repairsPct, setRepairsPct] = useState(String((employee?.commissionRepairsBp ?? 0) / 100));

  const save = useAction(
    async () => {
      const fields = { name, role, phone, monthlySalary: salary ?? 0, commissionSalesBp: toBp(salesPct), commissionRepairsBp: toBp(repairsPct) };
      if (employee) await api('employee.update', { id: employee.id, ...fields });
      else await api('employee.create', fields);
    },
    { success: employee ? t('employees.updated') : t('employees.saved'), invalidate: [['employee'], ['employees']], onDone: onClose },
  );

  return (
    <Dialog title={employee ? t('employees.editTitle') : t('employees.addTitle')} onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending || !name.trim()}>
      <Field label={t('sell.customerName')} required>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('employees.role')}>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            {EMPLOYEE_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`employees.roles.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('sell.customerPhone')}>
          <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <Field label={t('employees.monthlySalary')}>
        <MoneyInput value={salary} onChange={setSalary} />
      </Field>
      <fieldset className="rounded-xl border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t('employees.commission')}</legend>
        <p className="mb-2 text-xs text-muted">{t('employees.commissionHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('employees.commissionSales')}>
            <Input dir="ltr" inputMode="decimal" value={salesPct} onChange={(e) => setSalesPct(e.target.value)} />
          </Field>
          <Field label={t('employees.commissionRepairs')}>
            <Input dir="ltr" inputMode="decimal" value={repairsPct} onChange={(e) => setRepairsPct(e.target.value)} />
          </Field>
        </div>
      </fieldset>
    </Dialog>
  );
}
