import { Component, Injectable } from '@angular/core'
import { ConfigService, HostAppService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { WorkspacesBackup } from './backup'
import { ErrorReporter } from './errors'
import { TaskbarIdentity } from './taskbar'
import { START_PAGE_COUNT_MAX, START_PAGE_COUNT_MIN } from './config'

/** Settings → Workspaces */
@Component({
    template: `
        <h3 class="mb-3">Workspaces</h3>

        <div class="form-line">
            <div class="header">
                <div class="title">Show launcher on startup</div>
                <div class="description">Pick a workspace (or guest mode) when Tabby starts, instead of opening a terminal</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.showLauncher" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line" *ngIf="config.store.workspaces.showLauncher">
            <div class="header">
                <div class="title">Open the last workspace</div>
                <div class="description">Skip the launcher and reopen the workspace you used last. If it's already open in another window, the launcher shows as usual</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.openLastWorkspace" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">List workspaces on the start page</div>
                <div class="description">Recent workspaces between "New terminal" and "Profiles & connections"</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.startPageList" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line" *ngIf="config.store.workspaces.startPageList">
            <div class="header">
                <div class="title">Workspaces on the start page</div>
                <div class="description">How many recent workspaces it lists ({{ countMin }}–{{ countMax }})</div>
            </div>
            <input class="form-control" type="number" style="width: 6rem"
                [min]="countMin" [max]="countMax" step="1"
                [(ngModel)]="config.store.workspaces.startPageCount" (ngModelChange)="config.save()">
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">tmux for new WSL pins</div>
                <div class="description">New pins of WSL tabs get a persistent tmux session, which starts the next time the workspace opens. You can still switch it per pin: right-click the tab → Pinned tab</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.tmuxByDefault" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Toolbar badge</div>
                <div class="description">Workspace color and initial in the top right; click it to switch, add or edit workspaces. Applies to new windows</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.toolbarBadge" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Color stripe</div>
                <div class="description">Thin line in the workspace color across the top of the window</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.colorStripe" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line" *ngIf="taskbarSupported">
            <div class="header">
                <div class="title">Taskbar icon</div>
                <div class="description">Each workspace window gets its own taskbar button, with the workspace's color and initial on the Tabby icon. Turning it off applies to new windows</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.taskbarIcon" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Backup</div>
                <div class="description">All workspaces with their pinned tabs, as a JSON file</div>
            </div>
            <div class="d-flex gap-2">
                <button class="btn btn-secondary" (click)="errors.run('Export failed', exportWorkspaces)">
                    <i class="fas fa-file-export me-2"></i>Export…
                </button>
                <button class="btn btn-secondary" (click)="errors.run('Import failed', importWorkspaces)">
                    <i class="fas fa-file-import me-2"></i>Import…
                </button>
            </div>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Hotkeys</div>
                <div class="description">"Workspaces: show launcher" is under Settings → Hotkeys</div>
            </div>
        </div>
    `,
})
export class WorkspacesSettingsTabComponent {
    /** Not on macOS, where windows are told apart by their title */
    taskbarSupported: boolean
    countMin = START_PAGE_COUNT_MIN
    countMax = START_PAGE_COUNT_MAX

    exportWorkspaces = () => this.backup.exportWorkspaces()
    importWorkspaces = () => this.backup.importWorkspaces()

    constructor (
        public config: ConfigService,
        public errors: ErrorReporter,
        private backup: WorkspacesBackup,
        hostApp: HostAppService,
    ) {
        this.taskbarSupported = TaskbarIdentity.isSupported(hostApp.platform)
    }
}

@Injectable()
export class WorkspacesSettingsTabProvider extends SettingsTabProvider {
    id = 'workspaces'
    icon = 'window-restore'
    title = 'Workspaces'

    getComponentType (): any {
        return WorkspacesSettingsTabComponent
    }
}
