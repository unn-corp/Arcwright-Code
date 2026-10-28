# Appearance and themes

On web and desktop, open **Settings → Appearance** to follow the system appearance or stay in
light or dark mode. Choose **Manage themes** to browse the theme library. To use different themes
for light and dark mode, select the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Standard thread feed

Standard threads use the original T3 chat layout by default. **Upstream chat feed** in
**Settings → Appearance** hides Arcwright participant chips, AI bubbles, reply controls,
and added subagent activity rows. Organization conversations keep their Arcwright layout.
The choice is saved on each web, desktop, or fork Android client. Existing messages and
reply metadata are preserved; turn the option off to use the Arcwright feed in standard threads.

## AI message bubbles

Turn on **AI message bubbles** in **Settings → Appearance** to display AI replies as rounded
chat messages. Turn it off to return to the standard layout. This preference is saved on each
web, desktop, or fork Android client and also applies while replies stream. It is available
with the Arcwright feed; choosing the upstream feed retains your bubble preference for later.

## Chat participants and your profile

Open **Settings → General → Profile** to set your chat name, upload a photo, or use initials.
When signed in, uploading a photo or choosing initials updates your Arcwright Connect account.
Other signed-in web, desktop, and fork Android clients refresh that photo when brought forward
and about once a minute while visible. Removing the photo also syncs; it does not restore an
older Google image. Your chosen chat name stays local to each device or browser. Older manually
uploaded device photos stay in place until you replace them; unsigned profiles remain
local. Provider API keys and environment Git credentials do not set your personal photo.
Sent messages carry their name and photo to other connected clients. On this client,
messages and replies by a known user display that user’s current profile, including
older chats. Older messages without a recorded author use your active profile.
Messages by other recorded users keep their identity; changing your profile does not rewrite history.

Agent chips show the recorded model when it is known. Colors follow the conversation's
agent instance, including through retries and model changes. Different child agents receive
automatic colors. Select an agent chip to choose its color or restore the automatic color.
Color choices are saved on this device or browser. Old messages without model or author metadata
use a neutral fallback rather than guessing today's model or profile.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** in **Settings → Appearance** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a Arcwright Code or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. app.t3.codes and additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, Arcwright Code falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
t3 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `t3 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`t3 theme clear` removes the default without changing anyone's current theme. `t3 theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from Arcwright Code into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `t3 theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. Arcwright Code
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.
