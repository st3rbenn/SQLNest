/** Ease cubique in-out (t ∈ [0, 1]). */
export function cubicInOut(t: number): number {
	const u = t * 2;
	return (u <= 1 ? u * u * u : (u - 2) * (u - 2) * (u - 2) + 2) / 2;
}

/** Vue = [centre x, centre y, largeur visible] en coordonnées du flow. */
export type View = [number, number, number];

const RHO = Math.SQRT2;
const RHO2 = 2;
const RHO4 = 4;
const EPSILON2 = 1e-12;

/**
 * Interpolation « smooth zoom & pan » de van Wijk & Nuij (2003) : la
 * trajectoire dézoome en chemin quand le déplacement est grand devant la
 * largeur visible, au lieu de translater à zoom constant.
 */
export function interpolateZoom(from: View, to: View): (t: number) => View {
	const [ux0, uy0, w0] = from;
	const [ux1, uy1, w1] = to;
	const dx = ux1 - ux0;
	const dy = uy1 - uy0;
	const d2 = dx * dx + dy * dy;

	if (d2 < EPSILON2) {
		const s = Math.log(w1 / w0) / RHO;
		return (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(RHO * t * s)];
	}

	const d1 = Math.sqrt(d2);
	const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1);
	const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
	const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
	const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
	const s = (r1 - r0) / RHO;
	const coshR0 = Math.cosh(r0);
	const sinhR0 = Math.sinh(r0);
	return (t) => {
		const ts = t * s;
		const u = (w0 / (RHO2 * d1)) * (coshR0 * Math.tanh(RHO * ts + r0) - sinhR0);
		return [
			ux0 + u * dx,
			uy0 + u * dy,
			(w0 * coshR0) / Math.cosh(RHO * ts + r0)
		];
	};
}
