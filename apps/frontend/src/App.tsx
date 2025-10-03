import { Button } from "@sqlnest/design-system";
import { useState } from "react";
import "@sqlnest/design-system/dist/design-system.css";

function App() {
	const [count, setCount] = useState(0);

	return (
		<>
			<h1>SQLNest</h1>
			<Button onClick={() => setCount((count) => count + 1)} variant="danger">
				count is {count}
			</Button>
		</>
	);
}

export default App;
