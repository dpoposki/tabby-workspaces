import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { BaseTabComponent, NotificationsService, PlatformService, PromptModalComponent, SelectorService } from 'tabby-core'
import { plural, Workspace, WORKSPACE_COLORS } from './models'
import { WorkspaceStore } from './store'
import { WorkspacesService } from './workspaces.service'
import { WorkspaceSession } from './session'
import { getTerminal } from './terminal'
import { getWslTarget } from './wsl'
import { buildTmuxCommand, killTmuxSession, tmuxSessionName } from './tmux'

/**
 * The questions the plugin asks (names, colors, confirmations), for the launcher's card
 * menu and the pinned-tab context menu. Each asks, then calls a plain action; each returns
 * whether anything changed.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceDialogs {
    constructor (
        private ngbModal: NgbModal,
        private selector: SelectorService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private store: WorkspaceStore,
        private workspaces: WorkspacesService,
        private session: WorkspaceSession,
    ) { }

    // ---------------------------------------------------------------- workspaces

    async rename (workspace: Workspace): Promise<boolean> {
        const name = await this.prompt('Rename workspace', workspace.name)
        if (!name || name === workspace.name) {
            return false
        }
        this.workspaces.rename(workspace.id, name)
        return true
    }

    async changeColor (workspace: Workspace): Promise<boolean> {
        const color = await this.pickColor(workspace.color)
        if (color === workspace.color) {
            return false
        }
        this.workspaces.setColor(workspace.id, color)
        return true
    }

    async delete (workspace: Workspace): Promise<boolean> {
        if (!await this.workspaces.canDelete(workspace.id)) {
            this.notifications.info('Workspace is open', 'Close its window before deleting it.')
            return false
        }
        const answer = await this.platform.showMessageBox({
            type: 'warning',
            message: `Delete workspace "${workspace.name}"?`,
            detail: `Its ${plural(this.store.getPins(workspace.id).length, 'pinned tab')} will be forgotten. This cannot be undone.`,
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })
        if (answer.response !== 0) {
            return false
        }
        // Checked again: it may have been opened somewhere while the question was up
        if (!await this.workspaces.delete(workspace.id)) {
            this.notifications.info('Workspace is open', 'It was opened while you were deciding; close its window first.')
            return false
        }
        this.notifications.notice(`Workspace "${workspace.name}" deleted`)
        return true
    }

    // ---------------------------------------------------------------- pinned tabs

    async editStartupCommand (tab: BaseTabComponent): Promise<void> {
        const meta = this.session.getMeta(tab)
        const value = await this.prompt('Command to run when this tab is restored (leave empty for none)', meta.startupCommand ?? '', true)
        if (value === null) {
            return
        }
        meta.startupCommand = value || undefined
        this.session.scheduleSave()
    }

    async setTmux (tab: BaseTabComponent, enabled: boolean): Promise<void> {
        const workspace = this.session.current
        const meta = this.session.getMeta(tab)
        const terminal = getTerminal(tab)
        const target = getWslTarget(terminal)
        if (!workspace || !target) {
            return
        }
        const name = tmuxSessionName(workspace.id, meta.id)
        if (enabled) {
            meta.tmux = true
            this.session.scheduleSave()
            const answer = await this.platform.showMessageBox({
                type: 'warning',
                message: 'Start the tmux session in this tab now?',
                detail: 'The session survives closing the window. If you choose "Next time", tmux starts when this workspace is opened again.\n\nOnly start now if the tab is at a shell prompt.',
                buttons: ['Start now', 'Next time'],
                defaultId: 0,
                cancelId: 1,
            })
            if (answer.response === 0) {
                terminal.sendInput(buildTmuxCommand(name, meta.startupCommand) + '\r')
            }
        } else {
            const answer = await this.platform.showMessageBox({
                type: 'warning',
                message: 'Stop the persistent session?',
                detail: 'The tmux session for this tab is ended now, along with anything running in it.',
                buttons: ['Stop session', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            })
            if (answer.response !== 0) {
                return
            }
            meta.tmux = false
            killTmuxSession(target, name)
            this.session.scheduleSave()
        }
    }

    // ---------------------------------------------------------------- primitives

    private async pickColor (current: string): Promise<string> {
        try {
            return await this.selector.show('Workspace color', WORKSPACE_COLORS.map(x => ({
                name: x.name,
                description: x.value === current ? 'Current' : undefined,
                color: x.value,
                icon: 'fas fa-circle',
                result: x.value,
            })))
        } catch {
            return current
        }
    }

    /** Returns the entered text, '' if emptied (when allowEmpty), or null if cancelled. */
    private async prompt (text: string, value = '', allowEmpty = false): Promise<string | null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = text
        modal.componentInstance.value = value
        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }
        const trimmed = (result.value ?? '').trim()
        return trimmed || allowEmpty ? trimmed : null
    }
}
