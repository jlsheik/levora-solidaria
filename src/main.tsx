import "./zodBrowserConfig";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./base.css";

// GlobalContextProviders foi movido para dentro do roteador (ver App.tsx)
// porque um dos providers precisa de contexto de rota (useLocation).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
