import { fetchUpstreamModelIds } from "@follow/ai-runtime/config"
import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIProbeResult, LocalAIReasoningEffort } from "@follow/shared/settings/local-ai"
import { probeLocalAIGateway } from "@follow/store/ai-local/client"
import { normalizeLocalGatewaySettings } from "@follow/store/ai-local/settings"
import { cn } from "@follow/utils"
import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, View } from "react-native"

import {
  createDefaultAISettings,
  setLocalAIGatewaySetting,
  useAISettingKey,
} from "@/src/atoms/settings/ai"
import {
  NavigationBlurEffectHeaderView,
  SafeNavigationScrollView,
} from "@/src/components/layouts/views/SafeNavigationScrollView"
import { Select } from "@/src/components/ui/form/Select"
import { TextField } from "@/src/components/ui/form/TextField"
import {
  GroupedInsetListCard,
  GroupedInsetListCell,
  GroupedInsetListSectionHeader,
} from "@/src/components/ui/grouped/GroupedList"
import { Switch } from "@/src/components/ui/switch/Switch"
import { Text } from "@/src/components/ui/typography/Text"
import {
  applyLocalAISettings,
  createLocalAIDirectFetch,
  getDirectApiKey,
  getDirectConfig,
  LOCAL_AI_DIRECT_ORIGIN,
  setDirectApiKey,
  setLocalAIEnabled,
} from "@/src/lib/local-ai"
import type { NavigationControllerView } from "@/src/lib/navigation/types"

const selectWrapperClassName = "w-auto min-w-[96px] max-w-[52vw] shrink-0"

/** Reads a field the user typed. `min` keeps temperature accepting its own `0`. */
const toNumber = (value: string, min: number) => {
  const parsed = Number.parseFloat(value.trim())
  return Number.isFinite(parsed) && parsed >= min ? parsed : null
}

const asText = (value: number | null | undefined) => (value == null ? "" : String(value))

/**
 * Local AI settings: this app calls an OpenAI-compatible endpoint itself, so summaries and
 * translations run on the user's own model without a gateway process in between.
 *
 * The desktop app configures the same fields in Settings → AI; the address and the models live in
 * the `ai` settings, the API key stays in the OS keychain (`safeSecureStore`).
 */
