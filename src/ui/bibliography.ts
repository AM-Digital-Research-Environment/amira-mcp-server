import type { AppView } from "./shell.js";
const CSS = "input[type=checkbox] { accent-color: var(--bar); min-height: 24px; width: 24px; } th:first-child { width: 50px; } th:last-child { width: 52px; } td:last-child, th { white-space: nowrap; }";
export const BIBLIOGRAPHY_VIEW: AppView = { name: "bibliography", title: "AMIRA — cluster bibliography", css: CSS, file: "bibliography.js" };
