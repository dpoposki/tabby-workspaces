import { Injectable } from '@angular/core'
import { ConfigProvider, ConfigService, Platform } from 'tabby-core'

/** Settings → Workspaces, stored under `workspaces` in Tabby's config.yaml */
export interface WorkspacesSettings {
    /** Show the launcher when Tabby starts, instead of a terminal */
    showLauncher: boolean
    /** At startup, open the most recently used workspace instead of showing the launcher */
    openLastWorkspace: boolean
    /** List recent workspaces on the start page of an empty window */
    startPageList: boolean
    /** How many workspaces the start page lists */
    startPageCount: number
    /** New pins get a persistent tmux session, where the tab supports it (WSL, SSH, macOS/Linux shells) */
    tmuxByDefault: boolean
    /** Workspace badge in the tab bar (read once per window) */
    toolbarBadge: boolean
    /** Thin line in the workspace color across the top of the window */
    colorStripe: boolean
    /** Workspace icon and own taskbar button (Windows, Linux) */
    taskbarIcon: boolean
}

/** Hotkey ids, as listed under Settings → Hotkeys */
export const HOTKEY_LAUNCHER = 'workspaces-open'

/** Bounds of the start page count setting */
export const START_PAGE_COUNT_MIN = 1
export const START_PAGE_COUNT_MAX = 20

const DEFAULTS: WorkspacesSettings = {
    showLauncher: true,
    openLastWorkspace: false,
    startPageList: true,
    startPageCount: 8,
    tmuxByDefault: false,
    toolbarBadge: true,
    colorStripe: true,
    taskbarIcon: true,
}

/** Typed access; Tabby fills in the defaults, so every key is always present. */
export function workspacesSettings (config: ConfigService): WorkspacesSettings {
    return config.store.workspaces
}

/** The start page count, kept in bounds even if config.yaml was edited by hand */
export function startPageCount (settings: WorkspacesSettings): number {
    const count = Math.round(Number(settings.startPageCount))
    if (!Number.isFinite(count)) {
        return DEFAULTS.startPageCount
    }
    return Math.min(START_PAGE_COUNT_MAX, Math.max(START_PAGE_COUNT_MIN, count))
}

@Injectable()
export class WorkspacesConfigProvider extends ConfigProvider {
    defaults = {
        workspaces: DEFAULTS,
        hotkeys: {
            [HOTKEY_LAUNCHER]: ['Ctrl-Alt-N'],
        },
    }

    // Tabby's own macOS shortcuts use ⌘ (e.g. ⌘-⌥-arrows for panes)
    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                [HOTKEY_LAUNCHER]: ['⌘-⌥-N'],
            },
        },
    }
}
