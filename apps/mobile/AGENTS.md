# AGENTS.md

This file provides specific guidance for developing the React Native mobile application.

## Architecture

- **React Native** with Expo for cross-platform mobile development
- **Native modules** in `native/` for platform-specific functionality
- **Web views** in `web-app/` for HTML rendering within the mobile app
- **Shared components** with the desktop app through `packages/internal/`

## Development Commands

```bash
# Start Expo development server
pnpm run dev

# Start with specific platform
pnpm run ios
pnpm run android

# Clean rebuild (useful for native module changes)
pnpm expo prebuild --clean
```

## UIKit Colors for React Native Components

For react native components (`apps/mobile/**/*`), use Apple UIKit color system with Tailwind classes. **Important**: Always use the correct Tailwind prefix for each color category:

### System Colors

- Background: `system-background`, `secondary-system-background`, `tertiary-system-background`
- Grouped: `system-grouped-background`, `secondary-system-grouped-background`, `tertiary-system-grouped-background`
- Labels: `label`, `secondary-label`, `tertiary-label`, `quaternary-label`
- Fills: `system-fill`, `secondary-system-fill`, `tertiary-system-fill`, `quaternary-system-fill`
- Separators: `separator`, `opaque-separator`, `non-opaque-separator`

### Semantic Colors

- Core: `red`, `orange`, `yellow`, `green`, `mint`, `teal`, `cyan`, `blue`, `indigo`, `purple`, `pink`, `brown`
- Grays: `gray`, `gray2`, `gray3`, `gray4`, `gray5`, `gray6`
- Interactive: `link`, `placeholder-text`

These colors automatically adapt to light/dark mode following Apple's design system. Remember to use the appropriate prefix (`text-`, `bg-`, `border-`) based on the CSS property you're styling.

## Android APK for device testing

`.github/workflows/build-android-gradle.yml` builds a standalone release APK **without EAS**: it
runs `expo prebuild` and gradle, so no Expo account, project id or keystore secret is involved. The
release variant is signed with the debug keystore the native template ships, which is enough to
sideload the app. The APK is attached to a prerelease tagged `android/latest` — a prerelease and a
tag containing a slash both keep it out of the desktop app's `releases/latest` update check — and
uploaded as the `android-apk` artifact.

The same steps locally, once JDK 17 and the Android SDK are installed (the machine that builds the
desktop app does not have them):

```bash
# app.config.base.ts points at out/rn-web, so the renderer bundle has to exist before prebuild
pnpm --dir apps/mobile/web-app build --outDir "$PWD/out/rn-web/html-renderer"
cd apps/mobile
pnpm exec expo prebuild --platform android --clean --no-install
cd android && ./gradlew assembleRelease   # -> app/build/outputs/apk/release/app-release.apk
```

A debug APK (`./gradlew assembleDebug`) loads its JavaScript from a running Metro server; the release
one bundles it, so it can be installed anywhere.

### Signing

The release variant is signed with the debug keystore the native template ships, which is enough to
sideload the app for testing. A build that is distributed or updated in place needs a real keystore
that never changes, and that is upstream's EAS workflow (`production-apk` profile) rather than this
one; switching later means uninstalling the debug-signed app once.
