import { fetchLocalAIConfig } from "@follow/store/ai-local/client"
import { isLocalAIEnabled } from "@follow/store/ai-local/config"
import { useQuery } from "@tanstack/react-query"

import { followApi } from "~/lib/api-client"

export const useAIConfiguration = () => {
  const useLocalAI = isLocalAIEnabled()

  return useQuery({
    queryKey: ["aiConfiguration", useLocalAI],
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
