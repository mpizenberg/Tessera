import { ErrorBoundary, lazy, type ParentComponent } from "solid-js";
import { Route, Router } from "@solidjs/router";

import { AppProvider } from "~/state";
import { DirectModeBanner } from "~/ui/components/DirectModeBanner";
import { Header } from "~/ui/components/Header";
import { LoadError } from "~/ui/components/LoadError";
import { Explore } from "~/ui/screens/Explore";
import { Survey } from "~/ui/screens/Survey";
import { Respond } from "~/ui/screens/Respond";
import { Create } from "~/ui/screens/Create";
import { Settings } from "~/ui/screens/Settings";
import { ProposeInfoAction } from "~/ui/screens/ProposeInfoAction";
import { BottomNav } from "~/ui/components/BottomNav";

// Dev-only reference host for the embeddable `<tessera-respond>` widget.
// Lazily loaded behind the `import.meta.env.DEV` guard below so
// its second copy of the answering UI (and the whole widget bundle) is
// dead-code-eliminated from production builds.
const DevWidgetHost = import.meta.env.DEV
  ? lazy(() => import("~/ui/screens/DevWidgetHost"))
  : undefined;

const Layout: ParentComponent = (props) => (
  <AppProvider>
    <Header />
    <DirectModeBanner />
    {/* Last-resort safety net: a screen reading the snapshot accessor while it
        is in error state throws (Solid resource semantics). Without a boundary
        that surfaces as an uncaught rejection; here it becomes a recoverable
        error screen. Header/BottomNav stay outside it so navigation survives. */}
    <ErrorBoundary
      fallback={(err, reset) => <LoadError err={err} reset={reset} />}
    >
      {props.children}
    </ErrorBoundary>
    <BottomNav />
  </AppProvider>
);

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={Explore} />
      <Route path="/survey/:key" component={Survey} />
      <Route path="/survey/:key/respond" component={Respond} />
      <Route path="/create" component={Create} />
      <Route path="/propose-info-action" component={ProposeInfoAction} />
      <Route path="/settings" component={Settings} />
      {import.meta.env.DEV && DevWidgetHost && (
        <Route path="/dev/widget/:key" component={DevWidgetHost} />
      )}
    </Router>
  );
}
