# Tabby Workspaces

Chrome-like workspaces for [Tabby](https://tabby.sh): one window per workspace, and pinned, named tabs that come back each time you open it.

## Build & install

```bash
npm install --legacy-peer-deps
npm run build
```

Copy `package.json` and `dist` into `%APPDATA%\tabby\plugins\node_modules\tabby-workspaces`, then restart Tabby completely. To uninstall, delete that folder.

`npm run typecheck` runs the TypeScript checks. `npm run watch` rebuilds on every change.

## Usage

| What | How |
|---|---|
| Pick a workspace | Shown automatically when a window opens. Type a new name to create one. |
| Open another workspace (new window) | `Ctrl+Alt+N`, the colored badge in the tab bar, or the command palette |
| Workspace menu (rename, color, delete, export, import) | `Ctrl+Alt+W` or click the badge |
| Pin a tab | Right-click the tab, then **Pin** (or the `pin-tab` hotkey). You're asked for a name. |
| Rename a pin, set its startup command, toggle tmux | Right-click a pinned tab, then **Pinned tab** |

You can change the hotkeys under Settings → Hotkeys ("Workspaces: …").

### Behaviour
- Pinned tabs are saved continuously: profile, working directory, name and startup command.
- **WSL working directory** works without any shell setup. Tabby itself can't see where a WSL shell has `cd`'d (it only owns `wsl.exe`), so the plugin starts each WSL shell with a `TABBY_WORKSPACES_TAB` id (passed in via `WSLENV`) and, when saving, reads that shell's cwd from `/proc` with one `wsl.exe` call per distro. For tmux pins this is the folder tmux was attached from; tmux keeps its own panes' folders.
- Unpinned tabs live until you close the window, just like in Chrome.
- Unpinning a tab keeps it open, but it won't come back next time.
- A workspace can be open in only one window. Picking it again brings its existing window to the front.
- The plugin turns off Tabby's built-in "Restore terminal tabs on app start", because that feature only supports one window.
- **tmux** (WSL tabs only, off by default): the tab attaches to `tabby-<workspace>-<pin>`. The session survives closing the window. Unpinning the tab and then closing it, or switching tmux off, kills the session. WSL may shut the distro down after all its terminals are closed, and that also ends tmux. Set `instanceIdleTimeout`/`vmIdleTimeout` in `.wslconfig` if that happens.
- **Export** writes a JSON file containing every workspace and its pins. This includes the connection profiles of the pinned tabs, so treat the file as private.
