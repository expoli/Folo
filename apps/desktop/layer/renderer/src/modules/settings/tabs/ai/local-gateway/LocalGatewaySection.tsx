import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import { SegmentGroup, SegmentItem } from "@follow/components/ui/segment/index.jsx"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIProbeResult } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { probeLocalAIGateway } from "@follow/store/ai-local/client"
import { cn } from "@follow/utils/utils"
import { isEqual } from "es-toolkit"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { setAISetting, useAISettingValue } from "~/atoms/settings/ai"
import { ipcServices } from "~/lib/client"
import { createLocalAIDirectFetch } from "~/lib/local-ai-direct-fetch"
import { getDirectAIConfig, normalizeLocalGatewaySettings } from "~/lib/local-ai-gateway"

import { DirectModeFields } from "./DirectModeFields"

const ProbeResultLine = ({ result }: { result: LocalAIProbeResult | null }) => {
  const { t } = useTranslation("ai")

  if (!result) return null

  let icon: string
  let tone: string
  let text: string

  switch (result.kind) {
    case "ok": {
      icon = "i-mgc-check-circle-cute-re"
      tone = "text-green"
      text =
        result.latencyMs === null
          ? t("settings.localGateway.result.ok_unchecked")
          : t("settings.localGateway.result.ok", { latency: result.latencyMs })
      break
    }
    case "token-rejected": {
      icon = "i-mgc-close-cute-re"
      tone = "text-red"
      text = t("settings.localGateway.result.token_rejected")
      break
    }
    case "unreachable": {
      icon = "i-mgc-warning-cute-re"
      tone = "text-orange"
      text = t("settings.localGateway.result.unreachable", { detail: result.detail })
      break
    }
    case "upstream-error": {
      icon = "i-mgc-bug-cute-re"
      tone = "text-orange"
      text = t("settings.localGateway.result.upstream_error", { detail: result.detail })
      break
    }
  }

  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-xs", tone)}>
      <i className={cn("size-4 shrink-0", icon)} />
      <span className="truncate">{text}</span>
    </p>
  )
}

/**
 * Settings → AI: run AI on your own model endpoint. It either talks to a self-hosted gateway
 * process, or — direct mode — calls an OpenAI-compatible endpoint from the desktop main process,
 * where the API key is encrypted with the OS keyring. Everything stays on the device, and a saved
 * change applies to the next AI request without restarting the app.
 */
