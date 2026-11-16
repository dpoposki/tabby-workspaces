// The published tabby-core typings predate tab pinning; the installed Tabby build has it.
import 'tabby-core'

declare module 'tabby-core' {
    interface BaseTabComponent {
        pinned: boolean
        readonly effectivelyPinned: boolean
    }
    interface AppService {
        pinTab (tab: BaseTabComponent): void
        unpinTab (tab: BaseTabComponent): void
        toggleTabPinned (tab: BaseTabComponent): void
    }
}
