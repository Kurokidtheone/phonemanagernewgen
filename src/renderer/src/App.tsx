import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { SECTIONS, type SectionId } from "@shared/app.config";
import { QR_TOKEN_PATTERN } from "@shared/schemas";
import { BottomBar } from "./components/BottomBar";
import { CommandPalette } from "./components/CommandPalette";
import { Guard } from "./components/Guard";
import { LicenseBanner } from "./components/LicenseBanner";
import { PrintBridge } from "./components/PrintBridge";
import { SetupWizard } from "./components/SetupWizard";
import { Toaster } from "./components/Toaster";
import { api, errorText } from "./lib/api";
import { useScanner, useSettings } from "./lib/hooks";
import { toast } from "./lib/toast";
const Finance = lazy(() =>
  import("./pages/Finance").then((m) => ({ default: m.Finance })),
);
const Overview = lazy(() =>
  import("./pages/Overview").then((m) => ({ default: m.Overview })),
);
const CustomerPage = lazy(() =>
  import("./pages/people/CustomerPage").then((m) => ({
    default: m.CustomerPage,
  })),
);
const EmployeePage = lazy(() =>
  import("./pages/people/EmployeePage").then((m) => ({
    default: m.EmployeePage,
  })),
);
const People = lazy(() =>
  import("./pages/people/People").then((m) => ({ default: m.People })),
);
const RepairPage = lazy(() =>
  import("./pages/repairs/RepairPage").then((m) => ({ default: m.RepairPage })),
);
const Repairs = lazy(() =>
  import("./pages/repairs/Repairs").then((m) => ({ default: m.Repairs })),
);
const Sell = lazy(() =>
  import("./pages/sell/Sell").then((m) => ({ default: m.Sell })),
);
const SalePage = lazy(() =>
  import("./pages/sell/SalePage").then((m) => ({ default: m.SalePage })),
);
const Settings = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.Settings })),
);
const Stock = lazy(() =>
  import("./pages/stock/Stock").then((m) => ({ default: m.Stock })),
);
const NewPurchasePage = lazy(() =>
  import("./pages/stock/NewPurchasePage").then((m) => ({
    default: m.NewPurchasePage,
  })),
);
const SupplierPage = lazy(() =>
  import("./pages/stock/SupplierPage").then((m) => ({
    default: m.SupplierPage,
  })),
);
const UnitPage = lazy(() =>
  import("./pages/stock/UnitPage").then((m) => ({ default: m.UnitPage })),
);

// One page per section id. Replace a Placeholder with the real page as each phase builds it.
// For sub-pages, add more <Route> lines below (for example /stock/phones/:id).
const PAGES: Record<SectionId, JSX.Element> = {
  overview: <Overview />,
  sell: <Sell />,
  stock: <Stock />,
  repairs: <Repairs />,
  people: <People />,
  finance: <Finance />,
  settings: <Settings />,
};

/** Applies language, text direction and theme from settings to the whole document. */
function useAppearance(): void {
  const { i18n } = useTranslation();
  const settings = useSettings().data;
  useEffect(() => {
    if (!settings) return;
    void i18n.changeLanguage(settings.language);
    document.documentElement.lang = settings.language;
    document.documentElement.dir = settings.language === "ar" ? "rtl" : "ltr";
  }, [settings, i18n]);
  useEffect(() => {
    if (!settings) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark =
        settings.theme === "dark" ||
        (settings.theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings]);
}

/** Scanning an intake slip's QR code opens that ticket, wherever the user is. */
function useTicketScanner(): void {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useScanner((code) => {
    if (
      !QR_TOKEN_PATTERN.test(code) ||
      document.querySelector('[role="dialog"]')
    )
      return;
    api("repairs.byToken", { token: code })
      .then((found) =>
        found
          ? navigate(`/repairs/${found.id}`)
          : toast.error(t("repairs.unknownTicket")),
      )
      .catch((err) => toast.error(errorText(t, err)));
  });
}

function Shell() {
  useTicketScanner();
  const settings = useSettings().data;
  const { pathname } = useLocation();
  const section =
    [...SECTIONS]
      .reverse()
      .find((s) => pathname === s.path || pathname.startsWith(`${s.path}/`)) ??
    SECTIONS[0];
  return (
    <div className="flex h-full flex-col" data-accent={section.accent}>
      <LicenseBanner />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={null}>
          <Routes>
            {SECTIONS.map((s) => (
              <Route
                key={s.id}
                path={s.path}
                element={
                  s.lockable ? (
                    <Guard section={s.id}>{PAGES[s.id]}</Guard>
                  ) : (
                    PAGES[s.id]
                  )
                }
              />
            ))}
            <Route
              path="/stock/phones/:id"
              element={
                <Guard section="stock">
                  <UnitPage />
                </Guard>
              }
            />
            <Route
              path="/stock/purchases/new"
              element={
                <Guard section="stock">
                  <NewPurchasePage />
                </Guard>
              }
            />
            <Route
              path="/stock/suppliers/:id"
              element={
                <Guard section="stock">
                  <SupplierPage />
                </Guard>
              }
            />
            <Route
              path="/sell/sales/:id"
              element={
                <Guard section="sell">
                  <SalePage />
                </Guard>
              }
            />
            <Route
              path="/people/customers/:id"
              element={
                <Guard section="people">
                  <CustomerPage />
                </Guard>
              }
            />
            <Route
              path="/repairs/:id"
              element={
                <Guard section="repairs">
                  <RepairPage />
                </Guard>
              }
            />
            <Route
              path="/people/employees/:id"
              element={
                <Guard section="people">
                  <EmployeePage />
                </Guard>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      <BottomBar />
      <CommandPalette />
      {settings && !settings.setupDone && (
        <SetupWizard language={settings.language} />
      )}
      <PrintBridge />
      <Toaster />
    </div>
  );
}

export function App() {
  useAppearance();
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
