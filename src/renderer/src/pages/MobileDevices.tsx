// Settings > Phones on this network: the switch, the addresses, the pairing dialog and the device list.
import { useQuery } from '@tanstack/react-query';
import { Download, Globe, Lock, Pencil, QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MOBILE_DEFAULT_PORT, MOBILE_ROLES, REMOTE_MODES, type MobileRole, type RemoteMode } from '@shared/schemas';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Badge, Button, Card, Field, Input, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, useAction } from '@/lib/hooks';
import { toast } from '@/lib/toast';

interface DeviceRow {
  id: string;
  name: string;
  role: MobileRole | null;
  employeeId: string | null;
  employeeName: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  lastSeenVia: 'lan' | 'remote' | null;
}

export function MobileDevices() {
  const { t, i18n } = useTranslation();
  const status = useQuery({ queryKey: ['mobile', 'status'], queryFn: () => api('mobile.status') });
  const devices = useQuery({ queryKey: ['mobile', 'devices'], queryFn: () => api('mobile.devices'), refetchInterval: 10_000 });
  const [port, setPort] = useState(String(MOBILE_DEFAULT_PORT));
  const [pairing, setPairing] = useState<'lan' | 'remote' | null>(null);
  const [getApp, setGetApp] = useState(false);
  const [editing, setEditing] = useState<DeviceRow | null>(null);
  const [revoking, setRevoking] = useState<DeviceRow | null>(null);

  useEffect(() => {
    if (status.data) setPort(String(status.data.port));
  }, [status.data]);

  const configure = useAction((config: { enabled: boolean; port: number }) => api('mobile.configure', config), { success: t('common.saved'), invalidate: [['mobile']] });
  const remote = useAction((mode: RemoteMode) => api('mobile.remoteConfigure', { mode }), { success: t('common.saved'), invalidate: [['mobile']] });
  const revoke = useAction((id: string) => api('mobile.revoke', { id }), {
    success: t('settings.mobile.revokedToast'),
    invalidate: [['mobile']],
    onDone: () => setRevoking(null),
  });

  const s = status.data;
  if (!s) return <Skeleton className="h-48" />;
  // Phones are a paid option: without "mobile" in the license edition the card only explains how to get it.
  if (!s.licensed) {
    return (
      <div id="mobile">
        <Card icon={Lock} title={t('settings.mobile.title')} hint={t('settings.mobile.hint')}>
          <p className="text-sm">{t('settings.mobile.notLicensed')}</p>
          <p className="mt-2 text-sm text-muted">{t('settings.mobile.howToGet')}</p>
        </Card>
      </div>
    );
  }
  const atLimit = s.deviceLimit !== null && s.deviceCount >= s.deviceLimit;
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

  return (
    <div id="mobile">
      <Card icon={Smartphone} title={t('settings.mobile.title')} hint={t('settings.mobile.hint')}>
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.enabled} disabled={configure.isPending || !portValid} onChange={(e) => configure.mutate({ enabled: e.target.checked, port: portNumber })} />
            {t('settings.mobile.enable')}
          </label>
          <div className="flex items-end gap-2">
            <div className="w-32">
              <Field label={t('settings.mobile.port')}>
                <Input type="number" inputMode="numeric" min={1024} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
              </Field>
            </div>
            <Button disabled={!portValid || portNumber === s.port || configure.isPending} onClick={() => configure.mutate({ enabled: s.enabled, port: portNumber })}>
              {t('settings.mobile.apply')}
            </Button>
          </div>

          {s.enabled && (
            <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={s.state === 'running' ? 'ok' : 'danger'}>{t(`settings.mobile.state.${s.state}`)}</Badge>
              </div>
              <div className="text-muted">{t('settings.mobile.addresses')}</div>
              {s.addresses.length === 0 ? (
                <div>{t('settings.mobile.noAddress')}</div>
              ) : (
                <ul dir="ltr" className="space-y-0.5 font-mono">
                  {s.addresses.map((a) => (
                    <li key={a}>
                      {a}:{s.port}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={QrCode} disabled={!s.enabled || s.state !== 'running' || atLimit} onClick={() => setPairing('lan')}>
              {t('settings.mobile.pair')}
            </Button>
            <Button icon={Globe} disabled={s.remote.mode === 'off' || !['connected', 'no_phone'].includes(s.remote.state) || atLimit} title={s.remote.mode === 'off' ? t('settings.mobile.remotePairNeedsMode') : undefined} onClick={() => setPairing('remote')}>
              {t('settings.mobile.remotePair')}
            </Button>
            <Button icon={Download} disabled={!s.enabled || s.state !== 'running'} onClick={() => setGetApp(true)}>
              {t('settings.mobile.getApp')}
            </Button>
            {s.deviceLimit !== null && (
              <span className={`text-sm ${atLimit ? 'font-semibold text-danger' : 'text-muted'}`}>{t('settings.mobile.deviceCount', { n: s.deviceCount, max: s.deviceLimit })}</span>
            )}
            {!s.enabled && <span className="text-sm text-muted">{t('settings.mobile.pairOff')}</span>}
          </div>
          <p className="text-sm text-muted">{t('settings.mobile.note')}</p>

          <div className="space-y-3 border-t border-line pt-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Globe className="h-4 w-4" />
              {t('settings.mobile.remoteTitle')}
            </h3>
            <p className="text-sm text-muted">{t('settings.mobile.remoteHint')}</p>
            <div className="space-y-2">
              {REMOTE_MODES.map((mode) => (
                <label key={mode} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="remote-mode" className="mt-1" checked={s.remote.mode === mode} disabled={remote.isPending} onChange={() => remote.mutate(mode)} />
                  <span>
                    <span className="font-semibold">{t(`settings.mobile.remoteMode_${mode}`)}</span>
                    <span className="block text-muted">{t(`settings.mobile.remoteModeHint_${mode}`)}</span>
                  </span>
                </label>
              ))}
            </div>
            {s.remote.mode !== 'off' && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-sm">
                <Badge tone={s.remote.state === 'connected' ? 'ok' : s.remote.state === 'connecting' ? 'accent' : 'danger'}>{t(`settings.mobile.remoteState_${s.remote.state}`)}</Badge>
                {s.remote.state === 'no_internet' && s.remote.reason && (
                  <span dir="ltr" className="text-muted">
                    {s.remote.reason}
                  </span>
                )}
                {s.remote.dropped > 0 && <span className="text-muted">{t('settings.mobile.remoteDropped', { n: s.remote.dropped })}</span>}
              </div>
            )}
          </div>

          <div className="border-t border-line pt-4">
            <h3 className="mb-2 text-sm font-semibold">{t('settings.mobile.devices')}</h3>
            {(devices.data ?? []).length === 0 ? (
              <p className="text-sm text-muted">{t('settings.mobile.none')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-start text-muted">
                  <tr>
                    {(['name', 'role', 'employee', 'seen', 'status'] as const).map((c) => (
                      <th key={c} className="py-1 pe-2 text-start font-medium">
                        {t(`settings.mobile.${c}`)}
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {devices.data!.map((d) => (
                    <tr key={d.id} className="border-t border-line">
                      <td className="py-2 pe-2">{d.name}</td>
                      <td className="pe-2">{d.role ? t(`settings.mobile.roles.${d.role}`) : '—'}</td>
                      <td className="pe-2">{d.employeeName ?? '—'}</td>
                      <td className="pe-2">
                        {d.lastSeenAt ? formatDateTime(d.lastSeenAt, i18n.language) : t('settings.mobile.never')}
                        {d.lastSeenAt && d.lastSeenVia && <span className="text-muted"> · {t(d.lastSeenVia === 'remote' ? 'settings.mobile.lastSeenRemote' : 'settings.mobile.lastSeenLan')}</span>}
                      </td>
                      <td className="pe-2">
                        {d.revokedAt ? <Badge tone="danger">{t('settings.mobile.revoked')}</Badge> : d.role ? <Badge tone="ok">{t('settings.mobile.active')}</Badge> : <Badge>{t('settings.mobile.noRole')}</Badge>}
                      </td>
                      <td className="whitespace-nowrap text-end">
                        {!d.revokedAt && (
                          <>
                            <Button variant="ghost" icon={Pencil} onClick={() => setEditing(d)}>
                              {t('settings.mobile.edit')}
                            </Button>
                            <Button variant="ghost" icon={Trash2} onClick={() => setRevoking(d)}>
                              {t('settings.mobile.revoke')}
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Card>

      {pairing && <PairDialog remote={pairing === 'remote'} onClose={() => setPairing(null)} />}
      {getApp && <GetAppDialog urls={s.apkUrls} apk={s.apk} onClose={() => setGetApp(false)} />}
      {editing && <DeviceForm device={editing} title={t('settings.mobile.editTitle')} onClose={() => setEditing(null)} />}
      {revoking && (
        <ConfirmDialog
          title={t('settings.mobile.revokeTitle')}
          body={t('settings.mobile.revokeBody')}
          confirmLabel={t('settings.mobile.revoke')}
          busy={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking.id)}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}

/** Role, name and employee. Used right after pairing and when editing a device later. */
function DeviceForm({ device, title, hint, onClose }: { device: { id: string; name: string; role: MobileRole | null; employeeId: string | null }; title: string; hint?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const employees = useQuery({ queryKey: ['employees', 'list'], queryFn: () => api('employees.list') }).data ?? [];
  const [name, setName] = useState(device.name);
  const [role, setRole] = useState<MobileRole>(device.role ?? 'SELLER');
  const [employeeId, setEmployeeId] = useState(device.employeeId ?? '');
  const save = useAction(() => api('mobile.updateDevice', { id: device.id, name, role, employeeId: employeeId || null }), {
    success: t('common.saved'),
    invalidate: [['mobile']],
    onDone: onClose,
  });
  return (
    <Dialog title={title} hint={hint} onClose={onClose} onSubmit={() => name.trim() && save.mutate(undefined)} submitLabel={t('settings.mobile.save')} busy={save.isPending}>
      <div className="space-y-3">
        <Field label={t('settings.mobile.deviceName')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label={t('settings.mobile.role')} required>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as MobileRole)}>
            {MOBILE_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`settings.mobile.roles.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('settings.mobile.employee')}>
          <select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">{t('settings.mobile.noEmployee')}</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted">{t('settings.mobile.roleHelp')}</p>
      </div>
    </Dialog>
  );
}

interface Pairing {
  code: string;
  expiresAt: string;
  qr: unknown;
}

function PairDialog({ remote = false, onClose }: { remote?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [image, setImage] = useState('');
  const [left, setLeft] = useState(0);
  const [pairedId, setPairedId] = useState<string | null>(null);

  const start = useAction(() => (remote ? api('mobile.remotePairStart') : api('mobile.pairStart')), {
    onDone: (p) => {
      setPairing({ code: p.code, expiresAt: p.expiresAt, qr: 'qr' in p ? p.qr : null });
      if ('qr' in p) void QRCode.toDataURL(JSON.stringify(p.qr), { width: 320, margin: 1 }).then(setImage);
    },
  });
  useEffect(() => {
    start.mutate(undefined);
    return () => void api(remote ? 'mobile.remotePairCancel' : 'mobile.pairCancel');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown, and a check once a second for the phone having used the code.
  useEffect(() => {
    if (!pairing || pairedId) return;
    const tick = async () => {
      setLeft(Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)));
      try {
        const s = await api(remote ? 'mobile.remotePairStatus' : 'mobile.pairStatus');
        if (s.pairedDeviceId) setPairedId(s.pairedDeviceId);
      } catch {
        /* the dialog keeps working; the next tick tries again */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => clearInterval(timer);
  }, [pairing, pairedId, remote]);

  const devices = useQuery({ queryKey: ['mobile', 'devices'], queryFn: () => api('mobile.devices'), enabled: !!pairedId });
  const paired = devices.data?.find((d) => d.id === pairedId);
  if (pairedId) {
    if (!paired) return null;
    return <DeviceForm device={paired} title={t('settings.mobile.formTitle')} hint={t('settings.mobile.formHint')} onClose={() => { toast.ok(t('common.saved')); onClose(); }} />;
  }

  const expired = !!pairing && left === 0;
  return (
    <Dialog title={t(remote ? 'settings.mobile.remotePairTitle' : 'settings.mobile.pairTitle')} hint={t(remote ? 'settings.mobile.remotePairHint' : 'settings.mobile.pairHint')} onClose={onClose}>
      <div className="flex flex-col items-center gap-3">
        {!remote && <div className="flex h-80 w-80 items-center justify-center rounded-lg bg-white">{image && !expired ? <img src={image} alt="" className="h-80 w-80" /> : <span className="text-sm text-neutral-500">{expired ? t('settings.mobile.expired') : ''}</span>}</div>}
        <div dir="ltr" className={`font-mono font-bold ${remote ? 'text-2xl tracking-[0.15em]' : 'text-4xl tracking-[0.3em]'} ${expired ? 'opacity-30' : ''}`}>
          {pairing?.code ?? '······'}
        </div>
        <div className="text-sm text-muted">
          {expired ? t('settings.mobile.expired') : `${t('settings.mobile.expiresIn')} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}
        </div>
        <div className="text-sm text-muted">{t('settings.mobile.waiting')}</div>
        <Button icon={RefreshCw} disabled={start.isPending} onClick={() => start.mutate(undefined)}>
          {t('settings.mobile.newCode')}
        </Button>
      </div>
    </Dialog>
  );
}

/** "Get the app": a QR code for the PC's own download link, so a phone on the shop Wi-Fi installs the app without a cable. */
function GetAppDialog({ urls, apk, onClose }: { urls: string[]; apk: { versionName: string; size: number } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [image, setImage] = useState('');
  const url = urls[0];
  useEffect(() => {
    if (apk && url) void QRCode.toDataURL(url, { width: 320, margin: 1 }).then(setImage);
  }, [apk, url]);
  return (
    <Dialog title={t('settings.mobile.getAppTitle')} hint={t('settings.mobile.getAppHint')} onClose={onClose}>
      {!apk ? (
        <p className="text-sm text-danger">{t('settings.mobile.noApk')}</p>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-80 w-80 items-center justify-center rounded-lg bg-white">{image && <img src={image} alt="" className="h-80 w-80" />}</div>
          <ul dir="ltr" className="space-y-0.5 font-mono text-sm">
            {urls.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
          <div className="text-sm text-muted">
            {t('settings.mobile.apkVersion', { version: apk.versionName, mb: (apk.size / 1024 / 1024).toFixed(1) })}
          </div>
          <p className="text-center text-sm text-muted">{t('settings.mobile.getAppSteps')}</p>
        </div>
      )}
    </Dialog>
  );
}
