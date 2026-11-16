export { url as REPO_URL } from "@milagre/shared/repository";
export const DOWNLOAD_ARM64 = "/download/mac-arm64";
export const DOWNLOAD_X64 = "/download/mac-x64";
export const DOWNLOAD_LINUX_APPIMAGE = "/download/linux-appimage";
export const DOWNLOAD_LINUX_DEB = "/download/linux-deb";
export const DOWNLOAD_LINUX_RPM = "/download/linux-rpm";
export const DOWNLOAD_WINDOWS = "/download/windows";
// Pinned to the beta.27 APK; /download/android still serves the newest one.
export const DOWNLOAD_ANDROID = "https://github.com/the-ptf/milagre/releases/download/v0.232.0-beta.27/Milagre-0.232.0-beta.27-android-beta.apk";
export const DOWNLOAD_IOS = "https://apps.apple.com/app/milagre/id6818804252";
// Who runs Milagre and where privacy and support requests go. The privacy policy and support page read these; an
// SITE_OPERATOR_NAME / SITE_CONTACT_EMAIL build variable overrides them.
export const OPERATOR_NAME = "Victor Lucas";
export const CONTACT_EMAIL = "support@milagre.cloud";
