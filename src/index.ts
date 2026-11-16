import { NgModule } from '@angular/core'
import { CommandProvider, ConfigProvider, HotkeyProvider, HotkeysService, TabContextMenuItemProvider } from 'tabby-core'
import { WorkspacesService } from './workspaces.service'
import {
    WorkspacesCommandProvider, WorkspacesConfigProvider, WorkspacesHotkeyProvider, WorkspacesTabContextMenu,
} from './providers'

@NgModule({
    providers: [
        { provide: TabContextMenuItemProvider, useClass: WorkspacesTabContextMenu, multi: true },
        { provide: CommandProvider, useClass: WorkspacesCommandProvider, multi: true },
        { provide: HotkeyProvider, useClass: WorkspacesHotkeyProvider, multi: true },
        { provide: ConfigProvider, useClass: WorkspacesConfigProvider, multi: true },
    ],
})
export default class WorkspacesModule {
    constructor (workspaces: WorkspacesService, hotkeys: HotkeysService) {
        workspaces.init()
        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'workspaces-open') {
                workspaces.showPicker('open')
            } else if (hotkey === 'workspaces-menu') {
                workspaces.showMenu()
            }
        })
    }
}
