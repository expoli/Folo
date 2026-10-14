import { UserRole } from "@follow/constants"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  role: "free",
  signedIn: true,
  paymentEnabled: true,
  links: new Map<string, () => void>(),
  push: vi.fn(),
  present: vi.fn(),
}))

vi.mock("@follow/store/user/hooks", () => ({
  useUserRole: () => state.role,
  useWhoami: () => (state.signedIn ? { id: "test-user" } : null),
}))
vi.mock("@/src/atoms/server-configs", () => ({
  getIsPaymentEnabled: () => state.paymentEnabled,
  useServerConfigs: () => ({ PAYMENT_ENABLED: state.paymentEnabled }),
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("react-native", () => ({
  PixelRatio: { get: () => 1 },
  View: ({ children }: { children?: React.ReactNode }) => children,
}))
vi.mock("@/src/components/ui/typography/Text", () => ({ Text: () => null }))
vi.mock("@/src/components/ui/grouped/GroupedList", () => ({
  GroupedInsetListCard: ({ children }: { children?: React.ReactNode }) => children,
  GroupedInsetListNavigationLinkIcon: () => null,
  GroupedInsetListNavigationLink: ({ label, onPress }: { label: string; onPress: () => void }) => {
    state.links.set(label, onPress)
    return null
  },
}))
vi.mock("@/src/lib/navigation/hooks", () => ({
  useNavigation: () => ({ pushControllerView: state.push, presentControllerView: state.present }),
}))
vi.mock("@/src/lib/payment", () => ({ isPaymentFeatureEnabled: Boolean }))
vi.mock("@/src/lib/auth", () => ({ signOut: vi.fn() }))
vi.mock("@/src/lib/dialog", () => ({ Dialog: { show: vi.fn() } }))
vi.mock("@/src/theme/colors", () => ({ accentColor: "#ff6600" }))

for (const [path, name] of [
  ["ai_cute_fi", "AiCuteFiIcon"],
  ["certificate_cute_fi", "CertificateCuteFiIcon"],
  ["database", "DatabaseIcon"],
  ["exit_cute_fi", "ExitCuteFiIcon"],
  ["flashlight_cute_re", "FlashlightCuteReIcon"],
  ["magic_2_cute_fi", "Magic2CuteFiIcon"],
  ["notification_cute_re", "NotificationCuteReIcon"],
  ["palette_cute_fi", "PaletteCuteFiIcon"],
  ["power_outline", "PowerOutlineIcon"],
  ["rada_cute_fi", "RadaCuteFiIcon"],
  ["safe_lock_filled", "SafeLockFilledIcon"],
  ["settings_1_cute_fi", "Settings1CuteFiIcon"],
  ["star_cute_fi", "StarCuteFiIcon"],
  ["user_setting_cute_fi", "UserSettingCuteFiIcon"],
]) {
  vi.doMock(`@/src/icons/${path}`, () => ({ [name!]: () => null }))
}

// Keep the real settings entries and click handlers, but do not mount destination screens.
for (const route of [
  "About",
  "Account",
  "Actions",
  "Appearance",
  "Data",
  "Feeds",
  "General",
  "Lists",
  "LocalAI",
  "Notifications",
  "Plan",
  "Privacy",
  "Spotlight",
]) {
  vi.doMock(`./routes/${route}`, () => ({ [`${route}Screen`]: () => null }))
}
const { SettingsList } = await import("./SettingsList")
const { ListsScreen } = await import("./routes/Lists")
const { ActionsScreen } = await import("./routes/Actions")
const { PlanScreen } = await import("./routes/Plan")

const renderSettings = () => renderToStaticMarkup(React.createElement(SettingsList))

describe("settings data navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("React", React)
    state.links.clear()
    state.role = UserRole.Free
    state.signedIn = true
    state.paymentEnabled = true
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([UserRole.Free, UserRole.Trial, UserRole.Basic, UserRole.Plus])(
    "opens lists and automation rather than billing for %s users",
    (role) => {
      state.role = role
      renderSettings()
      state.links.get("titles.lists")!()
      state.links.get("titles.actions")!()
      expect(state.push.mock.calls).toEqual([[ListsScreen], [ActionsScreen]])
      expect(state.present).not.toHaveBeenCalled()
    },
  )

  it("keeps the explicit subscription entry opening billing", () => {
    renderSettings()
    state.links.get("titles.subscription.short")!()
    expect(state.push).toHaveBeenCalledWith(PlanScreen)
  })

  it("hides account data entries for anonymous users", () => {
    state.signedIn = false
    renderSettings()
    expect(state.links.has("titles.lists")).toBe(false)
    expect(state.links.has("titles.actions")).toBe(false)
  })

  it("opens data pages and hides billing when payments are disabled", () => {
    state.paymentEnabled = false
    renderSettings()
    state.links.get("titles.lists")!()
    state.links.get("titles.actions")!()
    expect(state.push.mock.calls).toEqual([[ListsScreen], [ActionsScreen]])
    expect(state.links.has("titles.subscription.short")).toBe(false)
  })
})
