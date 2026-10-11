import { Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode, type TouchEvent } from 'react';

/** A row that is removed by swiping it sideways (either direction), with a delete button as the other way. */
export function SwipeRow({ children, onRemove, label }: { children: ReactNode; onRemove: () => void; label: string }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  const THRESHOLD = 90;
  const down = (e: TouchEvent): void => {
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const move = (e: TouchEvent): void => {
    if (!start.current) return;
    const x = e.touches[0].clientX - start.current.x;
    const y = e.touches[0].clientY - start.current.y;
    if (Math.abs(y) > Math.abs(x)) return; // a scroll, not a swipe
    setDx(x);
  };
  const up = (): void => {
    const far = Math.abs(dx) >= THRESHOLD;
    start.current = null;
    setDx(0);
    if (far) onRemove();
  };
  return (
    <div className="relative grid overflow-hidden border-b border-line bg-danger/20">
      <div className="col-start-1 row-start-1 flex items-center justify-between px-5 text-danger">
        <Trash2 className="h-6 w-6" />
        <Trash2 className="h-6 w-6" />
      </div>
      <div className="col-start-1 row-start-1 flex items-stretch bg-card transition-transform" style={{ transform: `translateX(${dx}px)`, transitionDuration: dx === 0 ? '150ms' : '0ms' }} onTouchStart={down} onTouchMove={move} onTouchEnd={up}>
        <div className="min-w-0 flex-1">{children}</div>
        <button className="flex w-14 shrink-0 items-center justify-center text-muted" aria-label={label} onClick={onRemove}>
          <Trash2 className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
