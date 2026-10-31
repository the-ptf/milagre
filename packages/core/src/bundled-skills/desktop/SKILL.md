---
name: desktop
description: Operate desktop apps on the computer this Chat runs on with Milagre's desktop_ tools (Computer use, Settings › Experimental). Use when a task needs a native app's UI: Finder, Notes, Xcode, a settings pane of an app, any window that has no CLI or API.
---

# Computer use

Milagre's `desktop_` tools read and operate desktop apps through the OS accessibility tree (agent-desktop). They are
headless: they never move the user's pointer, type into whatever has focus, or bring a window forward. The user is
probably working on this computer while you act, so keep it that way.

## Before you start

- Prefer a CLI, an API or a file over the GUI. Use these tools for what has no other way in.
- The first time you touch an app in this Chat, Milagre asks the user. If they decline, stop using that app and say so;
  don't look for a way around it.
- Milagre never lets agents operate itself, terminals, System Settings or password managers. Don't ask the user to
  change that.

## The loop

1. `desktop_apps` lists running apps; with `app`, that app's windows and their ids.
2. `desktop_launch` opens an app that isn't running.
3. Observe: `desktop_find` when you know the role or name (`role: "button", name: "Save"`); otherwise
   `desktop_snapshot`. For a dense app take `skeleton: true` first, then drill in with `root` set to a region's ref.
   Pass `surface: "menubar"` for File, Edit and View menus, `"sheet"` or `"alert"` for dialogs.
4. Act with `desktop_act` on one qualified ref, with `intent` naming the step in a few words ("Typing the new name").
   Milagre shows it beside its agent cursor on screen and in the Chat's live screen, so the user can follow along.
   The ref looks like `@s8f3k2p9:e12`; the actions are: `click`, `type`, `set-value`, `select`, `toggle`,
   `check`, `expand`, `scroll`, and the rest. `desktop_press` sends a key combo to an app.
5. Verify: snapshot the same region again, or `desktop_find` the result. A success reply doesn't prove the effect.
6. After anything asynchronous (a save, a load, a new window), `desktop_wait` for its text or window instead of
   sleeping.

Refs belong to the snapshot that returned them. After the UI changes, take a new snapshot and use its refs. On
`STALE_REF`, `AMBIGUOUS_TARGET` or `SNAPSHOT_NOT_FOUND`, observe again.

## Retries

Every action reply carries `disposition.delivery` and `disposition.retry`. Retry or try another action only when
`retry` is `safe` (delivery `not_delivered`). Anything else may have landed: read the live state first, or you may
click, send or toggle twice.

## Ask first

Stop and ask the user before an action that sends, posts, pays, buys, deletes, publishes, shares or signs something,
even when they asked for the outcome in general. Name the app, the element and the exact values.

Never type a password, token or one-time code. Use milagre request_secret to get it into a file, or ask the user to
enter it themselves and tell you when it's done.

## Seeing the screen

`desktop_screenshot` returns a picture of an app's window when you need to check how something looks. It needs Screen
Recording for Milagre; if it reports a missing permission, carry on with snapshots and tell the user they can grant it
in Settings › Experimental › Computer use.
