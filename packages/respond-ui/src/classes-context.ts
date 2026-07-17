/**
 * Solid context carrying the class-name map the body components render with.
 *
 * The two consumers style the same markup differently: the widget's shadow DOM
 * uses the literal class names (styled by its adopted stylesheet), while the
 * app looks the same names up in its CSS module. The context defaults to the
 * identity map, so the widget needs no provider; the app provides its module's
 * classes once around the question list.
 */

import { createContext, useContext } from "solid-js";

/** Every class name the body components render. */
export const BODY_CLASS_NAMES = [
  // single choice
  "optionGroup",
  "optionRow",
  "optionRowOn",
  "radio",
  "radioOn",
  "radioDot",
  // multi select
  "multiGrid",
  "checkbox",
  "checkboxOn",
  "multiCount",
  "noneNote",
  "noneNoteText",
  "noneNoteLead",
  // ranking
  "rankedList",
  "rankedRow",
  "rankNum",
  "rankLabel",
  "rankBtn",
  "rankBtnDanger",
  "rankPoolHint",
  "rankPool",
  "poolBtn",
  "poolBtnDisabled",
  // numeric range
  "numHero",
  "numValue",
  "numberInput",
  "rangeFull",
  "rangeBounds",
  // points allocation
  "pointsHeader",
  "pointsRemainLabel",
  "pointsRemain",
  "pointsRemainDone",
  "pointsRow",
  "pointsRowHead",
  "pointsOptLabel",
  "pointsControls",
  "stepBtn",
  "pointsInput",
  "rangeFullBlock",
  "pointsFooter",
  // rating
  "ratingList",
  "ratingRow",
  "ratingOptLabel",
  "ratingNumberInput",
  "ratingLevels",
  "ratingBtn",
  "ratingBtnOn",
  "ratHint",
  // custom
  "customSchema",
  "customSchemaTag",
  "customSchemaUri",
  "customInput",
  "customHint",
] as const;

export type BodyClassName = (typeof BODY_CLASS_NAMES)[number];

/** Maps each body class name to the string rendered into `class=`. */
export type BodyClasses = Record<BodyClassName, string>;

/** Identity: literal names, as the widget's shadow-scoped stylesheet expects. */
export const IDENTITY_CLASSES: BodyClasses = Object.fromEntries(
  BODY_CLASS_NAMES.map((name) => [name, name]),
) as BodyClasses;

export const ClassesContext = createContext<BodyClasses>(IDENTITY_CLASSES);

export function useClasses(): BodyClasses {
  return useContext(ClassesContext);
}
