# Changes

## Unreleased

* **Opens without a jump**: the window shows its layout (title bar, list, loading bar) from the first frame, in the
  theme it was last shown in, and the form's scripts fill it in place.
* **Starts sooner**: who you are, the environment and the form are read while the manager's own code is still
  starting, so a form's first script shows two round trips to the server sooner (about 30% sooner in a test with
  150 ms per request). Reads only. On premises nothing else is read until the server has confirmed that it answers
  for the page's organization.

## 1.0.0 (November 2026)

The first release: a bookmarklet to edit the JavaScript of a Dataverse (Dynamics 365, Power Apps) form right on the
form, in Visual Studio Code's editor, from your signed-in Dynamics tab.

**Editing**

* **Opened on a form**, it lists that form's scripts (its libraries in load order, and the scripts they depend on) and
  opens the first one. The form and its scripts are read directly, so they show before the list of every web resource
  in the environment is read. Elsewhere: choose a solution, or all web resources (remembered for next time).
* **VS Code's editor (Monaco)**, with its keys and VS Code's Dark+ and Light+ colours, a theme switch, and IntelliSense
  for the Xrm client API and the form's columns.
* **Go to Definition** (F12, Ctrl+Click; also into the form's other scripts), Peek (Alt+F12), **Find All References**
  (Shift+F12), **Rename** of local names (F2), Format (Shift+Alt+F, Ctrl+K Ctrl+F) and the command palette (F1). They
  come from the script's syntax tree: VS Code's TypeScript service doesn't fit in a bookmarklet.
* **Only real errors are underlined**: syntax errors and the removed 2011 OData endpoint, not `Xrm.Page`.
* **Changes are plain to see**: an *Unsaved changes* badge, a dot in the list, a count, change bars in the editor.
* **Compare** shows the saved (or published) version beside the script, which you keep editing, as in VS Code.
* **History**: the versions kept in your browser (each save and publish, the version each one replaced, what was live
  before each publish), compared with the script and restored as unsaved changes: a publish can be undone.
* **⋯ menu**: New script, Format, Minify, Download, Replace with a file, Copy name, Open in a new tab, Forms that load it.
* **A window over the page**: moved by its title bar, resized by its edges, maximized, restored, hidden; it opens
  where it was left.

**Saving safely**

* Every save reads the server's latest saved version first and never writes over someone else's change: the conflict
  shows both versions to take theirs, keep yours, or combine both. What was saved is read back and checked.
* Scripts open in their latest saved version (`RetrieveUnpublished`), not the published one.
* Publishing names only the scripts saved (`PublishXml`, never "publish all" nor the form), says first when someone
  else's saved change would go live with yours, asks in Production, and checks what went live.
* Unsaved changes are kept in the browser (IndexedDB of the environment's own address): a reload or a crash loses
  nothing. Nothing is sent anywhere but the environment's Web API, with your own session.
