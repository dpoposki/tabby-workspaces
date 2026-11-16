import { Injectable } from '@angular/core'
import {
    AppService, BaseTabComponent, CLIEvent, CLIHandler, Command, CommandContext, CommandLocation, CommandProvider,
    ConfigService, HotkeyDescription, HotkeyProvider, MenuItemOptions, TabContextMenuItemProvider,
} from 'tabby-core'
import { WorkspacesService } from './workspaces.service'
import { WorkspaceSession } from './session'
import { WorkspaceDialogs } from './dialogs'
import { isWslTab } from './wsl'
import { WorkspacesLauncher } from './launcher'
import { ErrorReporter } from './errors'
import { HOTKEY_LAUNCHER, startPageCount, workspacesSettings } from './config'
import { initialOf, safeColor } from './models'

/** Right-click menu on a pinned tab: pin name, startup command, tmux. */
@Injectable()
export class WorkspacesTabContextMenu extends TabContextMenuItemProvider {
    weight = 5

    constructor (private app: AppService, private session: WorkspaceSession, private dialogs: WorkspaceDialogs) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (!tabHeader || !this.session.current || !tab.pinned || !this.app.tabs.includes(tab)) {
            return []
        }
        const meta = this.session.getMeta(tab)
        const wsl = isWslTab(tab)
        return [
            { type: 'separator' },
            {
                label: 'Pinned tab',
                submenu: [
                    {
                        label: 'Rename pin…',
                        click: () => this.app.renameTab(tab),
                    },
                    {
                        label: 'Startup command…',
                        sublabel: meta.startupCommand,
                        click: () => this.dialogs.editStartupCommand(tab),
                    },
                    {
                        label: wsl ? 'Persistent tmux session' : 'Persistent tmux session (WSL tabs only)',
                        type: 'checkbox',
                        checked: !!meta.tmux,
                        enabled: wsl,
                        click: () => this.dialogs.setTmux(tab, !meta.tmux),
                    },
                ],
            },
        ]
    }
}

/** Toolbar badge (workspace color + initial) and command palette entries. */
@Injectable()
export class WorkspacesCommandProvider extends CommandProvider {
    constructor (
        private workspaces: WorkspacesService,
        private session: WorkspaceSession,
        private launcher: WorkspacesLauncher,
        private config: ConfigService,
        private errors: ErrorReporter,
    ) {
        super()
    }

    async provide (_context: CommandContext): Promise<Command[]> {
        // Must be a fresh object on every call: CommandService wraps `run` in its
        // global serialization queue each time, and wrapping the same object twice
        // deadlocks that queue (freezing every toolbar button and command).
        const service = this.workspaces
        const session = this.session
        // Toolbar buttons are collected once per window, so label and icon are live getters
        const badge = Object.defineProperties(new Command(), {
            label: { get: () => session.current ? `Workspace: ${session.current.name}` : 'Workspaces' },
            icon: { get: () => badgeIcon(session.current?.name, session.current?.color) },
        })
        badge.id = 'workspaces:menu'
        badge.locations = [CommandLocation.RightToolbar]
        badge.weight = BADGE_WEIGHT
        // Like Chrome's profile button: the launcher, where you switch, add or edit workspaces
        badge.run = async () => this.launcher.show()

        const launcher = new Command()
        launcher.id = 'workspaces:launcher'
        launcher.label = 'Workspaces: Show launcher'
        launcher.run = async () => this.launcher.show()

        // Start page of a window without a workspace: one entry per recent workspace
        // (like Chrome's profile picker), then "All workspaces…" for the launcher
        const settings = workspacesSettings(this.config)
        const recent = session.current || !settings.startPageList ? [] : service.sortedWorkspaces().slice(0, startPageCount(settings))
        const entries = recent.map(workspace => {
            const entry = new Command()
            entry.id = `workspaces:start-page:${workspace.id}`
            entry.label = workspace.name
            entry.icon = badgeIcon(workspace.name, workspace.color)
            entry.locations = [CommandLocation.StartPage]
            entry.weight = 0
            entry.run = async () => this.errors.run(`Could not open "${workspace.name}"`, () => service.openWorkspace(workspace))
            return entry
        })

        const startPage = new Command()
        startPage.id = 'workspaces:start-page'
        startPage.label = recent.length ? 'All workspaces…' : 'Workspaces'
        startPage.icon = START_PAGE_ICON
        startPage.locations = [CommandLocation.StartPage]
        startPage.weight = 0
        startPage.run = async () => this.launcher.show()

        return [
            ...settings.toolbarBadge ? [badge] : [],
            launcher, ...entries,
            ...settings.startPageList ? [startPage] : [],
        ]
    }
}

/** Left of Tabby's own right-hand toolbar buttons (settings cog is 0) */
const BADGE_WEIGHT = -10

/**
 * When Tabby starts, show the workspace launcher instead of the terminal it would
 * auto-open. Runs just before tabby-local's AutoOpenTabCLIHandler (priority -1000);
 * handlers for explicit CLI commands (`tabby run`, `tabby open`, ...) have higher
 * priority and still win. With "Open the last workspace" on, that workspace opens instead
 * of the launcher. With "Show on startup" off this does nothing, so Tabby
 * starts as usual. Only the first window gets this event; second-instance launches
 * and new windows already start empty.
 */
@Injectable()
export class WorkspacesStartupCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = -999.5

    constructor (
        private config: ConfigService,
        private launcher: WorkspacesLauncher,
        private service: WorkspacesService,
        private errors: ErrorReporter,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        // enableWelcomeTab: Tabby's own first-run screen gets priority
        if (event.secondInstance || this.config.store.enableWelcomeTab || !this.launcher.showOnStartup) {
            return false
        }
        if (workspacesSettings(this.config).openLastWorkspace && this.service.sortedWorkspaces().length) {
            // Not awaited: the workspace opens once Tabby's startup is done. If it can't
            // (already open in another window), the launcher shows instead.
            this.service.openLastOnStartup()
                .then(opened => opened || this.launcher.show())
                .catch(error => {
                    this.errors.report('Could not open the last workspace', error)
                    this.launcher.show()
                })
            return true
        }
        this.launcher.show()
        return true
    }
}

// Same 16px stroke style as Tabby's own start page icons: stacked windows
const START_PAGE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
    <rect x="4.5" y="1.5" width="10" height="8" rx="1.2"/>
    <path d="M2.5 5.5v7.8c0 .7.5 1.2 1.2 1.2h7.8"/>
</svg>`

@Injectable()
export class WorkspacesHotkeyProvider extends HotkeyProvider {
    async provide (): Promise<HotkeyDescription[]> {
        return [
            { id: HOTKEY_LAUNCHER, name: 'Workspaces: show launcher' },
        ]
    }
}

function badgeIcon (name?: string, color?: string): string {
    const initial = escapeXml(initialOf(name))
    const fill = safeColor(color)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
        <circle cx="8" cy="8" r="7.5" fill="${fill}"/>
        <text x="8" y="11.6" text-anchor="middle" font-size="10" font-weight="700" font-family="sans-serif" fill="#fff">${initial}</text>
    </svg>`
}

function escapeXml (value: string): string {
    return value.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)
}
