import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "../features/auth/SignupPage";

export const Route = createFileRoute("/_auth/signup")({
	component: SignupPage
});
