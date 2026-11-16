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
| Pick a workspace | When Tabby starts, it shows the **launcher**: a full-window screen with one card per workspace (like Chrome's profile picker). Click a card (or press `1`–`9`) to open it, **Add** to create one, or **Guest mode** for a plain terminal with nothing saved. `Esc` closes the launcher. Empty windows also list your recent workspaces on the start page, between **New terminal** and **Profiles & connections**; **All workspaces…** reopens the launcher, and so does **Workspaces: Show launcher** in the command palette. |
| Open another workspace (new window) | `Ctrl+Alt+N`, the colored badge in the tab bar, or the command palette |
| Workspace menu (rename, color, delete, export, import) | `Ctrl+Alt+W` or click the badge |
| Pin a tab | Right-click the tab, then **Pin** (or the `pin-tab` hotkey). You're asked for a name. |
| Rename a pin, set its startup command, toggle tmux | Right-click a pinned tab, then **Pinned tab** |

You can change the hotkeys under Settings → Hotkeys ("Workspaces: …").

### Settings
**Settings → Workspaces**:
- **Show launcher on startup**: off gives you Tabby's usual startup (a terminal).
- **List workspaces on the start page**
- **Toolbar badge**: the colored badge in the tab bar (applies to new windows).
- **Color stripe**: the workspace-colored line across the top of the window.
- **Export / Import**: all workspaces and their pins as one JSON file.

### Behaviour
- Pinned tabs are saved continuously: profile, working directory, name and startup command.
- **WSL working directory** works without any shell setup. Tabby itself can't see where a WSL shell has `cd`'d (it only owns `wsl.exe`), so the plugin starts each WSL shell with a `TABBY_WORKSPACES_TAB` id (passed in via `WSLENV`) and, when saving, reads that shell's cwd from `/proc` with one `wsl.exe` call per distro. For tmux pins this is the folder tmux was attached from; tmux keeps its own panes' folders.
- On startup the launcher replaces the terminal Tabby normally opens. Turn off **Show on startup** (bottom right of the launcher, or Settings → Workspaces) to get Tabby's usual startup back; the start page entries and **Workspaces: Show launcher** still work. Explicit command-line launches (`tabby run …`, `tabby open …`) and Tabby's first-run welcome screen are not affected. Opening a tab any other way (e.g. a hotkey) also closes the launcher.
- Unpinned tabs live until you close the window, just like in Chrome.
- Unpinning a tab keeps it open, but it won't come back next time.
- A workspace can be open in only one window. Picking it again brings its existing window to the front.
- The plugin turns off Tabby's built-in "Restore terminal tabs on app start", because that feature only supports one window.
- **tmux** (WSL tabs only, off by default): the tab attaches to `tabby-<workspace>-<pin>`. The session survives closing the window. Unpinning the tab and then closing it, or switching tmux off, kills the session. WSL may shut the distro down after all its terminals are closed, and that also ends tmux. Set `instanceIdleTimeout`/`vmIdleTimeout` in `.wslconfig` if that happens.
- **Export** writes a JSON file containing every workspace and its pins. This includes the connection profiles of the pinned tabs, so treat the file as private.
