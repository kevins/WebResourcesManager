# Web Resources Manager — architecture

A bookmarklet that opens a Visual Studio Code-style manager for the web resources of the Dataverse environment the
user is signed in to, in that same browser tab. This document is the map of the code and the contract between its
parts. Read it before changing anything.

## 1. Runtime

```
favorite (javascript: URL, ≤ 2,000,000 chars)
  └─ loader: base85 → DecompressionStream('deflate-raw') → indirect eval     (tools/build.mjs writes it)
       └─ src/boot/bootstrap.ts  runs ON THE DYNAMICS PAGE
            ├─ where(): environment page, maker portal, or neither (alert)
            ├─ one manager per tab: window.__wrManager (same build toggles, other build is replaced, busy refuses)
            ├─ <div id="wrm-host"><iframe id="wrm-frame"></div>: a window over the page (moved by the screen's title
            │  bar, resized by its 6 px edge on the page, maximized to fill the page; where it was is kept in
            │  localStorage 'wrm.window') + the minimized pill
            └─ frame.contentWindow.eval(APP)   (blob: script if eval is forbidden)
                 └─ src/app/main.tsx  runs IN THE FRAME (its own realm, document and styles; origin = the page's)
                      ├─ connect(): WhoAmI, organization, user → Conn (core/connect.ts)
                      ├─ Workspace (model/workspace.ts): state + services
                      └─ <SimpleApp/> (ui/simple.tsx): the scripts of the page's form (or a solution, or all) and the
                         editor, rendered with Preact
```

* The frame is an empty same-origin document, so requests from it carry the page's session cookie (environment page)
  and its storage (IndexedDB) is the environment's. On the maker portal the frame borrows the portal's access token
  (core/connect.ts, as Unmanaged Layer Scanner does) and sends it only to that environment's host.
* Nothing is ever loaded from the network except the environment's Web API. Monaco, its worker, the codicon font,
  js-beautify, acorn, astring, fflate and Preact are all inside the bookmarklet.
