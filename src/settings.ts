import { Component, Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { WorkspacesService } from './workspaces.service'

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

        <div class="form-line">
            <div class="header">
                <div class="title">List workspaces on the start page</div>
                <div class="description">Recent workspaces between "New terminal" and "Profiles & connections"</div>
            </div>
            <toggle [(ngModel)]="config.store.workspaces.startPageList" (ngModelChange)="config.save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Toolbar badge</div>
                <div class="description">Workspace color and initial in the top right; click it for the workspace menu. Applies to new windows</div>
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

        <div class="form-line">
            <div class="header">
                <div class="title">Backup</div>
                <div class="description">All workspaces with their pinned tabs, as a JSON file</div>
            </div>
            <div class="d-flex gap-2">
                <button class="btn btn-secondary" (click)="workspaces.exportWorkspaces()">
                    <i class="fas fa-file-export me-2"></i>Export…
                </button>
                <button class="btn btn-secondary" (click)="workspaces.importWorkspaces()">
                    <i class="fas fa-file-import me-2"></i>Import…
                </button>
            </div>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Hotkeys</div>
                <div class="description">"Workspaces: open another workspace" and "Workspaces: menu" are under Settings → Hotkeys</div>
            </div>
        </div>
    `,
})
export class WorkspacesSettingsTabComponent {
    constructor (public config: ConfigService, public workspaces: WorkspacesService) { }
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
