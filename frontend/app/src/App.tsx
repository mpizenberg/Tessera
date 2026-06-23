import type { ParentComponent } from "solid-js";
import { Route, Router } from "@solidjs/router";

import { AppProvider } from "~/state";
import { Header } from "~/ui/components/Header";
import { Explore } from "~/ui/screens/Explore";
import { Survey } from "~/ui/screens/Survey";
import { Respond } from "~/ui/screens/Respond";
import { Create } from "~/ui/screens/Create";
import { Settings } from "~/ui/screens/Settings";
import { BottomNav } from "~/ui/components/BottomNav";

const Layout: ParentComponent = (props) => (
  <AppProvider>
    <Header />
    {props.children}
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
      <Route path="/settings" component={Settings} />
    </Router>
  );
}
