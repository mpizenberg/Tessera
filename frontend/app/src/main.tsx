/* @refresh reload */
import { render } from "solid-js/web";

import "~/ui/theme.css";
import App from "~/App";

const root = document.getElementById("root");
if (!root) throw new Error('missing <div id="root">');

render(() => <App />, root);
