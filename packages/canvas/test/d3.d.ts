declare module "d3-ease" {
	export function easeCubicInOut(t: number): number;
}
declare module "d3-interpolate" {
	export function interpolateZoom(
		a: [number, number, number],
		b: [number, number, number]
	): (t: number) => [number, number, number];
}
