import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { DesignSystemProvider } from "@sqlnest/design-system";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<DesignSystemProvider>
			<App />
		</DesignSystemProvider>
	</StrictMode>,
);