* `window.__wrmHost` (in the frame) is the bootstrap's `Host` (src/boot/bootstrap.ts): `page` (the Dynamics window),
  `ready()`, `minimize()`, `close()`, `pill()`, `guardUnload()`, `fail()`, and `win` (the window: `maximized()`,
  `toggleMaximized()`, `dragStart/dragTo/dragEnd` with the pointer in the frame's coordinates, `onChange`).
* The theme the screen was last shown in is kept in localStorage (`wrm.theme`, core/theme.ts): the window's
  background and the screen's first render use it, before the settings (IndexedDB) are read.
* Opened on a form, the form XML is read at once (App's constructor), and its scripts by name
  (`Workspace.named()`): they open without waiting for the list of every web resource, which `ws.start()` reads
  meanwhile (`ws.restore()` first restores settings and drafts). A solution and all wait for that list.

## 2. Source layout

| Folder | What | Rules |
|---|---|---|
| `src/boot/` | The bootstrap (page side) | Tiny. No Preact, no Monaco. |
| `src/core/` | HTTP client, connection, IndexedDB, signals, helpers | No UI. |
| `src/dataverse/` | Every Dataverse operation, as functions of `Http` | No state, no UI. Every function documents the exact request. |
| `src/model/` | Types, the Workspace (state + services: drafts, saving, publishing, conflicts, history), names, diff | No Preact. |
| `src/editor/` | Monaco set-up, the JavaScript colours, formatting, minifying, checks (lint), Xrm IntelliSense, outline | No Preact. |
| `src/ui/` | Preact: the screen (simple.tsx), the editor host, the conflict editor, widgets, commands | Reads state through hooks; changes it only through Workspace methods or commands. |
| `tools/` | The build (`build.mjs`) and the install page (`install-page.mjs`) | Node only. |

### The screen

| Module | What it does |
|---|---|
| `ui/simple.tsx` | The screen: a header (environment, Production badge, theme, hide, maximize, close), the list of scripts (this form's, a solution's or all, with a filter and the unsaved / not-published marks), the file bar (state badge, Compare, History, Discard, Save, Save & Publish, the ⋯ menu) and the editor, the comparison or the history |
| `ui/editorhost.ts` | The one Monaco code editor and the one diff editor; a model per opened file; typing → drafts (after 250 ms); change bars; checks (only errors are shown) |
| `ui/editors/conflict.tsx` | The conflict editor: theirs beside yours, take theirs / keep mine / save the merge |
| `editor/*` | Monaco set-up, the Dark+ JavaScript colours, Xrm IntelliSense, formatting, checks; Go to Definition, Find All References and Rename (`jsscope.ts`: scopes and namespace paths from acorn's syntax tree; `jsnav.ts`: the providers) |

The page's form comes from `Xrm.Utility.getPageContext().input` (pageType `entityrecord`, `formId`, else
`Xrm.Page.ui.formSelector`); its scripts are the `<formLibraries>` of its latest saved form XML
(`dataverse/forms.ts` getFormXml, `dataverse/formxml.ts` parseForm), in the order the form loads them. A choice
of solution or all is remembered per environment (store key `simple-source`).


## 3. State

All state lives in `Signal`s (core/emitter.ts) on the `Workspace`. Components read them with `useSignal` /
`useSelect` (ui/hooks.ts). Nothing else holds a copy that can go stale.

Key types are in `src/model/model.ts`: `WebResource`, `Content`, `Draft`, `Base`, `Conflict`, `Change`, `Solution`,
`Scope`, `Filter`, `EditorTab`, `Settings`.

### Versions of a web resource

| Name | Where it comes from | Shown as |
|---|---|---|
| **published** | `GET webresourceset(id)` | what users of the app get |
| **saved** (server) | `RetrieveUnpublished` (the latest saved; equals published when there is no pending change) | "Saved, not published" when it differs from published |
| **base** | the saved version the user's draft started from (kept with the draft) | the left side of "Changes" |
| **draft** | the user's unsaved edit, kept in IndexedDB on every change | the editor's content |
| **theirs** | the saved version found newer than base at save time | the conflict editor |

Versions are compared by their `@odata.etag` text (`versionnumber` is a 64-bit number JavaScript rounds) and a
fingerprint of the content.

## 4. Saving and publishing (model/workspace.ts) — the part that must never lose work

Saves and publishes run one after another (`serial`): a second Ctrl+S waits for the first, then saves what is left.
Other writes that could race a save (rename, delete, discarding a saved change, form and table-icon publishes) go
through `ws.exclusive(…)`.

For each draft to save:

1. **Guards**: read-only mode or a locked environment saves nothing; a draft with a conflict is not saved; content
   made empty or cut to less than a quarter of the server's is confirmed first; managed, not customizable web
   resources are refused; content over the organization's upload limit (counted as Base64) is refused.
2. **Read the server's saved version again** and compare it with the draft's base (`patchIfUnchanged`,
   dataverse/common.ts): same ETag, or exactly the base's value for everything the draft changes. Otherwise →
   **conflict**: nothing is written; the conflict editor shows theirs and yours. A change on the server the draft
   doesn't touch is not a conflict: the draft is rebased on it.
3. **PATCH only the changed columns** with `If-Match: *` (ETags are not dependable for web resources; `*` makes
   sure a deleted row is never re-created).
4. **Verify**: read again; the stored content must be what was sent. The version before the save and the saved one
   go to the local history. Text typed while the save ran stays a draft, now based on the version just saved
   (`settle`).
5. **Publish** (when asked): the question comes before anything is written (Save and Publish: Cancel writes nothing).
   Saved changes made by someone else are listed (publishing makes them live too); Production always asks. Right
   before PublishXml the saved versions are compared with what the question showed: one saved meanwhile is asked about
   again. One `PublishXml` for all of them, retried while another customization holds
   the lock. Afterwards the published version is read back and must equal the saved one (verified publish).

New web resources: name checked (rules, prefix of the target solution's publisher, not taken — case-insensitive),
created with `POST webresourceset` and header `MSCRM.SolutionUniqueName` (creates are published at once), then read
back. A create whose answer was lost is looked up by name before it is reported as failed. Its draft key
(`new:<name>`) becomes the new id (`ws.rekeyed`), and open tabs and models follow it.

Other writers follow the same rules: forms are saved only if nobody saved them since they were read (form XML
compared, then `If-Match: *`), table icons re-read the definition before a full `PUT` with `MSCRM.MergeLabels`.

## 5. UI

One screen (ui/simple.tsx), no menus, panels or tabs: the list of scripts on the left, the file bar and the editor on
the right. Colours come only from the CSS variables of ui/theme.css (Dark+); icons are codicons.

* **Buttons** do everything: Compare (your changes beside the saved version, or the saved version beside the published
  one), Discard, Save, Save & Publish (Publish when the saved version only waits to be published), Save all.
* **Keys**: Ctrl+S save, Ctrl+Shift+S save and publish, and Monaco's own (find, replace, comment, undo…).
* **An unsaved change shows** as an orange badge in the file bar, a dot on its row, the count under the list and the
  change bars in the editor. A conflict turns the badge red, with Compare and choose.
* **Publishing** asks first only in Production, or when someone else's saved change would go live too (settings key
  `confirmPublish`, off by default).
* **Feedback**: results and errors are notifications (bottom right).

## 6. Conventions

* TypeScript, strict. Preact function components with hooks. No other UI library.
* Comments say why, in plain sentences, like the rest of the code. User-facing text is plain English sentences
  that say what happened and what to do; never raw exception text alone (`explain()` maps Dataverse error codes).
* Every id, logical name or name taken from the page, a file or user input is checked (`isGuid`, `isLogicalName`,
  name rules) before it goes into a URL; string values in filters go through `q()`.
* Never retry a write that may have run (`mayHaveRun`); never swallow an error silently; a search that could not
  read a place says so instead of reporting "nothing found".
* Every write respects `ws.readOnlyReason()`, asks before anything destructive (`confirmDialog`), and in Production
  always asks before publishing.
* Size budget: the whole link must stay under 2,000,000 characters (`npm run build` fails above). Check the size
  after adding a dependency.
