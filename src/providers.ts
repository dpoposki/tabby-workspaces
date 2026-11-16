import { Injectable } from '@angular/core'
import {
    AppService, BaseTabComponent, Command, CommandContext, CommandLocation, CommandProvider,
    ConfigProvider, HotkeyDescription, HotkeyProvider, MenuItemOptions, TabContextMenuItemProvider,
} from 'tabby-core'
import { WorkspacesService } from './workspaces.service'
import { isWslTab } from './terminal'

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
    private badge: Command

    constructor (private workspaces: WorkspacesService) {
        super()
        // Toolbar buttons are collected once per window, so label and icon are live getters
        const service = this.workspaces
        this.badge = Object.defineProperties(new Command(), {
            label: { get: () => service.current ? `Workspace: ${service.current.name}` : 'Workspaces' },
            icon: { get: () => badgeIcon(service.current?.name, service.current?.color) },
        })
        this.badge.id = 'workspaces:menu'
        this.badge.locations = [CommandLocation.RightToolbar]
        this.badge.weight = -10
        this.badge.run = () => this.workspaces.showMenu()
    }

    async provide (_context: CommandContext): Promise<Command[]> {
        const open = new Command()
        open.id = 'workspaces:open'
        open.label = 'Workspaces: Open another workspace'
        open.run = () => this.workspaces.showPicker('open')
        return [this.badge, open]
    }
}

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
