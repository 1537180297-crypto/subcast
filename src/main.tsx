import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Never leave a blank window: show startup failures.
const showFatal = (msg: string) => {
  const el = document.createElement("pre");
  el.style.cssText = "position:fixed;left:0;right:0;bottom:0;margin:0;padding:12px;background:#b42318;color:#fff;font:12px monospace;white-space:pre-wrap;z-index:99";
  el.textContent = msg;
  document.body.appendChild(el);
};
window.addEventListener("error", (e) => showFatal(String(e.error?.stack ?? e.message)));
window.addEventListener("unhandledrejection", (e) => showFatal(String((e.reason as Error)?.stack ?? e.reason)));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
