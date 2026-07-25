import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import PopoutTerminal from "./components/PopoutTerminal.jsx";
import { ThemeProvider } from "./hooks/useTheme";
import ErrorBoundary from "./components/ErrorBoundary";
import { ModelCatalogProvider } from "./modelCatalog";

const params = new URLSearchParams(window.location.search);
const popoutTerminalId = params.get("popout");
const popoutName = params.get("name") || "Terminal";
const popoutModel = params.get("model") || "";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <ModelCatalogProvider>
          {popoutTerminalId ? (
            <PopoutTerminal
              terminalId={popoutTerminalId}
              name={popoutName}
              model={popoutModel}
            />
          ) : (
            <App />
          )}
        </ModelCatalogProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
);
