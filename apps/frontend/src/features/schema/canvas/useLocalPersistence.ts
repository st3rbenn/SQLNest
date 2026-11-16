import { useEffect, useMemo } from "react";
import { useCurrentUser } from "../../auth/sessionQuery";
import { purgeSchemaSlices } from "../../storage/localStore";

/**
 * Où vit l'état du canvas : sur le serveur quand un compte est connecté
 * (hydraté par `useCanvasSync`), dans le stockage local sinon. Connecté, le
 * stockage local ne ferait que réinjecter un état périmé à la prochaine
 * déconnexion ou sous un autre compte : ses tranches sont retirées.
 */
export function useLocalPersistence(): { readonly persistLocal: boolean } {
	const { data: session } = useCurrentUser();
	const persistLocal = session?.user == null;
	useEffect(() => {
		if (!persistLocal) purgeSchemaSlices();
	}, [persistLocal]);
	return useMemo(() => ({ persistLocal }), [persistLocal]);
}
