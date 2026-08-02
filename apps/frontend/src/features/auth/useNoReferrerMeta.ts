import { useEffect } from "react";

/**
 * Pose `<meta name="referrer" content="no-referrer" />` dans le `<head>`
 * pour la durée du mount. À utiliser sur les pages qui contiennent un
 * token en URL sensible (`/reset-password?token=…`, `/verify-email?token=…`) —
 * sans ça, le navigateur envoie le `Referer` complet au prochain fetch
 * (analytics/CDN/tiers image) → **fuite du token**.
 *
 * Le meta pré-existant (`no-referrer-when-downgrade` par défaut sur SPA)
 * est **remplacé** temporairement, puis restauré au unmount. Idempotent
 * si le composant re-render.
 */
export function useNoReferrerMeta(): void {
	useEffect(() => {
		if (typeof document === "undefined") return;
		const existing = document.querySelector<HTMLMetaElement>(
			'meta[name="referrer"]'
		);
		const previous = existing?.getAttribute("content") ?? null;

		let meta = existing;
		if (meta === null) {
			meta = document.createElement("meta");
			meta.setAttribute("name", "referrer");
			document.head.appendChild(meta);
		}
		meta.setAttribute("content", "no-referrer");
		const createdByUs = existing === null;
		const metaEl = meta;
		return () => {
			if (createdByUs) {
				metaEl.remove();
			} else if (previous !== null) {
				metaEl.setAttribute("content", previous);
			}
		};
	}, []);
}
