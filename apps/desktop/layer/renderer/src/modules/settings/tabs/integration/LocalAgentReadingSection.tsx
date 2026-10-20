/**
 * Settings for the local agent reading endpoint.
 *
 * The endpoint itself belongs to the main process: this section only switches it on and off and
 * manages the dedicated token an agent authenticates with. The token is shown only after an
 * explicit reveal, and only this (main) window can ask for it.
 *
 * Nothing here is a promise the app cannot keep: the source-page paragraph describes what the main
 * process enforces, and the article page switch only flips a permission that main re-checks before
 * every fetch. The limits are read from the service instead of being written down twice.
 */
import { Button } from "@follow/components/ui/button/index.js"
import { Divider } from "@follow/components/ui/divider/index.js"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import type {
  LocalAgentReadingSettingsStatus,
  LocalAgentReadingTokenReveal,
} from "@follow/shared/local-agent-reading"
import { cn } from "@follow/utils"
import type { FC } from "react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { ipcServices } from "~/lib/client"
import { copyToClipboard } from "~/lib/clipboard"

import { SettingItemGroup, SettingSectionTitle } from "../../section"

type BusyAction = "toggle" | "source-page" | "reveal" | "rotate" | "revoke"

const StatusChip = ({ ok, label }: { ok: boolean; label: string }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
      ok ? "bg-green/10 text-green" : "bg-fill-secondary text-text-tertiary",
    )}
  >
    <i className={ok ? "i-mgc-check-cute-re" : "i-mgc-close-cute-re"} />
    {label}
  </span>
)

const CopyButton = ({
  label,
  value,
  copiedLabel,
}: {
  label: string
  value: string
  copiedLabel: string
}) => (
  <Button
    variant="ghost"
    size="sm"
    onClick={() => {
      void copyToClipboard(value).then(() => toast.success(copiedLabel))
    }}
  >
    <i className="i-mgc-copy-2-cute-re mr-1 size-3.5" />
    {label}
  </Button>
)

