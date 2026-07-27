import { QueryClient } from "@tanstack/react-query";
import createFetchClient from "openapi-fetch";
import createClient from "openapi-react-query";
import type { paths } from "../generated/api.schema";

const fetchClient = createFetchClient<paths>({
	baseUrl: window.CONTEXT.apiBaseUrl
});
export const $api = createClient(fetchClient);
// REACT QUERY CLIENT
export const queryClient = new QueryClient();
