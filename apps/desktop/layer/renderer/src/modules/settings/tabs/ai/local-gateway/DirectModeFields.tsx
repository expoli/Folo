import { Button } from "@follow/components/ui/button/index.js"
import { Checkbox } from "@follow/components/ui/checkbox/index.jsx"
import { Input } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@follow/components/ui/select/index.js"
import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import { cn } from "@follow/utils/utils"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { ipcServices } from "~/lib/client"
import { importLocalAIConfigFromByok } from "~/lib/local-ai-gateway"

interface DirectModeFieldsProps {
  settings: LocalAIGatewaySettings
  /** Persists the fields the user finished editing. */
  save: (changes: Partial<LocalAIGatewaySettings>) => void
  /** Keeps the draft in sync while the user types, so a test probes what is on screen. */
  changeDraft: (changes: Partial<LocalAIGatewaySettings>) => void
  hasApiKey: boolean
  onApiKeyChanged: (hasApiKey: boolean) => void
  /** `false` when this system has no keyring, so the API key cannot be encrypted at all. */
  encryptionAvailable: boolean
}

const EMPTY_MODELS: string[] = []

const mergeModels = (base: string[], extra: string[]) =>
  Array.from(new Set([...base, ...extra].map((model) => model.trim()).filter(Boolean)))

/**
 * Fields of `direct` mode: the OpenAI-compatible endpoint, its API key and its models.
 *
 * The API key is write-only here: it is encrypted by the main process, and this UI only ever shows
 * whether one is stored.
 */
