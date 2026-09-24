import React from "react";
import ReactDOM from "react-dom/client";
import { GlobalContextProviders } from "./components/_globalContextProviders";
import { App } from "./App";
import "./base.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GlobalContextProviders>
      <App />
    </GlobalContextProviders>
  </React.StrictMode>
);