export const LocalAIScreen: NavigationControllerView = () => {
  const { t } = useTranslation("ai")
  const stored = useAISettingKey("localGateway")
  const settings = useMemo(
    () => normalizeLocalGatewaySettings(stored, createDefaultAISettings().localGateway),
    [stored],
  )

  const [endpointDraft, setEndpointDraft] = useState(settings.directBaseUrl)
  const [apiKeyDraft, setApiKeyDraft] = useState("")
  const [hasApiKey, setHasApiKey] = useState(() => Boolean(getDirectApiKey()))
  const [manualModel, setManualModel] = useState("")
  const [models, setModels] = useState<string[]>(settings.directModels ?? [])
  const [busy, setBusy] = useState<"models" | "probe" | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const options = settings.directOptions

  const patchOptions = useCallback(
    (patch: Partial<LocalAIGatewaySettings["directOptions"]>) => {
      setLocalAIGatewaySetting({ directOptions: { ...options, ...patch } })
    },
    [options],
  )

  /** Config of what is on screen, so "Test connection" also works before the address is saved. */
  const draftConfig = useMemo(
    () => getDirectConfig({ ...settings, directBaseUrl: endpointDraft, directModels: models }),
    [settings, endpointDraft, models],
  )

  const draftFetch = useMemo(
    () =>
      createLocalAIDirectFetch(
        () => draftConfig,
        () => apiKeyDraft.trim() || getDirectApiKey(),
      ),
    [draftConfig, apiKeyDraft],
  )

  const saveEndpoint = () => {
    setLocalAIGatewaySetting({ directBaseUrl: endpointDraft.trim() })
    applyLocalAISettings()
  }

  const fetchModels = async () => {
    if (!draftConfig) {
      setNotice(t("settings.localGateway.result.unreachable", { detail: endpointDraft }))
      return
    }

    setBusy("models")
    setNotice(null)

    try {
      const { ids, rejected } = await fetchUpstreamModelIds(
        draftConfig,
        apiKeyDraft.trim() || getDirectApiKey(),
        globalThis.fetch,
      )

      if (rejected) {
        setNotice(t("settings.localGateway.result.token_rejected"))
        return
      }
      if (ids.length === 0) {
        setNotice(t("settings.localGateway.direct.models.empty"))
        return
      }

      setModels(ids)
      setLocalAIGatewaySetting({ directModels: ids })
      setNotice(t("settings.localGateway.direct.models.fetched", { count: ids.length }))
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async () => {
    setBusy("probe")
    setNotice(null)

    try {
      const result = await probeLocalAIGateway({
        baseUrl: LOCAL_AI_DIRECT_ORIGIN,
        fetch: draftFetch,
      })

      setNotice(describeProbe(result, t))
    } finally {
      setBusy(null)
    }
  }

  const toggleModel = (model: string) => {
    const next = models.includes(model)
      ? models.filter((item) => item !== model)
      : [...models, model]

    setModels(next)
    setLocalAIGatewaySetting({
      directModels: next,
      directModel: next.includes(settings.directModel) ? settings.directModel : (next[0] ?? ""),
    })
  }

  const numberField = (
    label: string,
    value: number | null | undefined,
    commit: (value: number | null) => void,
    options?: { description?: string; min?: number },
  ) => (
    <TextField
      key={label}
      label={label}
      description={options?.description}
      keyboardType="numeric"
      defaultValue={asText(value)}
      onEndEditing={(event) => {
        const text = event.nativeEvent.text.trim()
        if (!text) {
          commit(null)
          return
        }

        const parsed = toNumber(text, options?.min ?? 1)
        if (parsed === null) {
          setNotice(t("settings.localGateway.direct.advanced.invalidNumber"))
          return
        }

        commit(parsed)
      }}
    />
  )

  return (
    <SafeNavigationScrollView
      className="bg-system-grouped-background"
      Header={<NavigationBlurEffectHeaderView title={t("settings.localGateway.title")} />}
    >
      <GroupedInsetListCard>
        <GroupedInsetListCell
          label={t("settings.localGateway.enabled.label")}
          description={t("settings.localGateway.direct.endpoint.description")}
        >
          <Switch
            value={settings.enabled}
            onValueChange={(enabled) => {
              // Only the switch is written: the mode the user configured (a gateway or a direct
              // endpoint) has to survive turning local AI off and on again.
              setLocalAIEnabled(enabled)
            }}
          />
        </GroupedInsetListCell>
      </GroupedInsetListCard>

      {settings.enabled ? (
        <>
          <GroupedInsetListSectionHeader label={t("settings.localGateway.mode.direct")} />
          <View className="gap-4 px-4">
            <TextField
              label={t("settings.localGateway.direct.endpoint.label")}
              description={t("settings.localGateway.direct.endpoint.description")}
              value={endpointDraft}
              onChangeText={setEndpointDraft}
              onBlur={saveEndpoint}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="http://192.168.1.20:8080/v1"
            />

            <TextField
              label={t("settings.localGateway.direct.apiKey.label")}
              description={
                hasApiKey
                  ? t("settings.localGateway.direct.apiKey.status.saved")
                  : t("settings.localGateway.direct.apiKey.status.missing")
              }
              value={apiKeyDraft}
              onChangeText={setApiKeyDraft}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder={t("settings.localGateway.direct.apiKey.placeholder")}
              inputPostfixElement={
                <View className="flex-row gap-3">
                  <Action
                    label={t("settings.localGateway.direct.apiKey.save")}
                    onPress={() => {
                      const result = setDirectApiKey(apiKeyDraft)
                      if (!result.ok) {
                        // Storing a key unencrypted is never an option; say why instead.
                        setHasApiKey(Boolean(getDirectApiKey()))
                        setNotice(result.message)
                        return
                      }

                      setHasApiKey(result.hasApiKey)
                      setApiKeyDraft("")
                      setNotice(t("settings.localGateway.direct.apiKey.saved"))
                    }}
                  />
                  <Action
                    label={t("settings.localGateway.direct.apiKey.clear")}
                    onPress={() => {
                      setDirectApiKey("")
                      setHasApiKey(false)
                      setApiKeyDraft("")
                    }}
                  />
                </View>
              }
            />
          </View>

          <GroupedInsetListSectionHeader label={t("settings.localGateway.direct.models.label")} />
          <GroupedInsetListCard>
            <GroupedInsetListCell
              label={t("settings.localGateway.direct.models.label")}
              description={t("settings.localGateway.direct.models.description")}
            >
              <Action
                label={t("settings.localGateway.direct.models.fetch")}
                disabled={busy !== null}
                onPress={fetchModels}
              />
            </GroupedInsetListCell>

            {models.length > 0 ? (
              <View className="flex-row flex-wrap gap-2 px-4 pb-4">
                {models.map((model) => (
                  <Pressable
                    key={model}
                    onPress={() => toggleModel(model)}
                    className={
                      model === settings.directModel
                        ? "rounded-full bg-blue px-3 py-1"
                        : "rounded-full bg-tertiary-system-fill px-3 py-1"
                    }
                  >
                    <Text className={model === settings.directModel ? "text-white" : "text-label"}>
                      {model}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text className="px-4 pb-4 text-sm text-secondary-label">
                {t("settings.localGateway.direct.models.none")}
              </Text>
            )}

            <GroupedInsetListCell label={t("settings.localGateway.direct.models.default.label")}>
              <Select
                wrapperClassName={selectWrapperClassName}
                options={models.map((model) => ({ label: model, value: model }))}
                value={settings.directModel}
                onValueChange={(model) => setLocalAIGatewaySetting({ directModel: model })}
                disabled={models.length === 0}
              />
            </GroupedInsetListCell>

            <GroupedInsetListCell
              label={t("settings.localGateway.direct.models.manualAdd")}
              description={t("settings.localGateway.direct.models.manualPlaceholder")}
            >
              <View className="w-[52vw]">
                <TextField
                  value={manualModel}
                  onChangeText={setManualModel}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onEndEditing={() => {
                    const added = manualModel.trim()
                    if (!added) return
                    if (models.includes(added)) {
                      setManualModel("")
                      return
                    }

                    const next = [...models, added]
                    setModels(next)
                    setLocalAIGatewaySetting({
                      directModels: next,
                      directModel: settings.directModel || added,
                    })
                    setManualModel("")
                  }}
                />
              </View>
            </GroupedInsetListCell>
          </GroupedInsetListCard>

          <GroupedInsetListCard>
            <GroupedInsetListCell label={t("settings.localGateway.mode.direct")}>
              <Action
                label={t("settings.localGateway.test.action")}
                disabled={busy !== null}
                onPress={testConnection}
              />
            </GroupedInsetListCell>
          </GroupedInsetListCard>

          {notice ? <Text className="px-4 pt-2 text-sm text-secondary-label">{notice}</Text> : null}

          <GroupedInsetListSectionHeader label={t("settings.localGateway.direct.advanced.title")} />
          <Text className="px-4 pb-2 text-sm text-secondary-label">
            {t("settings.localGateway.direct.advanced.description")}
          </Text>
          <View className="gap-4 px-4">
            {numberField(
              t("settings.localGateway.direct.advanced.maxOutputTokens.label"),
              options.maxOutputTokens,
              (value) => patchOptions({ maxOutputTokens: value }),
              {
                description: t("settings.localGateway.direct.advanced.maxOutputTokens.description"),
              },
            )}
            {numberField(
              t("settings.localGateway.direct.advanced.temperature.label"),
              options.temperature,
              (value) => patchOptions({ temperature: value }),
              // 0 is a meaningful temperature (as deterministic as the endpoint gets).
              { min: 0 },
            )}
            {numberField(
              t("settings.localGateway.direct.advanced.summaryChunkChars.label"),
              options.summaryChunkChars,
              (value) => patchOptions({ summaryChunkChars: value }),
            )}
            {numberField(
              t("settings.localGateway.direct.advanced.translationChunkChars.label"),
              options.translationChunkChars,
              (value) => patchOptions({ translationChunkChars: value }),
            )}
            {numberField(
              t("settings.localGateway.direct.advanced.translationConcurrency.label"),
              options.translationConcurrency,
              (value) => patchOptions({ translationConcurrency: value }),
            )}
          </View>

          <GroupedInsetListCard className="mt-4">
            <GroupedInsetListCell
              label={t("settings.localGateway.direct.advanced.reasoningEffort.label")}
              description={t("settings.localGateway.direct.advanced.reasoningEffort.description")}
            >
              <Select<LocalAIReasoningEffort | "default">
                wrapperClassName={selectWrapperClassName}
                options={[
                  {
                    label: t("settings.localGateway.direct.advanced.reasoningEffort.default"),
                    value: "default",
                  },
                  {
                    label: t("settings.localGateway.direct.advanced.reasoningEffort.low"),
                    value: "low",
                  },
                  {
                    label: t("settings.localGateway.direct.advanced.reasoningEffort.medium"),
                    value: "medium",
                  },
                  {
                    label: t("settings.localGateway.direct.advanced.reasoningEffort.high"),
                    value: "high",
                  },
                ]}
                value={options.reasoningEffort ?? "default"}
                onValueChange={(value) =>
                  patchOptions({ reasoningEffort: value === "default" ? null : value })
                }
              />
            </GroupedInsetListCell>
          </GroupedInsetListCard>

          <View className="px-4 pt-4">
            <TextField
              label={t("settings.localGateway.direct.advanced.extraRequestBody.label")}
              description={t("settings.localGateway.direct.advanced.extraRequestBody.description")}
              defaultValue={options.extraRequestBody ?? ""}
              autoCapitalize="none"
              autoCorrect={false}
              onEndEditing={(event) => {
                const text = event.nativeEvent.text.trim()
                if (!text) {
                  patchOptions({ extraRequestBody: "" })
                  return
                }

                try {
                  const parsed: unknown = JSON.parse(text)
                  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    setNotice(t("settings.localGateway.direct.advanced.extraRequestBody.invalid"))
                    return
                  }
                } catch {
                  setNotice(t("settings.localGateway.direct.advanced.extraRequestBody.invalid"))
                  return
                }

                patchOptions({ extraRequestBody: text })
              }}
            />
          </View>
        </>
      ) : (
        <Text className="px-4 pt-3 text-sm text-secondary-label">
          {t("settings.localGateway.description")}
        </Text>
      )}
    </SafeNavigationScrollView>
  )
}

/** Small inline action used by the settings rows; the design tokens keep it consistent. */
const Action = ({
  label,
  onPress,
  disabled,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    className={cn("rounded-lg bg-tertiary-system-fill px-3 py-1", disabled && "opacity-50")}
  >
    <Text className="text-blue">{label}</Text>
  </Pressable>
)

/** Probe outcome in the words the shared locale already has for it. */
const describeProbe = (
  result: LocalAIProbeResult,
  t: (
    key:
      | "settings.localGateway.result.ok"
      | "settings.localGateway.result.ok_unchecked"
      | "settings.localGateway.result.token_rejected"
      | "settings.localGateway.result.unreachable"
      | "settings.localGateway.result.upstream_error",
    options?: Record<string, unknown>,
  ) => string,
) => {
  switch (result.kind) {
    case "ok":
      return result.latencyMs == null
        ? t("settings.localGateway.result.ok_unchecked")
        : t("settings.localGateway.result.ok", { latency: result.latencyMs })
    case "token-rejected":
      return t("settings.localGateway.result.token_rejected")
    case "unreachable":
      return t("settings.localGateway.result.unreachable", { detail: result.detail })
    case "upstream-error":
      return t("settings.localGateway.result.upstream_error", { detail: result.detail })
    default:
      return ""
  }
}
