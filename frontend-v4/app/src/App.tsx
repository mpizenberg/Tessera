import type { ParentComponent } from "solid-js";
import { Route, Router } from "@solidjs/router";

import { AppProvider } from "~/state";
import { Header } from "~/ui/components/Header";
import { Explore } from "~/ui/screens/Explore";
import { Survey } from "~/ui/screens/Survey";
import { Respond } from "~/ui/screens/Respond";
import { Create } from "~/ui/screens/Create";
import { Placeholder } from "~/ui/screens/Placeholder";

const Layout: ParentComponent = (props) => (
  <AppProvider>
    <Header />
    {props.children}
  </AppProvider>
);

const SettingsScreen = () => (
  <Placeholder
    title="Settings"
    note="Network, Koios endpoint, and wallet settings will live here."
  />
);

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={Explore} />
      <Route path="/survey/:key" component={Survey} />
      <Route path="/survey/:key/respond" component={Respond} />
      <Route path="/create" component={Create} />
      <Route path="/settings" component={SettingsScreen} />
    </Router>
  );
}