export const DirectModeFields = ({
  settings,
  save,
  changeDraft,
  hasApiKey,
  onApiKeyChanged,
  encryptionAvailable,
}: DirectModeFieldsProps) => {
  const { t } = useTranslation("ai")

  const [keyDraft, setKeyDraft] = useState("")
  const [savingKey, setSavingKey] = useState(false)
  const [models, setModels] = useState<string[]>(settings.directModels ?? EMPTY_MODELS)
  const [modelDraft, setModelDraft] = useState("")
  const [fetchingModels, setFetchingModels] = useState(false)

  const selectedModels = settings.directModels ?? EMPTY_MODELS

  // Models fetched or typed earlier stay visible when the settings change elsewhere.
  useEffect(() => {
    setModels((current) => mergeModels(current, settings.directModels ?? EMPTY_MODELS))
  }, [settings.directModels])

  const saveBaseUrl = () => save({ directBaseUrl: settings.directBaseUrl.trim() })

  const saveApiKey = async () => {
    setSavingKey(true)
    try {
      const services = ipcServices
      if (!services) {
        toast.error(t("settings.localGateway.direct.actionFailed"))
        return
      }

      const result = await services.localAI.setApiKey(keyDraft)

      if (!result.ok) {
        toast.error(result.message)
        return
      }

      setKeyDraft("")
      onApiKeyChanged(result.hasApiKey)
      toast.success(t("settings.localGateway.direct.apiKey.saved"))
    } catch (error) {
      toast.error(t("settings.localGateway.direct.actionFailed"), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setSavingKey(false)
    }
  }

  const clearApiKey = async () => {
    const services = ipcServices
    if (!services) {
      toast.error(t("settings.localGateway.direct.actionFailed"))
      return
    }

    await services.localAI.clearApiKey()
    setKeyDraft("")
    onApiKeyChanged(false)
  }

  const toggleModel = (model: string, selected: boolean) => {
    const nextModels = selected
      ? mergeModels(selectedModels, [model])
      : selectedModels.filter((candidate) => candidate !== model)
    const nextDefault =
      settings.directModel && nextModels.includes(settings.directModel)
        ? settings.directModel
        : (nextModels[0] ?? "")

    save({ directModels: nextModels, directModel: nextDefault })
  }

  const addModel = () => {
    const model = modelDraft.trim()
    if (!model) return

    setModelDraft("")
    setModels((current) => mergeModels(current, [model]))
    save({
      directModels: mergeModels(selectedModels, [model]),
      directModel: settings.directModel || model,
    })
  }

  const fetchModels = async () => {
    const services = ipcServices
    if (!services) return

    setFetchingModels(true)
    try {
      const fetched = await services.localAI.listModels({
        config: {
          baseUrl: settings.directBaseUrl.trim(),
          model: settings.directModel,
          models: selectedModels,
        },
      })

      if (fetched.length === 0) {
        toast.error(t("settings.localGateway.direct.models.empty"))
        return
      }

      setModels((current) => mergeModels(current, fetched))
      // Pre-select everything that was fetched; unchecking what is not wanted is one click each.
      save({
        directModels: mergeModels(selectedModels, fetched),
        directModel: settings.directModel || fetched[0] || "",
      })
      toast.success(t("settings.localGateway.direct.models.fetched", { count: fetched.length }))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("settings.localGateway.direct.models.empty"),
      )
    } finally {
      setFetchingModels(false)
    }
  }

  const importFromByok = async () => {
    let result: Awaited<ReturnType<typeof importLocalAIConfigFromByok>>
    try {
      result = await importLocalAIConfigFromByok()
    } catch (error) {
      toast.error(t("settings.localGateway.direct.actionFailed"), {
        description: error instanceof Error ? error.message : undefined,
      })
      return
    }

    if (!result.ok) {
      toast.error(
        result.reason === "no-provider"
          ? t("settings.localGateway.direct.byok.none")
          : result.message,
      )
      return
    }

    onApiKeyChanged(true)
    toast.success(t("settings.localGateway.direct.byok.imported", { provider: result.provider }))
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium text-text" htmlFor="local-ai-direct-url">
          {t("settings.localGateway.direct.endpoint.label")}
        </Label>
        <Input
          id="local-ai-direct-url"
          type="url"
          placeholder="https://api.openai.com/v1"
          value={settings.directBaseUrl}
          onChange={(event) => changeDraft({ directBaseUrl: event.target.value })}
          onBlur={saveBaseUrl}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveBaseUrl()
          }}
        />
        <p className="text-xs text-text-secondary">
          {t("settings.localGateway.direct.endpoint.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium text-text" htmlFor="local-ai-direct-key">
          {t("settings.localGateway.direct.apiKey.label")}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="local-ai-direct-key"
            type="password"
            autoComplete="off"
            placeholder={t("settings.localGateway.direct.apiKey.placeholder")}
            value={keyDraft}
            disabled={!encryptionAvailable}
            onChange={(event) => setKeyDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && keyDraft.trim()) void saveApiKey()
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            isLoading={savingKey}
            disabled={!encryptionAvailable || !keyDraft.trim()}
            onClick={saveApiKey}
          >
            {t("settings.localGateway.direct.apiKey.save")}
          </Button>
          {hasApiKey && (
            <Button type="button" variant="ghost" size="sm" onClick={clearApiKey}>
              {t("settings.localGateway.direct.apiKey.clear")}
            </Button>
          )}
        </div>

        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <i
            className={cn(
              "size-4 shrink-0",
              hasApiKey ? "i-mgc-check-circle-cute-re text-green" : "i-mgc-warning-cute-re",
            )}
          />
          <span>
            {hasApiKey
              ? t("settings.localGateway.direct.apiKey.status.saved")
              : t("settings.localGateway.direct.apiKey.status.missing")}
          </span>
        </p>

        {!encryptionAvailable && (
          <p className="flex items-center gap-1.5 text-xs text-orange">
            <i className="i-mgc-warning-cute-re size-4 shrink-0" />
            <span>{t("settings.localGateway.direct.apiKey.unsupported")}</span>
          </p>
        )}

        <p className="text-xs text-text-secondary">
          {t("settings.localGateway.direct.apiKey.description")}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-sm font-medium text-text">
            {t("settings.localGateway.direct.models.label")}
          </Label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={importFromByok}>
              {t("settings.localGateway.direct.byok.action")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              isLoading={fetchingModels}
              disabled={!settings.directBaseUrl.trim()}
              onClick={fetchModels}
            >
              {t("settings.localGateway.direct.models.fetch")}
            </Button>
          </div>
        </div>

        {models.length === 0 ? (
          <p className="text-xs text-text-secondary">
            {t("settings.localGateway.direct.models.none")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {models.map((model) => (
              <label
                key={model}
                className="flex cursor-pointer items-center gap-2 text-sm text-text"
              >
                <Checkbox
                  checked={selectedModels.includes(model)}
                  onCheckedChange={(checked) => toggleModel(model, checked === true)}
                />
                <span className="truncate">{model}</span>
              </label>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Input
            value={modelDraft}
            placeholder={t("settings.localGateway.direct.models.manualPlaceholder")}
            onChange={(event) => setModelDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addModel()
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!modelDraft.trim()}
            onClick={addModel}
          >
            {t("settings.localGateway.direct.models.manualAdd")}
          </Button>
        </div>

        <div className="space-y-2 pt-1">
          <Label className="text-sm font-medium text-text" htmlFor="local-ai-direct-default-model">
            {t("settings.localGateway.direct.models.default.label")}
          </Label>
          <Select
            value={settings.directModel ?? ""}
            disabled={selectedModels.length === 0}
            onValueChange={(value) => save({ directModel: value })}
          >
            <SelectTrigger id="local-ai-direct-default-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectedModels.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-xs text-text-secondary">
          {t("settings.localGateway.direct.models.description")}
        </p>
      </div>
    </div>
  )
}
