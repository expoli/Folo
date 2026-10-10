import { fetchLocalAIConfig } from "@follow/store/ai-local/client"
import { useQuery } from "@tanstack/react-query"

import { followApi } from "~/lib/api-client"
import { useLocalAIConfig } from "~/lib/local-ai-gateway"

export const useAIConfiguration = () => {
  // Reactive, so the model catalogue is loaded again from a newly saved gateway address.
  const { baseUrl } = useLocalAIConfig()
  const useLocalAI = baseUrl !== null

  return useQuery({
    queryKey: ["aiConfiguration", useLocalAI, baseUrl],
    queryFn: async () => {
      // The model list of a self-hosted gateway replaces Folo's paid model catalogue.
      if (useLocalAI) {
        return fetchLocalAIConfig()
      }

      return followApi.ai.config()
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