export const LocalGatewaySection = () => {
  const { t } = useTranslation("ai")
  const settings = normalizeLocalGatewaySettings(useAISettingValue().localGateway)

  const [draft, setDraft] = useState(settings)
  const [showToken, setShowToken] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<LocalAIProbeResult | null>(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const probeAbortRef = useRef<AbortController | null>(null)

  // Follow changes made elsewhere (account settings are stripped of the local fields, so this only
  // reacts to the section itself) without dropping what the user is typing in the meantime.
  useEffect(() => {
    setDraft((current) => (isEqual(current, settings) ? current : settings))
  }, [settings])

  // The API key lives in the main process, so its status is not part of the settings.
  useEffect(() => {
    const services = ipcServices
    if (!services) return

    let cancelled = false
    void Promise.all([
      services.localAI.isSecureStorageAvailable(),
      services.localAI.hasApiKey(),
    ]).then(([available, stored]) => {
      if (cancelled) return

      setEncryptionAvailable(available)
      setHasApiKey(stored)
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => probeAbortRef.current?.abort(), [])

  const save = (changes: Partial<LocalAIGatewaySettings>) => {
    const next = { ...draft, ...changes }
    setDraft(next)
    setAISetting("localGateway", next)
  }

  const changeDraft = (changes: Partial<LocalAIGatewaySettings>) => {
    // A test result belongs to the settings it was probed with, so an edit drops it.
    probeAbortRef.current?.abort()
    setProbing(false)
    setProbeResult(null)
    setDraft({ ...draft, ...changes })
  }

  const testConnection = async () => {
    probeAbortRef.current?.abort()
    const controller = new AbortController()
    probeAbortRef.current = controller

    setProbing(true)
    setProbeResult(null)

    // The draft is probed, not the saved settings, so an address can be tested before saving it.
    // Direct mode has no address the renderer could reach: the probe travels over IPC and uses the
    // API key that is already stored in the main process.
    const result =
      draft.mode === "direct"
        ? await probeLocalAIGateway({
            baseUrl: LOCAL_AI_DIRECT_ORIGIN,
            signal: controller.signal,
            fetch: createLocalAIDirectFetch(() => getDirectAIConfig(draft)),
          })
        : await probeLocalAIGateway({
            baseUrl: draft.baseUrl,
            token: draft.token,
            signal: controller.signal,
          })

    if (controller.signal.aborted) return

    setProbing(false)
    setProbeResult(result)
  }

  const saveBaseUrl = () => save({ baseUrl: (draft.baseUrl ?? "").trim() })
  const saveToken = () => save({ token: (draft.token ?? "").trim() })

  const isDirect = draft.mode === "direct"
  const canTest = isDirect
    ? Boolean((draft.directBaseUrl ?? "").trim())
    : Boolean((draft.baseUrl ?? "").trim())

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium text-text" htmlFor="local-gateway-enabled">
            {t("settings.localGateway.enabled.label")}
          </Label>
          <div className="text-xs text-text-secondary">
            {t("settings.localGateway.description")}
          </div>
        </div>
        <Switch
          id="local-gateway-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => save({ enabled })}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium text-text">
          {t("settings.localGateway.mode.label")}
        </Label>
        <SegmentGroup
          className="h-9"
          value={draft.mode ?? "gateway"}
          onValueChanged={(value) => {
            if (value !== "gateway" && value !== "direct") return
            // A probe result belongs to the mode it was tested in.
            probeAbortRef.current?.abort()
            setProbing(false)
            setProbeResult(null)
            save({ mode: value })
          }}
        >
          <SegmentItem value="gateway" label={t("settings.localGateway.mode.gateway")} />
          <SegmentItem value="direct" label={t("settings.localGateway.mode.direct")} />
        </SegmentGroup>
        <p className="text-xs text-text-secondary">
          {isDirect
            ? t("settings.localGateway.mode.directDescription")
            : t("settings.localGateway.mode.gatewayDescription")}
        </p>
      </div>

      {isDirect ? (
        <DirectModeFields
          settings={draft}
          save={save}
          changeDraft={changeDraft}
          hasApiKey={hasApiKey}
          onApiKeyChanged={setHasApiKey}
          encryptionAvailable={encryptionAvailable}
        />
      ) : (
        <>
          <div className="space-y-2">
            <Label className="text-sm font-medium text-text" htmlFor="local-gateway-url">
              {t("settings.localGateway.url.label")}
            </Label>
            <Input
              id="local-gateway-url"
              type="url"
              placeholder="http://127.0.0.1:8788"
              value={draft.baseUrl}
              onChange={(event) => changeDraft({ baseUrl: event.target.value })}
              onBlur={saveBaseUrl}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveBaseUrl()
              }}
            />
            <p className="text-xs text-text-secondary">
              {t("settings.localGateway.url.description")}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-text" htmlFor="local-gateway-token">
              {t("settings.localGateway.token.label")}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="local-gateway-token"
                type={showToken ? "text" : "password"}
                value={draft.token}
                onChange={(event) => changeDraft({ token: event.target.value })}
                onBlur={saveToken}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveToken()
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={
                  showToken
                    ? t("settings.localGateway.token.hide")
                    : t("settings.localGateway.token.show")
                }
                onClick={() => setShowToken((visible) => !visible)}
              >
                <i className={showToken ? "i-mgc-eye-close-cute-re" : "i-mgc-eye-2-cute-re"} />
              </Button>
            </div>
            <p className="text-xs text-text-secondary">
              {t("settings.localGateway.token.description")}
            </p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          isLoading={probing}
          disabled={!canTest}
          onClick={testConnection}
        >
          {t("settings.localGateway.test.action")}
        </Button>
        <ProbeResultLine result={probing ? null : probeResult} />
      </div>
    </div>
  )
}
