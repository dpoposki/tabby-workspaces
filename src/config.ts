import { Injectable } from '@angular/core'
import { ConfigProvider, ConfigService, Platform } from 'tabby-core'

/** Settings → Workspaces, stored under `workspaces` in Tabby's config.yaml */
export interface WorkspacesSettings {
    /** Show the launcher when Tabby starts, instead of a terminal */
    showLauncher: boolean
    /** List recent workspaces on the start page of an empty window */
    startPageList: boolean
    /** Workspace badge in the tab bar (read once per window) */
    toolbarBadge: boolean
    /** Thin line in the workspace color across the top of the window */
    colorStripe: boolean
    /** Workspace icon and own taskbar button (Windows, Linux) */
    taskbarIcon: boolean
}

/** Hotkey ids, as listed under Settings → Hotkeys */
export const HOTKEY_LAUNCHER = 'workspaces-open'

const DEFAULTS: WorkspacesSettings = {
    showLauncher: true,
    startPageList: true,
    toolbarBadge: true,
    colorStripe: true,
    taskbarIcon: true,
}

/** Typed access; Tabby fills in the defaults, so every key is always present. */
export function workspacesSettings (config: ConfigService): WorkspacesSettings {
    return config.store.workspaces
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
