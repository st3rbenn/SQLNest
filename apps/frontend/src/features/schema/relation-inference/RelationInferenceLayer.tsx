import { ActionIcon, Box, Group, Paper, ScrollArea, Text } from "@mantine/core";
import { Button } from "@sqlnest/design-system";
import { IconLink, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useCanvasData, useCanvasUI } from "../canvas/CanvasContext";
import { CanvasSidePanel } from "../canvas/floating/CanvasSidePanel";
import { type CandidateAnchor, detectRelationCandidates } from "./candidates";

/**
 * Couche d'inférence guidée (LR/1) — sur une base SANS FK, propose de
 * configurer les liens à partir des hubs détectés dans le catalogue.
 *
 * LR/1 = détection + découverte : une bannière à l'arrivée, un panneau qui
 * liste les candidats triés par impact avec leur table de référence
 * suggérée (pré-tri). La CONFIRMATION (dropdown de référence → edges
 * persistés) arrive en LR/2 — ici tout est en lecture seule.
 */

/** Couleur d'un badge d'ancrage — reprend le code couleur des edges canvas. */
const ANCHOR_META: Record<
	CandidateAnchor,
	{ label: string; color: string }
> = {
	// Bleu accent = FK déclarée sur le canvas → même code pour « certain (PK) ».
	"primary-key": { label: "PK", color: "#0d99ff" },
	// Jaune = inféré, comme les edges heuristiques.
	name: { label: "nom", color: "#ffc933" },
	"co-occurrence": { label: "co-occ.", color: "var(--sqlnest-text-secondary)" }
};

/**
 * Impact minimum (tables porteuses) pour qu'un candidat s'affiche par défaut.
 * Cache la longue traîne de hubs faibles/spéculatifs (préfixe seul) : le
 * panneau montre les vrais hubs, un « voir tout » révèle le reste.
 */
const PANEL_MIN_IMPACT = 5;

export function RelationInferenceLayer() {
	const { schema } = useCanvasData();
	// Une seule détection : `offer` en dérive (évite un double calcul sur 445
	// tables). Même condition que `shouldOfferInference`.
	const candidates = useMemo(
		() =>
			schema.relations.length === 0 && schema.collections.length >= 2
				? detectRelationCandidates(schema)
				: [],
		[schema]
	);
	const offer = candidates.length > 0;
	const { inferencePanelOpen: panelOpen, setInferencePanelOpen: setPanelOpen } =
		useCanvasUI();
	const [dismissed, setDismissed] = useState(false);
	const [showAll, setShowAll] = useState(false);

	// Borne haute des liens couverts : somme des edges par candidat (référence
	// exclue). Les candidats peuvent se recouvrir → « jusqu'à ».
	const totalLinks = useMemo(
		() => candidates.reduce((n, c) => n + Math.max(0, c.carriers.length - 1), 0),
		[candidates]
	);

	// Candidats forts (au-dessus du seuil d'impact). Si trop peu passent le
	// seuil (petite base), on montre tout — un panneau quasi vide serait pire.
	const strong = useMemo(
		() => candidates.filter((c) => c.carriers.length >= PANEL_MIN_IMPACT),
		[candidates]
	);
	// Le seuil ne replie que s'il reste assez de candidats forts.
	const collapsible = strong.length >= 5 && strong.length < candidates.length;
	const useThreshold = collapsible && !showAll;
	const visible = useThreshold ? strong : candidates;
	const hiddenCount = candidates.length - strong.length;

	if (!offer) return null;

	return (
		<>
			{!panelOpen && !dismissed ? (
				<Box
					style={{
						position: "absolute",
						left: "50%",
						transform: "translateX(-50%)",
						top: 12,
						zIndex: 7,
						// Centré par `left: 50%`, le bandeau ne disposerait que de la
						// moitié du canvas : il prend sa largeur, bornée au canvas.
						width: "max-content",
						maxWidth: "calc(100% - 24px)"
					}}
				>
					<Paper
						radius="xl"
						shadow="md"
						withBorder
						px="sm"
						py={6}
						bg="var(--sqlnest-surface)"
						style={{ borderColor: "var(--sqlnest-border)" }}
					>
						<Group gap={10} wrap="nowrap">
							<Text size="xs" style={{ color: "var(--sqlnest-text-secondary)" }}>
								Aucune relation détectée · {candidates.length} clés de jointure
								probables
							</Text>
							<Button
								size="xs"
								variant="primary"
								style={{ flexShrink: 0 }}
								onClick={() => setPanelOpen(true)}
							>
								Inférer les liens
							</Button>
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								aria-label="Ignorer"
								onClick={() => setDismissed(true)}
							>
								<IconX size={14} />
							</ActionIcon>
						</Group>
					</Paper>
				</Box>
			) : null}

			{panelOpen ? (
				<CanvasSidePanel
					icon={<IconLink size={15} color="var(--sqlnest-text-secondary)" />}
					title="Liens à inférer"
					onClose={() => setPanelOpen(false)}
					{...(collapsible
						? {
								footer: (
									<Text
										component="button"
										size="xs"
										onClick={() => setShowAll((v) => !v)}
										style={{
											color: "var(--sqlnest-accent)",
											background: "none",
											border: "none",
											cursor: "pointer",
											padding: 0
										}}
									>
										{useThreshold
											? `voir tout (${hiddenCount} de plus)`
											: "voir moins"}
									</Text>
								)
							}
						: {})}
				>
					<Text
						size="xs"
						px="md"
						pt="xs"
						style={{ color: "var(--sqlnest-text-secondary)" }}
					>
						{candidates.length} clés partagées · jusqu'à {totalLinks} liens
					</Text>

					<ScrollArea style={{ flex: 1 }} px="xs" py="xs">
						{visible.map((c) => {
							const meta = ANCHOR_META[c.anchor];
							const links = Math.max(0, c.carriers.length - 1);
							return (
								<Box
									key={c.id}
									px="sm"
									py={8}
									style={{
										borderRadius: "var(--sqlnest-radius-8)",
										marginBottom: 4
									}}
								>
									<Group gap={6} wrap="nowrap" justify="space-between">
										<Text
											size="xs"
											ff="monospace"
											style={{
												color: "var(--sqlnest-text-primary)",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap"
											}}
											title={c.columns.join(" + ")}
										>
											{c.columns.join(" + ")}
										</Text>
										<Text
											size="10px"
											fw={600}
											style={{
												color: meta.color,
												flexShrink: 0,
												textTransform: "uppercase",
												letterSpacing: 0.4
											}}
										>
											{meta.label}
										</Text>
									</Group>
									<Group gap={6} wrap="nowrap" mt={3}>
										<Text
											size="xs"
											style={{ color: "var(--sqlnest-text-secondary)" }}
										>
											{c.carriers.length} tables → {links} liens
										</Text>
										<Text size="xs" style={{ color: "var(--sqlnest-border)" }}>
											·
										</Text>
										<Text
											size="xs"
											ff="monospace"
											style={{
												color: "var(--sqlnest-text-secondary)",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap"
											}}
											title={c.suggestedReference}
										>
											réf. {c.suggestedReference}
										</Text>
									</Group>
								</Box>
							);
						})}
					</ScrollArea>
				</CanvasSidePanel>
			) : null}
		</>
	);
}
