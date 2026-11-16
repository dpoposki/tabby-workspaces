import { Injectable } from '@angular/core'
import {
    AppService, BaseTabComponent, CLIEvent, CLIHandler, Command, CommandContext, CommandLocation, CommandProvider,
    ConfigProvider, ConfigService, HotkeyDescription, HotkeyProvider, MenuItemOptions, TabContextMenuItemProvider,
} from 'tabby-core'
import { WorkspacesService } from './workspaces.service'
import { isWslTab } from './terminal'
import { WorkspacesLauncher } from './launcher'

/** Right-click menu on a pinned tab: pin name, startup command, tmux. */
@Injectable()
export class WorkspacesTabContextMenu extends TabContextMenuItemProvider {
    weight = 5

    constructor (private app: AppService, private workspaces: WorkspacesService) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (!tabHeader || !this.workspaces.current || !tab.pinned || !this.app.tabs.includes(tab)) {
            return []
        }
        const meta = this.workspaces.getMeta(tab)
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
                        click: () => this.workspaces.editStartupCommand(tab),
                    },
                    {
                        label: wsl ? 'Persistent tmux session' : 'Persistent tmux session (WSL tabs only)',
                        type: 'checkbox',
                        checked: !!meta.tmux,
                        enabled: wsl,
                        click: () => this.workspaces.setTmux(tab, !meta.tmux),
                    },
                ],
            },
        ]
    }
}

/** Toolbar badge (workspace color + initial) and command palette entries. */
@Injectable()
export class WorkspacesCommandProvider extends CommandProvider {
    constructor (private workspaces: WorkspacesService, private launcher: WorkspacesLauncher, private config: ConfigService) {
        super()
    }

    async provide (_context: CommandContext): Promise<Command[]> {
        // Must be a fresh object on every call: CommandService wraps `run` in its
        // global serialization queue each time, and wrapping the same object twice
        // deadlocks that queue (freezing every toolbar button and command).
        const service = this.workspaces
        // Toolbar buttons are collected once per window, so label and icon are live getters
        const badge = Object.defineProperties(new Command(), {
            label: { get: () => service.current ? `Workspace: ${service.current.name}` : 'Workspaces' },
            icon: { get: () => badgeIcon(service.current?.name, service.current?.color) },
        })
        badge.id = 'workspaces:menu'
        badge.locations = [CommandLocation.RightToolbar]
        badge.weight = -10
        // Like Chrome's profile button: the launcher, where you switch, add or edit workspaces
        badge.run = async () => this.launcher.show()

        const open = new Command()
        open.id = 'workspaces:open'
        open.label = 'Workspaces: Open another workspace'
        open.run = async () => { service.showPicker().catch(error => console.error('[workspaces]', error)) }

        const launcher = new Command()
        launcher.id = 'workspaces:launcher'
        launcher.label = 'Workspaces: Show launcher'
        launcher.run = async () => this.launcher.show()

        // Start page of a window without a workspace: one entry per recent workspace
        // (like Chrome's profile picker), then the full picker
        const settings = this.config.store.workspaces
        const recent = service.current || !settings.startPageList ? [] : service.sortedWorkspaces().slice(0, START_PAGE_MAX_WORKSPACES)
        const entries = recent.map((workspace, index) => {
            const entry = new Command()
            entry.id = `workspaces:start-page:${workspace.id}`
            entry.label = workspace.name
            entry.icon = badgeIcon(workspace.name, workspace.color)
            entry.locations = [CommandLocation.StartPage]
            entry.weight = 0
            entry.run = async () => { service.openWorkspace(workspace).catch(error => console.error('[workspaces]', error)) }
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
            open, launcher, ...entries,
            ...settings.startPageList ? [startPage] : [],
        ]
    }
}

const START_PAGE_MAX_WORKSPACES = 8

/**
 * When Tabby starts, show the workspace launcher instead of the terminal it would
 * auto-open. Runs just before tabby-local's AutoOpenTabCLIHandler (priority -1000);
 * handlers for explicit CLI commands (`tabby run`, `tabby open`, ...) have higher
 * priority and still win. With "Show on startup" off this does nothing, so Tabby
 * starts as usual. Only the first window gets this event; second-instance launches
 * and new windows already start empty.
 */
@Injectable()
export class WorkspacesStartupCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = -999.5

    constructor (private config: ConfigService, private launcher: WorkspacesLauncher) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        // enableWelcomeTab: Tabby's own first-run screen gets priority
        if (event.secondInstance || this.config.store.enableWelcomeTab || !this.launcher.showOnStartup) {
            return false
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
            { id: 'workspaces-open', name: 'Workspaces: open another workspace' },
            { id: 'workspaces-menu', name: 'Workspaces: menu' },
        ]
    }
}

@Injectable()
export class WorkspacesConfigProvider extends ConfigProvider {
    defaults = {
        workspaces: {
            showLauncher: true,
            startPageList: true,
            toolbarBadge: true,
            colorStripe: true,
        },
        hotkeys: {
            'workspaces-open': ['Ctrl-Alt-N'],
            'workspaces-menu': ['Ctrl-Alt-W'],
        },
    }
}

function badgeIcon (name?: string, color?: string): string {
    const initial = escapeXml((name?.trim()[0] ?? '?').toUpperCase())
    const fill = color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#6b7280'
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
        <circle cx="8" cy="8" r="7.5" fill="${fill}"/>
        <text x="8" y="11.6" text-anchor="middle" font-size="10" font-weight="700" font-family="sans-serif" fill="#fff">${initial}</text>
    </svg>`
}

function escapeXml (value: string): string {
    return value.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)
}
