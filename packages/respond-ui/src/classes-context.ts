/**
 * Solid context carrying the class-name map respond-ui's components render
 * with: the question card, its bodies, the finish line and confirmation, and
 * the progress squares.
 *
 * `body.css` styles them for both consumers: the widget's shadow DOM uses the
 * literal class names, while the app looks the same names up in a CSS module
 * that imports it. The context defaults to the identity map, so the widget needs no
 * provider; the app provides the module's classes once around the question
 * list.
 */

import { createContext, useContext, type Context } from "solid-js";

/** Every class name respond-ui's components render. */
export const BODY_CLASS_NAMES = [
  // question card
  "card",
  "qHead",
  "qHeadLeft",
  "qChip",
  "qType",
  "qRequired",
  "skipBtn",
  "skipBtnOn",
  "qPrompt",
  "qSkipped",
  "qBody",
  // shortcut keys: a card that takes them, and an option's letter
  "keysOn",
  "keyBadge",
  // the native input under a choice row or a rating level
  "choiceInput",
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
  "rangeUnset",
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
  "customBytes",
  "customBytesOver",
  "customHint",
  // what is left before finishing, beside the submit button
  "leftNote",
  "leftGroup",
  "leftCall",
  "qLink",
  // the confirmation that skips the questions left unanswered
  "skipConfirm",
  "skipConfirmText",
  "skipConfirmActions",
  "goToBtn",
  "skipFinishBtn",
  // the progress squares, one per question; their layout comes with them
  "sq",
  "sqUnseen",
  "sqPassed",
  "sqAnswered",
  "sqSkipped",
  "sqUnfinished",
  "sqHidden",
  // a number of three digits
  "sqLong",
] as const;

export type BodyClassName = (typeof BODY_CLASS_NAMES)[number];

/** Maps each body class name to the string rendered into `class=`. */
export type BodyClasses = Record<BodyClassName, string>;

/** Identity: literal names, as the widget's shadow-scoped stylesheet expects. */
export const IDENTITY_CLASSES: BodyClasses = Object.fromEntries(
  BODY_CLASS_NAMES.map((name) => [name, name]),
) as BodyClasses;

export const ClassesContext: Context<BodyClasses> =
  createContext<BodyClasses>(IDENTITY_CLASSES);

export function useClasses(): BodyClasses {
  return useContext(ClassesContext);
}
