// Photos of a repair: taken with the camera (shrunk and uploaded at once) and shown from the PC.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_REPAIR_PHOTOS } from '@shared/schemas';
import { Button } from '@/components/ui';
import { errorText, fetchPhoto, uploadImage } from '@/lib/api';
import { useConnection } from '@/lib/connection';
import { prepareImage } from '@/lib/photo';
import { toast } from '@/lib/toast';

/** A photo stored on the PC, fetched with the token. */
export function Photo({ name, className }: { name: string; className?: string }) {
  const { t } = useTranslation();
  const route = useConnection().route;
  const client = useQueryClient();
  const [wanted, setWanted] = useState(false);
  // Outside the shop a photo costs mobile data: it loads only when it is opened (tapped), or if it is already on the phone.
  const enabled = route !== 'remote' || wanted || client.getQueryData(['photo', name]) !== undefined;
  const photo = useQuery({ queryKey: ['photo', name], queryFn: () => fetchPhoto(name), staleTime: Infinity, gcTime: 600_000, enabled });
  if (photo.data) return <img src={photo.data} alt="" className={className} />;
  if (!enabled) {
    return (
      <button className={`${className ?? ''} flex items-center justify-center bg-line p-2 text-center text-xs text-muted`} onClick={() => setWanted(true)}>
        {t('m.remote.tapPhoto')}
      </button>
    );
  }
  return <div className={`${className ?? ''} animate-pulse bg-line`} />;
}

/** Takes up to six photos; each one is uploaded as soon as it is taken. `names` are the files already on the PC. */
export function PhotoCapture({ names, onAdd, onRemove }: { names: string[]; onAdd: (name: string) => Promise<void> | void; onRemove?: (name: string) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const full = names.length >= MAX_REPAIR_PHOTOS;

  const take = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      const { base64, contentType } = await prepareImage(file); // 1600 px on the long side
      await onAdd(await uploadImage(base64, contentType));
    } catch (err) {
      const text = errorText(t, err);
      toast(text === t('errors.unexpected') ? t('m.rep.photoFailed') : text);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div>
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void take(e.target.files?.[0])} />
      <div className="grid grid-cols-3 gap-2">
        {names.map((n) => (
          <div key={n} className="relative">
            <Photo name={n} className="aspect-square w-full rounded-xl object-cover" />
            {onRemove && (
              <button className="absolute end-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white" aria-label={t('m.receive.remove')} onClick={() => onRemove(n)}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
      <Button icon={Camera} className="mt-2 w-full" busy={busy} disabled={full} onClick={() => input.current?.click()}>
        {t('m.rep.addPhoto')} · {t('m.rep.photoCount', { n: names.length, max: MAX_REPAIR_PHOTOS })}
      </Button>
    </div>
  );
}
