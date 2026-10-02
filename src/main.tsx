import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import { AppStateProvider } from "./state/appState";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The application root element is missing.");
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary><AppStateProvider><RouterProvider router={router} /></AppStateProvider></ErrorBoundary>
  </React.StrictMode>,
);
