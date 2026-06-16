import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
// The Technical Umber theme. Imported only here (the app entry), never from
// App.tsx, so unit tests run unstyled while the shipped app is fully themed.
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
