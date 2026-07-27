/**
 * Shadow-root CSS delivery.
 *
 * A document-level stylesheet never penetrates a shadow root, and Vite's lib
 * build extracts imported CSS into a separate asset — so "just import the CSS"
 * silently styles nothing. Instead each sheet is imported **as a string** via
 * Vite's `?inline` suffix, concatenated once into a module-level
 * `CSSStyleSheet`, and adopted into every instance's shadow root — one parsed
 * sheet shared by all instances — with a `<style>`-element fallback where
 * constructed stylesheets are unavailable.
 */

import themeCss from "./theme.css?inline";
import respondCss from "./styles/respond.css?inline";

/** The widget's full stylesheet text (tokens on :host, then the component CSS). */
export const cssText = `${themeCss}\n${respondCss}`;

let shared: CSSStyleSheet | null = null;

/** The single constructed sheet, lazily built; null where unsupported. */
function sharedSheet(): CSSStyleSheet | null {
  if (shared) return shared;
  if (typeof CSSStyleSheet === "undefined") return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    shared = sheet;
    return sheet;
  } catch {
    return null;
  }
}

/**
 * Adopt the widget stylesheet into a shadow root. Uses the shared constructed
 * sheet when available (cheap — parsed once, shared by every instance), else
 * appends a `<style>` element as a fallback.
 *
 * Idempotent per root: component-register re-initializes the whole component
 * when a host moves the element in the DOM, but the shadow root (and whatever
 * it already adopted) survives — so guard against stacking duplicates.
 */
export function adoptWidgetStyles(root: ShadowRoot): void {
  const sheet = sharedSheet();
  if (sheet && "adoptedStyleSheets" in root) {
    if (!root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
  } else if (!root.querySelector("style[data-tessera-styles]")) {
    const style = document.createElement("style");
    style.setAttribute("data-tessera-styles", "");
    style.textContent = cssText;
    root.appendChild(style);
  }
}