export const LocalAgentReadingSection: FC = () => {
  const { t } = useTranslation("settings")
  const service = ipcServices?.localAgentReading

  const [status, setStatus] = useState<LocalAgentReadingSettingsStatus | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyAction | null>(null)

  const refresh = useCallback(async () => {
    if (!service) return
    try {
      setStatus(await service.getStatus())
    } catch (error) {
      console.error("[local-agent-reading] failed to read the settings status", error)
    }
  }, [service])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const reasonMessage = useCallback(
    (reason: LocalAgentReadingTokenReveal["reason"] | undefined) => {
      switch (reason) {
        case "service-disabled": {
          return t("local_agent_reading.error.reason.service_disabled")
        }
        case "write-failed": {
          return t("local_agent_reading.error.reason.write_failed")
        }
        case "no-token": {
          return t("local_agent_reading.error.reason.no_token")
        }
        default: {
          return t("local_agent_reading.error.generic")
        }
      }
    },
    [t],
  )

  const applyStatus = useCallback((next: LocalAgentReadingSettingsStatus | null | undefined) => {
    if (next) setStatus(next)
  }, [])

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      if (!service) return
      setBusy("toggle")
      try {
        applyStatus(await service.setEnabled({ enabled }))
        if (!enabled) setToken(null)
      } catch (error) {
        console.error("[local-agent-reading] failed to switch the endpoint", error)
        toast.error(t("local_agent_reading.error.toggle"))
      } finally {
        setBusy(null)
        void refresh()
      }
    },
    [applyStatus, refresh, service, t],
  )

  const handleSourcePageToggle = useCallback(
    async (enabled: boolean) => {
      if (!service) return
      setBusy("source-page")
      try {
        applyStatus(await service.setSourcePageEnabled({ enabled }))
      } catch (error) {
        console.error("[local-agent-reading] failed to change the article page permission", error)
        toast.error(t("local_agent_reading.error.source_page_toggle"))
      } finally {
        setBusy(null)
        void refresh()
      }
    },
    [applyStatus, refresh, service, t],
  )

  const handleTokenAction = useCallback(
    async (action: "reveal" | "rotate" | "revoke") => {
      if (!service) return
      setBusy(action)
      try {
        const result =
          action === "reveal"
            ? await service.revealToken()
            : action === "rotate"
              ? await service.rotateToken()
              : await service.revokeToken()

        if (action === "revoke") {
          setToken(null)
          toast.success(t("local_agent_reading.token.revoke_success"))
        } else if (result?.ok && result.token) {
          setToken(result.token)
          if (action === "rotate") {
            toast.success(t("local_agent_reading.token.rotate_success"))
          }
        } else {
          setToken(null)
          toast.error(reasonMessage(result?.reason))
        }
      } catch (error) {
        console.error("[local-agent-reading] token action failed", error)
        toast.error(t("local_agent_reading.error.reveal"))
      } finally {
        setBusy(null)
        void refresh()
      }
    },
    [reasonMessage, refresh, service, t],
  )

  // No main process, nothing to switch on: the web build keeps the same component tree.
  if (!service) return null

  const enabled = status?.enabled ?? false
  const sourcePageEnabled = status?.sourcePageEnabled ?? false
  const listening = status?.listening ?? false
  const tokenPresent = status?.tokenPresent ?? false
  const persistence = status?.tokenPersistence ?? "memory"
  const limits = status?.limits

  return (
    <div className="mt-4 space-y-4">
      <Divider />
      <SettingSectionTitle title={t("local_agent_reading.title")} />
      <p className="text-sm text-text-secondary">{t("local_agent_reading.description")}</p>

      <SettingItemGroup>
        <div className="rounded-lg border border-border bg-background px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("local_agent_reading.enable.label")}</p>
              <p className="mt-1 text-xs text-text-tertiary">
                {t("local_agent_reading.enable.description")}
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={busy === "toggle"}
              onCheckedChange={(next) => {
                void handleToggle(next)
              }}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusChip
              ok={listening}
              label={
                listening
                  ? t("local_agent_reading.status.listening")
                  : t("local_agent_reading.status.not_listening")
              }
            />
            <StatusChip
              ok={tokenPresent}
              label={
                tokenPresent
                  ? t("local_agent_reading.status.token_ready")
                  : t("local_agent_reading.status.token_missing")
              }
            />
            <span className="text-xs text-text-tertiary">
              {persistence === "os-keyring"
                ? t("local_agent_reading.persistence.os_keyring")
                : t("local_agent_reading.persistence.memory")}
            </span>
          </div>

          {status?.listenError && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-orange/10 px-3 py-2 text-xs text-orange">
              <i className="i-mgc-warning-cute-re mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{t("local_agent_reading.listen_error.label")}</p>
                <p className="mt-0.5 break-all">
                  {t("local_agent_reading.listen_error.description")} ({status.listenError})
                </p>
              </div>
            </div>
          )}

          {enabled && !tokenPresent && (
            <p className="mt-3 text-xs text-orange">
              {t("local_agent_reading.persistence.memory_warning")}
            </p>
          )}

          <div className="mt-3 flex items-center justify-between gap-4 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {t("local_agent_reading.source_page.enable.label")}
              </p>
              <p className="mt-1 text-xs text-text-tertiary">
                {t("local_agent_reading.source_page.enable.description")}
              </p>
            </div>
            <Switch
              checked={sourcePageEnabled}
              disabled={busy === "source-page"}
              onCheckedChange={(next) => {
                void handleSourcePageToggle(next)
              }}
            />
          </div>

          {status?.endpoint && (
            <div className="mt-3 rounded-md bg-fill-quaternary/60 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {t("local_agent_reading.endpoint.label")}
                </span>
                <CopyButton
                  label={t("local_agent_reading.endpoint.copy")}
                  copiedLabel={t("local_agent_reading.endpoint.copied")}
                  value={status.endpoint}
                />
              </div>
              <code className="block break-all text-sm">{status.endpoint}</code>
            </div>
          )}

          <div className="mt-3 rounded-md bg-fill-quaternary/60 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                {t("local_agent_reading.token.label")}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    if (token) {
                      setToken(null)
                      return
                    }
                    void handleTokenAction("reveal")
                  }}
                >
                  {token
                    ? t("local_agent_reading.token.hide")
                    : t("local_agent_reading.token.reveal")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    void handleTokenAction("rotate")
                  }}
                >
                  <i className="i-mgc-refresh-2-cute-re mr-1 size-3.5" />
                  {t("local_agent_reading.token.rotate")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null || !tokenPresent}
                  onClick={() => {
                    void handleTokenAction("revoke")
                  }}
                >
                  {t("local_agent_reading.token.revoke")}
                </Button>
              </div>
            </div>
            {token ? (
              <>
                <code className="block break-all text-sm">{token}</code>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-xs text-text-tertiary">
                    {t("local_agent_reading.token.hint")}
                  </span>
                  <CopyButton
                    label={t("local_agent_reading.token.copy")}
                    copiedLabel={t("local_agent_reading.token.copied")}
                    value={token}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-text-tertiary">{t("local_agent_reading.token.hidden")}</p>
            )}
          </div>

          <div className="mt-3 space-y-1 text-xs text-text-tertiary">
            <p className="font-medium text-text-secondary">
              {t("local_agent_reading.coverage.title")}
            </p>
            <p>{t("local_agent_reading.coverage.description")}</p>
            <p>
              {t("local_agent_reading.coverage.limits", {
                entries: limits?.maxEntriesPerScan ?? 0,
                chars: limits?.contentChunkChars ?? 0,
              })}
            </p>
            <p>{t("local_agent_reading.coverage.readonly")}</p>
            <p>
              <span className="font-medium text-text-secondary">
                {t("local_agent_reading.source_page.title")}.
              </span>{" "}
              {t("local_agent_reading.source_page.description")}
            </p>
          </div>
        </div>
      </SettingItemGroup>
    </div>
  )
}
