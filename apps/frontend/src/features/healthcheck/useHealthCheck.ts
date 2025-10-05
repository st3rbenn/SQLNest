import { useQuery } from "@tanstack/react-query"
import { $api } from "../../api"


const GetUseHealthCheckQueryOptions = () =>
  $api.queryOptions("get", "/health")


export const useHealthCheck = () => {
  const { data, error, isLoading } = useQuery({
    ...GetUseHealthCheckQueryOptions(),
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  })
  
  return { data, error, isLoading }

}