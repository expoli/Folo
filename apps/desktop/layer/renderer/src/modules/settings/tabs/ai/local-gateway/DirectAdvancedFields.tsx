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
import type { LocalAIReasoningEffort } from "@follow/shared/settings/local-ai"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

/**
 * Tuning of the direct endpoint: output budget, sampling, thinking effort and the chunking of long
 * articles. A field the user leaves empty keeps the built-in default, which its placeholder shows.
 */
const NUMBER_FIELDS = [
  { key: "maxOutputTokens", placeholder: "8192" },
  { key: "temperature", placeholder: "—" },
  { key: "summaryChunkChars", placeholder: "12000" },
  { key: "translationChunkChars", placeholder: "8000" },
  { key: "translationConcurrency", placeholder: "3" },
] as const

type NumberFieldKey = (typeof NUMBER_FIELDS)[number]["key"]

const EFFORT_LEVELS: LocalAIReasoningEffort[] = ["low", "medium", "high"]

const PROVIDER_DEFAULT = "default"

const draftValues = (settings: LocalAIGatewaySettings) => ({
  maxOutputTokens: settings.directOptions.maxOutputTokens?.toString() ?? "",
  temperature: settings.directOptions.temperature?.toString() ?? "",
  summaryChunkChars: settings.directOptions.summaryChunkChars?.toString() ?? "",
  translationChunkChars: settings.directOptions.translationChunkChars?.toString() ?? "",
  translationConcurrency: settings.directOptions.translationConcurrency?.toString() ?? "",
})

export const DirectAdvancedFields = ({
  settings,
  save,
}: {
  settings: LocalAIGatewaySettings
  save: (changes: Partial<LocalAIGatewaySettings>) => void
}) => {
  const { t } = useTranslation("ai")
  const options = settings.directOptions

  const [drafts, setDrafts] = useState<Record<NumberFieldKey, string>>(() => draftValues(settings))
  const [bodyDraft, setBodyDraft] = useState(options.extraRequestBody)

  // Follow changes made elsewhere in the app (or another window) without dropping an edit in flight.
  useEffect(() => {
    setDrafts(draftValues(settings))
    setBodyDraft(settings.directOptions.extraRequestBody)
  }, [settings])

  const saveNumber = (key: NumberFieldKey) => {
    const raw = drafts[key].trim()
    if (raw === "") {
      return save({ directOptions: { ...options, [key]: null } })
    }

    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error(t("settings.localGateway.direct.advanced.invalidNumber"))
      setDrafts((current) => ({ ...current, [key]: options[key]?.toString() ?? "" }))
      return
    }

    return save({ directOptions: { ...options, [key]: parsed } })
  }

  const saveExtraRequestBody = () => {
    const raw = bodyDraft.trim()
    if (raw === "") {
      return save({ directOptions: { ...options, extraRequestBody: "" } })
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object")
      }
    } catch {
      toast.error(t("settings.localGateway.direct.advanced.extraRequestBody.invalid"))
      return
    }

    return save({ directOptions: { ...options, extraRequestBody: raw } })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm font-medium text-text">
          {t("settings.localGateway.direct.advanced.title")}
        </Label>
        <p className="text-xs text-text-secondary">
          {t("settings.localGateway.direct.advanced.description")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        {NUMBER_FIELDS.map(({ key, placeholder }) => (
          <div className="space-y-1.5" key={key}>
            <Label className="text-xs text-text-secondary" htmlFor={`local-ai-${key}`}>
              {t(`settings.localGateway.direct.advanced.${key}.label`)}
            </Label>
            <Input
              id={`local-ai-${key}`}
              inputMode="decimal"
              placeholder={placeholder}
              value={drafts[key]}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [key]: event.target.value }))
              }
              onBlur={() => saveNumber(key)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveNumber(key)
              }}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-text-secondary">
        {t("settings.localGateway.direct.advanced.maxOutputTokens.description")}
      </p>

      <div className="space-y-1.5">
        <Label className="text-xs text-text-secondary" htmlFor="local-ai-reasoning-effort">
          {t("settings.localGateway.direct.advanced.reasoningEffort.label")}
        </Label>
        <Select
          value={options.reasoningEffort ?? PROVIDER_DEFAULT}
          onValueChange={(value) =>
            save({
              directOptions: {
                ...options,
                // The provider decides when the user has no preference.
                reasoningEffort:
                  value === PROVIDER_DEFAULT ? null : (value as LocalAIReasoningEffort),
              },
            })
          }
        >
          <SelectTrigger id="local-ai-reasoning-effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROVIDER_DEFAULT}>
              {t("settings.localGateway.direct.advanced.reasoningEffort.default")}
            </SelectItem>
            {EFFORT_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {t(`settings.localGateway.direct.advanced.reasoningEffort.${level}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-text-secondary">
          {t("settings.localGateway.direct.advanced.reasoningEffort.description")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-text-secondary" htmlFor="local-ai-extra-body">
          {t("settings.localGateway.direct.advanced.extraRequestBody.label")}
        </Label>
        <textarea
          id="local-ai-extra-body"
          className="min-h-16 w-full rounded-md border border-border bg-fill-quaternary px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
          placeholder='{"thinking_budget": 1024}'
          value={bodyDraft}
          onChange={(event) => setBodyDraft(event.target.value)}
          onBlur={saveExtraRequestBody}
        />
        <p className="text-xs text-text-secondary">
          {t("settings.localGateway.direct.advanced.extraRequestBody.description")}
        </p>
      </div>
    </div>
  )
}
