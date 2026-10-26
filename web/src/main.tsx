import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./index.css";

// Focus rings follow the keyboard (v1.2 review): <html data-kbd> while the last input was a key press,
// so programmatic focus at load and pointer use don't paint rings. Text fields keep theirs.
const root = document.documentElement;
addEventListener("keydown", () => root.setAttribute("data-kbd", ""), true);
addEventListener("pointerdown", () => root.removeAttribute("data-kbd"), true);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
