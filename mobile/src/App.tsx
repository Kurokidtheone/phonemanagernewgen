import { App as CapApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getState, init, reconnect, setInstalledBuild, useConnection } from '@/lib/connection';
import { loadCart } from '@/lib/cartStore';
import { loadDraft } from '@/lib/draftStore';
import { ScanScreen } from '@/components/ScanScreen';
import { useScanning } from '@/lib/scanner';
import { applyLanguage } from '@/i18n';
import { LanguageScreen, PairScreen } from '@/screens/Onboarding';
import { Shell } from '@/screens/Shell';
import { ModeScreen } from '@/screens/Mode';
import { PinScreen } from '@/screens/Pin';
import { OfflineScreen, UpdateScreen, WaitingScreen } from '@/screens/Status';
import { initPin, usePinStatus } from '@/lib/pin';

// Outside the shop data is considered fresh for longer, to spare mobile data.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: () => (getState().route === 'remote' ? 10_000 : 5000) } } });

function Router() {
  const { phase, language, mode } = useConnection();
  const [ready, setReady] = useState(false);
  const scanning = useScanning();
  const pin = usePinStatus();

  useEffect(() => {
    void CapApp.getInfo().then((info) => setInstalledBuild(Number(info.build))).catch(() => undefined);
    void loadDraft();
    void loadCart();
    void init()
      .then(() => initPin(getState().session !== null))
      .finally(() => setReady(true));
    // Coming back to the app, or the Wi-Fi coming back, re-checks the PC.
    const resume = CapApp.addListener('resume', () => void reconnect());
    const net = Network.addListener('networkStatusChange', (s) => s.connected && void reconnect());
    return () => {
      void resume.then((h) => h.remove());
      void net.then((h) => h.remove());
    };
  }, []);
  useEffect(() => {
    if (language) applyLanguage(language);
  }, [language]);

  if (!ready || phase === 'booting')
    return (
      <div className="flex h-full items-center justify-center bg-paper">
        <Loader2 className="h-8 w-8 animate-spin text-muted" />
      </div>
    );

  // A paired phone holds the shop's data: nothing shows before the PIN.
  if (phase !== 'unpaired' && (pin === 'locked' || pin === 'needs_set')) return <PinScreen />;

  return (
    <>
      {phase === 'unpaired' && (!language ? <LanguageScreen /> : mode === null ? <ModeScreen /> : <PairScreen />)}
      {phase === 'waiting' && <WaitingScreen />}
      {phase === 'offline' && <OfflineScreen />}
      {phase === 'update_app' && <UpdateScreen side="app" />}
      {phase === 'update_pc' && <UpdateScreen side="pc" />}
      {phase === 'connected' && <Shell />}
      {scanning && <ScanScreen />}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={client}>
      <Router />
    </QueryClientProvider>
  );
}
