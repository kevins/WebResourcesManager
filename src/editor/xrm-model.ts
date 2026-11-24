// The client API of Dynamics 365 / Power Apps model-driven apps (v9.2), as data for the editor's IntelliSense: the
// members of each object with their parameters and return types (so chains like
// formContext.getAttribute("name").controls.get(0) resolve), short docs, deprecations and the page on Microsoft Learn.
// No Monaco here: the resolver (editor/xrm-resolve.ts) and the unit tests use it in Node.
//
// The API is written in a compact notation, one member per line, parsed when the module loads: the model ships inside
// the size-capped bookmarklet, and one line per member is also easy to check against the reference.
//   name(param: type, optional?: type): Returns ; (other: overload): Returns | Doc. | param: Doc. | !Deprecation. | @url
//   name: Type | Doc.        a property
//   name:: Type | Doc.       a namespace (Xrm.WebApi, Xrm.App.sidePanes)
// A method without a return type returns nothing. Parameters typed table, attribute or control are strings that name
// one: the editor offers those names inside the quotes. Overloads come in the order signature help shows them, the usual
// one first. URLs are relative to the client API reference ('../' leaves it): '*' is the member's name in lower case,
// '~' the folder of the type's own page.

export type Kind = 'method' | 'property' | 'namespace';
/** What a string parameter names. */
export type NameKind = 'table' | 'attribute' | 'control';

export interface Param {
  name: string;
  /** As signatures show it: 'string', 'number', 'function', 'object', 'Lookup'... */
  type: string;
  optional?: boolean;
  doc?: string;
  /** The parameter is the name of a table, a column or a control. */
  names?: NameKind;
}

export interface Signature {
  params: Param[];
  /** A type of the model ('FormContext', 'Collection<Tab>', 'Attribute[]') or plain text ('string', 'Promise<object>', 'void'). */
  returns: string;
}

export interface Member {
  name: string;
  kind: Kind;
  doc: string;
  url: string;
  /** Properties and namespaces: the type of the value. */
  type?: string;
  /** Methods: the overloads. */
  sigs?: Signature[];
  /** Why not to use it, and what to use instead. */
  deprecated?: string;
}

export interface XrmType {
  id: string;
  /** How hovers name it: 'Xrm.WebApi' for the namespaces, the id for the others. */
  name: string;
  doc: string;
  url: string;
  /** Members not found here are looked up in this type. */
  base?: string;
  members: Member[];
}

export const TYPES: Record<string, XrmType> = {};
/** The pseudo-type of the globals: Xrm and GetGlobalContext. */
export const GLOBAL = 'Global';
/** Types of the platform that types of the model may name. */
export const BUILTINS = ['Promise', 'Date', 'Window', 'Response'];

const REF = 'https://learn.microsoft.com/power-apps/developer/model-driven-apps/clientapi/';
const href = (spec: string) => REF + (spec.startsWith('../') ? spec.slice(3) : 'reference/' + spec);

/** Parameters with the same name mean the same thing almost everywhere: their docs are written once. */
const PARAM_DOCS: Record<string, string> = {
  handler: 'The function; it receives the execution context as its first argument. Pass a named function to be able to remove it.',
  callbackFunction: 'Called when the operation is done.',
  visible: 'true to show, false to hide.',
  disabled: 'true to disable, false to enable.',
  label: 'The new label.',
  uniqueId: 'The ID of the notification.',
  entityLogicalName: 'The logical name of the table, like "account".',
  entityName: 'The logical name of the table, like "account".',
  id: 'The ID (GUID) of the record.',
  index: 'The position in the collection, from 0.',
  delegate: 'function (item, index) that returns true for the items to return.',
  requirementLevel: '"none", "required" or "recommended".',
  mode: '"always", "never" or "dirty".',
  state: '"expanded" or "collapsed".',
  message: 'The text to show.',
};

function signature(text: string, line: string): Signature {
  const m = /^\((.*)\)(?::\s*(.+))?$/.exec(text.trim());
  if (!m) throw new Error(`xrm-model: ${line}`);
  const params = m[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): Param => {
      const q = /^(\w+)(\?)?: (.+)$/.exec(p);
      if (!q) throw new Error(`xrm-model: ${line}`);
      const names = /^(table|attribute|control)(\[\])?$/.exec(q[3]);
      const param: Param = { name: q[1], type: names ? 'string' + (names[2] || '') : q[3] };
      if (q[2]) param.optional = true;
      if (names) param.names = names[1] as NameKind;
      return param;
    });
  return { params, returns: m[2]?.trim() || 'void' };
}

function parseMember(line: string, pattern: string, dir: string): Member {
  const [head, doc = '', ...fields] = line.split(' | ');
  const m = /^(\w+)(::?)?\s*(.*)$/.exec(head);
  if (!m || !doc) throw new Error(`xrm-model: ${line}`);
  const [, name, colon, rest] = m;
  const member: Member = { name, kind: colon === '::' ? 'namespace' : colon ? 'property' : 'method', doc, url: '' };
  if (colon) member.type = rest.trim();
  else member.sigs = rest.split(/\s*;\s*/).map((s) => signature(s, line));
  const params = member.sigs?.flatMap((s) => s.params) ?? [];
  let spec = pattern;
  for (const f of fields) {
    if (f[0] === '!') member.deprecated = f.slice(1).trim();
    else if (f[0] === '@') spec = f.slice(1).trim();
    else {
      const p = /^(\w+): (.+)$/.exec(f);
      const named = p ? params.filter((x) => x.name === p[1]) : [];
      // A field that is none of these is a typo in the notation: fail loudly (the unit tests load the model).
      if (!p || !named.length) throw new Error(`xrm-model: ${line}`);
      for (const x of named) x.doc = p[2];
    }
  }
  for (const x of params) if (!x.doc && PARAM_DOCS[x.name]) x.doc = PARAM_DOCS[x.name];
  member.url = href(spec.replace('*', name.toLowerCase()).replace('~', dir));
  return member;
}

/**
 * Adds a type. `head` is the id, or 'id=Display.Name'; `page` its page on Learn; `pattern` the URL of its members
 * (default: page/*; '' for the page itself).
 */
function T(head: string, page: string, pattern: string | undefined, doc: string, body: string, base?: string): void {
  const [id, name = id] = head.split('=');
  const spec = pattern === undefined ? page + '/*' : pattern || page;
  const members = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseMember(l, spec, page + '/'));
  TYPES[id] = { id, name, doc, url: href(page), base, members };
}

// ------------------------------------------------------------------ globals and the Xrm namespaces

T(GLOBAL, '../clientapi-xrm', '', 'The globals of the client API.', `
Xrm:: Xrm | The client API of model-driven apps: Xrm.WebApi, Xrm.Navigation, Xrm.Utility, Xrm.App...
GetGlobalContext(): GlobalContext | The global context, in an HTML web resource that includes ClientGlobalContext.js.aspx. | @getglobalcontext-clientglobalcontext.js.aspx
`);

T('Xrm', '../clientapi-xrm', 'xrm-*', 'The client API of model-driven apps.', `
App:: XrmApp | App-wide notifications and side panes.
Device:: XrmDevice | The camera, microphone, location and files of the device (mobile app).
Encoding:: XrmEncoding | Encodes and decodes strings for HTML and XML.
Mobile:: XrmMobile | Offline data of the mobile app. | !Use Xrm.WebApi.offline. | @xrm-webapi/offline
Navigation:: XrmNavigation | Opens forms, pages, dialogs, files, URLs and web resources.
Page:: XrmPage | The form of the page, as a global object. | !Use the form context: executionContext.getFormContext() in form scripts, the PrimaryControl parameter in commands. | @executioncontext/getformcontext
Panel:: XrmPanel | Shows a web page in the side pane.
Utility:: XrmUtility | The global context, table definitions, lookup dialogs, the progress indicator and more.
WebApi:: WebApi | Creates, retrieves, updates and deletes records, and runs Web API actions and functions.
`);

T('XrmApp=Xrm.App', 'xrm-app', undefined, 'App-wide notifications and side panes.', `
addGlobalNotification(notification: object): Promise<string> | Shows a notification bar at the top of the app; resolves with the notification's ID. | notification: { type: 2, level: 1 success, 2 error, 3 warning or 4 information, message, showCloseButton?, action?: { actionLabel, eventHandler } }
clearGlobalNotification(uniqueId: string): Promise<void> | Removes a notification shown by addGlobalNotification. | uniqueId: The ID addGlobalNotification resolved with.
sidePanes:: SidePanes | The side panes of the app. | @xrm-app-sidepanes
`);

T('SidePanes=Xrm.App.sidePanes', 'xrm-app-sidepanes', 'xrm-app/xrm-app-sidepanes/*', 'The side panes of the app.', `
createPane(paneOptions?: object): Promise<SidePane> | Adds a side pane; load a page in it with navigate(). | paneOptions: { title, paneId, canClose, imageSrc, hideHeader, isSelected, width, hidden, alwaysRender, keepBadgeOnSelect }
getAllPanes(): Collection<SidePane> | All the open panes.
getPane(paneId: string): SidePane | The pane with this ID (undefined when there is none).
getSelectedPane(): SidePane | The selected pane.
state: number | Whether the side panes are collapsed (0) or expanded (1); can be set. | @xrm-app-sidepanes
`);

T('SidePane', 'xrm-app-appsidepane', '', 'A side pane of the app.', `
alwaysRender: boolean | Keeps the content of the pane when it is hidden.
badge: any | The badge on the pane's tab (a dot, a count or an image), cleared when the pane is selected. | @../create-app-side-panes
canClose: boolean | Whether the header of the pane has a close button.
close() | Closes the pane and removes it from the side bar.
hidden: boolean | Hides the pane and its tab.
imageSrc: string | The path of the icon in the pane switcher.
keepBadgeOnSelect: boolean | Keeps the badge when the pane is selected.
navigate(pageInput: object): Promise<void> | Opens a page in the pane; takes the same page input as Xrm.Navigation.navigateTo. | pageInput: { pageType: "entitylist", "entityrecord", "webresource" or "custom", entityName, entityId, webresourceName, name }
paneId: string | The ID of the pane.
select() | Selects the pane.
title: string | The title of the pane (header and tooltip).
width: number | The width of the pane in pixels.
`);

T('XrmDevice=Xrm.Device', 'xrm-device', undefined, 'The capabilities of the device (mobile app).', `
captureAudio(): Promise<object> | Records audio with the microphone; resolves with the file: { fileName, fileContent (base64), fileSize, mimeType }.
captureImage(imageOptions?: object): Promise<object> | Takes a picture with the camera; resolves with the image file. | imageOptions: { allowEdit, height, width, preferFrontCamera, quality }
captureVideo(): Promise<object> | Records a video with the camera; resolves with the video file.
getBarcodeValue(): Promise<string> | Scans a barcode with the camera; resolves with its value.
getCurrentPosition(): Promise<object> | The location of the device: { coords, timestamp }.
pickFile(pickFileOptions?: object): Promise<object[]> | Lets the user pick files; resolves with them. | pickFileOptions: { accept: "audio", "video" or "image", allowMultipleFiles, maximumAllowedFileSize (KB) }
`);

T('XrmEncoding=Xrm.Encoding', 'xrm-encoding', undefined, 'Encodes and decodes strings.', `
htmlAttributeEncode(arg: string): string | Encodes a string for an HTML attribute.
htmlDecode(arg: string): string | Decodes an HTML-encoded string.
htmlEncode(arg: string): string | Encodes a string for HTML.
xmlAttributeEncode(arg: string): string | Encodes a string for an XML attribute.
xmlEncode(arg: string): string | Encodes a string for XML.
`);

T('XrmMobile=Xrm.Mobile', 'xrm-webapi/offline', '', 'Offline data of the mobile app (deprecated).', `
offline: object | The offline methods. | !Use Xrm.WebApi.offline.
`);

T('XrmNavigation=Xrm.Navigation', 'xrm-navigation', undefined, 'Opens forms, pages, dialogs, files, URLs and web resources.', `
navigateTo(pageInput: object, navigationOptions?: object): Promise<any> | Opens a list, a record, a web resource, a custom page or a dashboard, inline or in a dialog. | pageInput: { pageType: "entitylist", "entityrecord", "webresource", "custom" or "dashboard", entityName, entityId, formId, webresourceName, name, data } | navigationOptions: { target: 1 inline or 2 dialog, width, height, position: 1 center or 2 side, title }
openAlertDialog(alertStrings: object, alertOptions?: object): Promise<void> | Shows an alert dialog with a message and one button. | alertStrings: { text, title?, confirmButtonLabel? } | alertOptions: { height?, width? }
openConfirmDialog(confirmStrings: object, confirmOptions?: object): Promise<object> | Shows a confirmation dialog with two buttons; resolves with { confirmed }. | confirmStrings: { text, title?, subtitle?, confirmButtonLabel?, cancelButtonLabel? } | confirmOptions: { height?, width? }
openErrorDialog(errorOptions: object): Promise<void> | Shows an error dialog. | errorOptions: { message, details?, errorCode? }
openFile(file: object, openFileOptions?: object) | Opens or saves a file. | file: { fileContent (base64), fileName, fileSize, mimeType } | openFileOptions: { openMode: 1 open or 2 save }
openForm(entityFormOptions: object, formParameters?: object): Promise<object> | Opens a form or a quick create form; quick create resolves with { savedEntityReference }. | entityFormOptions: { entityName, entityId?, formId?, useQuickCreateForm?, openInNewWindow?, createFromEntity?, ... } | formParameters: Values for the columns of a new record, and custom parameters.
openUrl(url: string, openUrlOptions?: object) | Opens a URL, including file URLs. | openUrlOptions: { height?, width? }
openWebResource(webResourceName: string, windowOptions?: object, data?: string) | Opens an HTML web resource in a new window. | windowOptions: { height?, width?, openInNewWindow? } | data: Passed to the page in the data query string parameter.
`);

T('XrmPage=Xrm.Page', 'executioncontext/getformcontext', '', 'The form of the page as a global (deprecated): use the form context.', `
context: GlobalContext | The global context. | !Use Xrm.Utility.getGlobalContext(). | @xrm-utility/getglobalcontext
`, 'FormContext');

T('XrmPanel=Xrm.Panel', 'xrm-panel', undefined, 'The side pane of the web client.', `
loadPanel(url: string, title: string) | Shows a web page in the side pane. | !Use Xrm.App.sidePanes.createPane, which replaces it. | url: The URL of the page. | title: The title of the pane.
`);

T('XrmUtility=Xrm.Utility', 'xrm-utility', undefined, 'The global context, table definitions, lookup dialogs, the progress indicator and more.', `
closeProgressIndicator() | Closes the progress dialog opened by showProgressIndicator.
getAllowedStatusTransitions(entityName: table, stateCode: number): Promise<number[]> | The status values a record can move to from its state. | stateCode: The state code to start from.
getEntityMainFormDescriptor(entityName: table, formId?: string): Promise<object> | The descriptor of a main form of the table: columns, sections, label.
getEntityMetadata(entityName: table, attributes?: string[]): Promise<object> | The definition of a table, with the definitions of the columns listed. | attributes: The logical names of the columns to include.
getGlobalContext(): GlobalContext | The global context: client, organization and user settings, URLs, version.
getLearningPathAttributeName(): string | The name of the DOM attribute that guided help (Learning Path) uses to find controls.
getPageContext(): object | The page context: { input: { pageType, entityName, entityId, ... } }.
getResourceString(webResourceName: string, key: string): string | The localized string for a key, from a RESX web resource.
invokeProcessAction(name: string, parameters?: object): Promise<any> | Runs a custom process action by its unique name. | parameters: The input parameters of the action.
lookupObjects(lookupOptions: object): Promise<Lookup[]> | Opens a lookup dialog; resolves with the selected records. | lookupOptions: { entityTypes, allowMultiSelect?, defaultEntityType?, defaultViewId?, viewIds?, filters?, searchText? }
refreshParentGrid(lookupOptions: Lookup) | Refreshes the grid the record was opened from. | lookupOptions: The record: { entityType, id, name? }.
showProgressIndicator(message: string) | Shows a modal progress dialog with a message, until closeProgressIndicator.
alertDialog(message: string, onCloseCallback?: function) | Shows an alert. | !Use Xrm.Navigation.openAlertDialog. | @xrm-navigation/openalertdialog
confirmDialog(message: string, yesCloseCallback?: function, noCloseCallback?: function) | Shows a confirmation dialog. | !Use Xrm.Navigation.openConfirmDialog. | @xrm-navigation/openconfirmdialog
getBarcodeValue(): Promise<string> | Scans a barcode. | !Use Xrm.Device.getBarcodeValue. | @xrm-device/getbarcodevalue
getCurrentPosition(): Promise<object> | The location of the device. | !Use Xrm.Device.getCurrentPosition. | @xrm-device/getcurrentposition
isActivityType(entityName: table): boolean | Whether a table is an activity. | !Use Xrm.Utility.getEntityMetadata (IsActivity). | @xrm-utility/getentitymetadata
openEntityForm(name: table, id?: string, parameters?: object, windowOptions?: object) | Opens a form. | !Use Xrm.Navigation.openForm. | @xrm-navigation/openform
openQuickCreate(entityLogicalName: table, createFromEntity?: Lookup, parameters?: object): Promise<object> | Opens a quick create form. | !Use Xrm.Navigation.openForm with useQuickCreateForm. | @xrm-navigation/openform
openWebResource(webResourceName: string, webResourceData?: string, width?: number, height?: number) | Opens a web resource in a new window. | !Use Xrm.Navigation.openWebResource. | @xrm-navigation/openwebresource
`);

// Xrm.WebApi, Xrm.WebApi.online and Xrm.WebApi.offline share the record operations.
T('WebApiCrud=Xrm.WebApi', 'xrm-webapi', undefined, 'The record operations of the Web API.', `
createRecord(entityLogicalName: table, data: object): Promise<object> | Creates a record; resolves with { entityType, id }. | data: The column values; lookups as "name@odata.bind": "/accounts(ID)".
deleteRecord(entityLogicalName: table, id: string): Promise<object> | Deletes a record; resolves with { entityType, id, name }.
retrieveMultipleRecords(entityLogicalName: table, options?: string, maxPageSize?: number): Promise<object> | Retrieves records; resolves with { entities, nextLink?, fetchXmlPagingCookie? }. | options: Query options starting with ?, like ?$select=name&$filter=statecode eq 0, or ?fetchXml= and a FetchXML query. | maxPageSize: Records per page (5,000 when not given).
retrieveRecord(entityLogicalName: table, id: string, options?: string): Promise<object> | Retrieves a record. | options: Query options starting with ?, like ?$select=name&$expand=primarycontactid($select=fullname).
updateRecord(entityLogicalName: table, id: string, data: object): Promise<object> | Updates a record; resolves with { entityType, id }. | data: The column values to change.
`);

T('WebApiOnline=Xrm.WebApi.online', 'xrm-webapi/online', 'xrm-webapi/online/*', 'The Web API on the server.', `
execute(request: object): Promise<Response> | Runs an action, a function or a CRUD operation described by a request object with getMetadata().
executeMultiple(requests: object[]): Promise<Response[]> | Runs several requests; the requests of an inner array run together as a change set.
`, 'WebApiCrud');

T('WebApiOffline=Xrm.WebApi.offline', 'xrm-webapi/offline', 'xrm-webapi/*', 'The offline data store of the mobile app.', `
isAvailableOffline(entityLogicalName: table): boolean | Whether the table is in the user's mobile offline profile.
`, 'WebApiCrud');

T('WebApi=Xrm.WebApi', 'xrm-webapi', undefined, 'Creates, retrieves, updates and deletes records, and runs Web API actions and functions.', `
isAvailableOffline(entityLogicalName: table): boolean | Whether the table is in the user's mobile offline profile and available offline.
offline:: WebApiOffline | The same operations on the offline data store of the mobile app.
online:: WebApiOnline | The same operations on the server, with execute and executeMultiple.
`, 'WebApiOnline');

// ------------------------------------------------------------------ global context

T('GlobalContext', 'xrm-utility/getglobalcontext', undefined, 'The global context: client, organization and user settings, URLs and version.', `
client: ClientContext | The client: web or mobile, online or offline, the kind of device. | @~client
organizationSettings: OrganizationSettings | The settings of the organization (the environment). | @~organizationsettings
userSettings: UserSettings | The settings of the current user: ID, name, security roles, language, time zone. | @~usersettings
getAdvancedConfigSetting(setting: string): number | An advanced configuration setting: "MaxChildIncidentNumber" or "MaxIncidentMergeNumber".
getClientUrl(): string | The base URL of the environment, like https://contoso.crm.dynamics.com.
getCurrentAppName(): Promise<string> | The name of the current app.
getCurrentAppProperties(): Promise<object> | The properties of the current app: { appId, displayName, uniqueName, url, webResourceId, ... }.
getCurrentAppUrl(): string | The URL of the current app.
getVersion(): string | The version of the environment, like 9.2.24104.00186.
getWebResourceUrl(webResourceName: string): string | The relative URL of a web resource, with the caching token.
isOnPremises(): boolean | Whether the environment runs on-premises.
prependOrgName(sPath: string): string | Prefixes a path with the unique name of the organization.
getIsAutoSaveEnabled(): boolean | Whether auto-save is on. | !Use organizationSettings.isAutoSaveEnabled. | @~organizationsettings
getOrgLcid(): number | The base language of the organization. | !Use organizationSettings.languageId. | @~organizationsettings
getOrgUniqueName(): string | The unique name of the organization. | !Use organizationSettings.uniqueName. | @~organizationsettings
getQueryStringParameters(): object | The query string parameters of the page. | !Use formContext.data.attributes, or Xrm.Utility.getPageContext(). | @formcontext-data
getServerUrl(): string | The base URL of the environment. | !Use getClientUrl(). | @~getclienturl
getTimeZoneOffsetMinutes(): number | The time zone offset of the user. | !Use userSettings.getTimeZoneOffsetMinutes(). | @~usersettings
getUserId(): string | The ID of the user. | !Use userSettings.userId. | @~usersettings
getUserLcid(): number | The language of the user. | !Use userSettings.languageId. | @~usersettings
getUserName(): string | The name of the user. | !Use userSettings.userName. | @~usersettings
getUserRoles(): string[] | The IDs of the user's security roles. | !Use userSettings.roles. | @~usersettings
`);

T('ClientContext', 'xrm-utility/getglobalcontext/client', 'xrm-utility/getglobalcontext/client#*', 'The client the script runs in.', `
getClient(): string | Where the script runs: "Web", "Outlook" or "Mobile".
getClientState(): string | "Online" or "Offline".
getFormFactor(): number | The kind of device: 0 unknown, 1 desktop, 2 tablet, 3 phone.
isNetworkAvailable(): boolean | Whether the network is available, whatever the client state.
isOffline(): boolean | Whether the client is offline.
`);

T('OrganizationSettings', 'xrm-utility/getglobalcontext/organizationsettings', '', 'The settings of the organization.', `
attributes: object | Columns of the organization table and their values, by logical name.
baseCurrency: Lookup | The base currency: { id, name, entityType }.
baseCurrencyId: string | The ID of the base currency. | !Use baseCurrency.id.
defaultCountryCode: string | The default country or region code for phone numbers.
fullNameConventionCode: number | How full names are made, from 0 "LastName, FirstName" to 7 "LastNameFirstName".
isAutoSaveEnabled: boolean | Whether auto-save is on.
isTrialOrganization: boolean | Whether the environment is a trial.
languageId: number | The LCID of the base language, like 1033.
organizationExpiryDate: Date | When a trial environment expires (null otherwise).
organizationId: string | The ID of the organization.
uniqueName: string | The unique name of the organization.
useSkypeProtocol: boolean | Whether phone numbers use the Skype protocol.
`);

T('UserSettings', 'xrm-utility/getglobalcontext/usersettings', '', 'The settings of the current user.', `
dateFormattingInfo: object | The date formats of the user: FirstDayOfWeek, LongDatePattern, ShortDatePattern, TimeSeparator...
defaultDashboardId: string | The ID of the user's default dashboard.
getSecurityRolePrivilegesInfo(): Promise<object> | The privileges of the user, by privilege ID: { id, businessUnitId, privilegeName, depth }.
getTimeZoneOffsetMinutes(): number | The difference in minutes between the user's local time and UTC.
isGuidedHelpEnabled: boolean | Whether guided help is on.
isHighContrastEnabled: boolean | Whether high contrast is on.
isRTL: boolean | Whether the user's language is written right to left.
languageId: number | The LCID of the user's language, like 1033.
roles: Collection<Lookup> | The security roles of the user and of the user's teams: { id, name }.
securityRolePrivileges: string[] | The IDs of the user's privileges, from the user's roles and teams.
securityRoles: string[] | The IDs of the user's security roles. | !Use roles.
transactionCurrency: Lookup | The currency of the user: { id, name, entityType }.
transactionCurrencyId: string | The ID of the user's currency. | !Use transactionCurrency.id.
userId: string | The ID (systemuserid) of the user, as {GUID}.
userName: string | The name of the user.
`);

// ------------------------------------------------------------------ execution context

T('ExecutionContext', 'execution-context', 'executioncontext/*', 'Passed to a handler as its first argument when "Pass execution context as first parameter" is on.', `
getDepth(): number | The order in which this handler runs among the handlers of the event.
getEventArgs(): EventArgs | The arguments of the event: save mode, preventDefault, stage, tag... depending on the event.
getEventSource(): any | What the event occurred on: the column (OnChange), the control, the tab, the record...
getFormContext(): FormContext | The form context: the form, or the row of an editable grid, the handler runs on.
getSharedVariable(key: string): any | A value set by an earlier handler of the same event with setSharedVariable.
setSharedVariable(key: string, value: any) | Sets a value that the next handlers of the same event can read.
`);

T('EventArgs', 'executioncontext/geteventargs', 'save-event-arguments/*', 'The arguments of an event; the methods depend on the event.', `
disableAsyncTimeout() | OnSave with an async handler: waits for the handler's promise without the timeout.
getDataLoadState(): number | OnLoad: why the data loaded: 1 initial load, 2 save, 3 refresh. | @executioncontext/geteventargs
getDirection(): string | OnStageChange: "Next" or "Previous". | @executioncontext/geteventargs
getEntityReference(): Lookup | PostSave: the saved record: { entityType, id, name }.
getIsSaveSuccess(): boolean | PostSave: whether the save succeeded.
getSaveErrorInfo(): object | PostSave: why the save failed.
getSaveMode(): number | OnSave: how the save started: 1 save, 2 save and close, 59 save and new, 70 auto-save...
getStage(): Stage | OnStageChange, OnPreStageChange, OnStageSelected: the stage. | @executioncontext/geteventargs
getStatus(): string | OnProcessStatusChange, OnPreProcessStatusChange: "Active", "Finished" or "Aborted". | @executioncontext/geteventargs
getTagValue(): LookupTag | OnLookupTagClick: the record clicked: { id, name, entityType, fieldName }. | @events/onlookuptagclick
isDefaultPrevented(): boolean | Whether preventDefault was called by this or an earlier handler.
preventDefault() | Cancels the save (or the stage change, the status change, the tag click); the other handlers still run.
preventDefaultOnError() | OnSave: cancels the save if this handler throws, rejects or times out.
`);

// ------------------------------------------------------------------ form context

T('FormContext', '../clientapi-form-context', '', 'The form, or the row of an editable grid, a handler runs on.', `
data: FormData | The data of the form: the record, its columns, the business process flow. | @formcontext-data
ui: FormUi | The user interface of the form: tabs, controls, notifications. | @formcontext-ui
getAttribute(name: attribute): Attribute ; (): Attribute[] ; (index: number): Attribute ; (delegate: function): Attribute[] | A column of the form, or all of them (shortcut for data.entity.attributes.get). | name: The logical name of the column. | @attributes
getControl(name: control): Control ; (): Control[] ; (index: number): Control ; (delegate: function): Control[] | A control of the form, or all of them (shortcut for ui.controls.get). | name: The name of the control: the column's logical name for its first control, then name1, name2...; header_name in the header. | @controls/getcontrol
`);

T('FormData', 'formcontext-data', undefined, 'The data of the form.', `
attributes: Collection<Attribute> | Form data that is not a column of the table: custom query string and openForm parameters. | @collections
entity: Entity | The record of the form: its ID, table, columns and save events. | @formcontext-data-entity
process: FormProcess | The business process flow of the form. | @formcontext-data-process
addOnLoad(handler: function) | Adds a function called when the form data loads: initial load, refresh, save.
getIsDirty(): boolean | Whether the form data has unsaved changes.
isValid(): boolean | Whether all the form data is valid; shows the notifications of empty required columns.
refresh(save?: boolean): Promise<void> | Reloads the data of the form without reloading the page. | save: true to save first.
removeOnLoad(handler: function) | Removes a function added with addOnLoad.
save(saveOptions?: object): Promise<void> | Saves the record. | saveOptions: { saveMode?: the getSaveMode value the OnSave handlers see, useSchedulingEngine? }
`);

T('Entity', 'formcontext-data-entity', undefined, 'The record of the form.', `
attributes: Collection<Attribute> | The columns of the record that are on the form. | @attributes
addOnPostSave(handler: function) | Adds a function called after the record is saved, or the save failed.
addOnSave(handler: function) | Adds a function called before the record is saved; it can cancel the save.
getDataXml(): string | The XML sent to the server on save: the changed columns and those submitted always.
getEntityName(): string | The logical name of the table.
getEntityReference(): Lookup | The record as a lookup value: { entityType, id, name }.
getId(): string | The ID of the record, as {GUID}; empty for a new record.
getIsDirty(): boolean | Whether any column has unsaved changes.
getPrimaryAttributeValue(): string | The value of the primary column (the name of the record).
isValid(): boolean | Whether all the column values are valid.
removeOnPostSave(handler: function) | Removes a function added with addOnPostSave.
removeOnSave(handler: function) | Removes a function added with addOnSave.
save(saveOption?: string) | Saves the record: no argument, "saveandclose" or "saveandnew". | !Use formContext.data.save().
`);

T('FormProcess', 'formcontext-data-process', undefined, 'The business process flow of the form.', `
addOnPreProcessStatusChange(handler: function) | Adds a function called before the status of the process changes; it can cancel the change. | @~eventhandlers/*
addOnPreStageChange(handler: function) | Adds a function called before the stage changes; it can cancel the change. | @~eventhandlers/*
addOnProcessStatusChange(handler: function) | Adds a function called when the status of the process changes. | @~eventhandlers/*
addOnStageChange(handler: function) | Adds a function called when the stage changes. | @~eventhandlers/*
addOnStageSelected(handler: function) | Adds a function called when a stage is selected. | @~eventhandlers/*
getActivePath(): Collection<Stage> | The stages of the active path. | @~activepath/*
getActiveProcess(): Process | The active process. | @~activeprocess/*
getActiveStage(): Stage | The active stage. | @~activestage/*
getEnabledProcesses(callbackFunction: function) | Gets the processes the user can switch to; the callback receives { processId: name }.
getInstanceId(): string | The ID of the process instance. | @~instance/*
getInstanceName(): string | The name of the process instance. | @~instance/*
getProcessInstances(callbackFunction: function) | Gets the process instances of the record that the user can see.
getSelectedStage(): Stage | The selected stage.
getStatus(): string | The status of the process instance: "active", "aborted" or "finished". | @~instance/*
moveNext(callbackFunction?: function) | Moves to the next stage. | @~navigation/*
movePrevious(callbackFunction?: function) | Moves to the previous stage. | @~navigation/*
removeOnPreProcessStatusChange(handler: function) | Removes a function added with addOnPreProcessStatusChange. | @~eventhandlers/*
removeOnPreStageChange(handler: function) | Removes a function added with addOnPreStageChange. | @~eventhandlers/*
removeOnProcessStatusChange(handler: function) | Removes a function added with addOnProcessStatusChange. | @~eventhandlers/*
removeOnStageChange(handler: function) | Removes a function added with addOnStageChange. | @~eventhandlers/*
removeOnStageSelected(handler: function) | Removes a function added with addOnStageSelected. | @~eventhandlers/*
setActiveProcess(processId: string, callbackFunction?: function) | Makes another process active. | @~activeprocess/*
setActiveProcessInstance(processInstanceId: string, callbackFunction?: function) | Makes a process instance the active one.
setActiveStage(stageId: string, callbackFunction?: function) | Makes a completed stage of the active path the active stage. | @~activestage/*
setStatus(status: string, callbackFunction?: function) | Sets the status of the process instance: "active", "aborted" or "finished". | @~instance/*
`);

T('Process', 'formcontext-data-process', 'formcontext-data-process/process/*', 'A business process flow.', `
getId(): string | The ID of the process.
getName(): string | The name of the process.
getStages(): Collection<Stage> | The stages of the process.
isRendered(): boolean | Whether the process is shown on the form.
`);

T('Stage', 'formcontext-data-process', 'formcontext-data-process/stage/*', 'A stage of a business process flow.', `
getCategory(): StageCategory | The category of the stage: an object with getValue().
getEntityName(): string | The logical name of the table of the stage.
getId(): string | The ID of the stage.
getName(): string | The name of the stage.
getNavigationBehavior(): StageNavigationBehavior | Lets you hide the Create button of the stage (cross-table flows).
getStatus(): string | "active" or "inactive".
getSteps(): Step[] | The steps of the stage.
`);

T('StageCategory', 'formcontext-data-process/stage/getcategory', '', 'The category of a stage.', `
getValue(): number | 0 qualify, 1 develop, 2 propose, 3 close, 4 identify, 5 research, 6 resolve.
`);

T('StageNavigationBehavior', 'formcontext-data-process/stage/getnavigationbehavior', '', 'How users can navigate from a stage.', `
allowCreateNew: function | Set to a function that returns false to hide the Create button of the stage.
`);

T('Step', 'formcontext-data-process', 'formcontext-data-process/step/*', 'A step of a stage.', `
getAttribute(): string | The logical name of the column of the step.
getName(): string | The name of the step.
getProgress(): number | The progress of an action step: 0 none, 1 processing, 2 completed, 3 failure, 4 invalid.
isRequired(): boolean | Whether the step is required.
setProgress(stepProgress: number, message?: string): string | Updates the progress of an action step; returns "success" or "invalid". | stepProgress: 0 none, 1 processing, 2 completed, 3 failure, 4 invalid. | message: The alternative text of the step's icon.
`);

// ------------------------------------------------------------------ form user interface

T('FormUi', 'formcontext-ui', undefined, 'The user interface of the form.', `
controls: Collection<Control> | All the controls of the form. | @controls
footerSection: FooterSection | The footer of the form. | !Removed in October 2021: forms have no footer.
formSelector: FormSelector | The forms available to the user, and the current one. | @formcontext-ui-formselector
headerSection: HeaderSection | The visibility of the header's body, command bar and tab navigator. | @formcontext-ui-headersection
navigation: FormNavigation | The navigation items of the form. | @formcontext-ui-navigation
process: UiProcess | The business process flow control. | @formcontext-ui-process
quickForms: Collection<QuickForm> | The quick view controls of the form. | @formcontext-ui-quickforms
tabs: Collection<Tab> | The tabs of the form. | @formcontext-ui-tabs
addOnLoad(handler: function) | Adds a function called when the form loads.
clearFormNotification(uniqueId: string): boolean | Removes a notification shown with setFormNotification.
close() | Closes the form; the user is asked to save unsaved changes.
getFormType(): number | The type of form: 0 undefined, 1 create, 2 update, 3 read only, 4 disabled, 6 bulk edit.
getViewPortHeight(): number | The height of the viewport in pixels.
getViewPortWidth(): number | The width of the viewport in pixels.
refreshRibbon(refreshAll?: boolean) | Evaluates the rules of the command bar again. | refreshAll: true to refresh all the command bars of the page, not only the form's.
removeOnLoad(handler: function) | Removes a function added with addOnLoad.
setFormEntityName(arg: string) | Sets the name of the table shown on the form.
setFormNotification(message: string, level: string, uniqueId: string): boolean | Shows a notification at the top of the form. | level: "ERROR", "WARNING" or "INFO". | uniqueId: The ID to remove the notification with clearFormNotification.
`);

T('FooterSection', 'formcontext-ui', '', 'The footer of the form (removed).', `
getVisible(): boolean | Whether the footer is visible. | !Removed in October 2021: forms have no footer.
setVisible(visible: boolean) | Shows or hides the footer. | !Removed in October 2021: forms have no footer.
`);

T('FormSelector', 'formcontext-ui-formselector', '', 'The forms available to the user.', `
items: Collection<FormItem> | The forms available to the user through their security roles.
getCurrentItem(): FormItem | The form shown (null when only one form is available).
`);

T('FormItem', 'formcontext-ui-formselector', undefined, 'A form of the table.', `
getId(): string | The ID of the form.
getLabel(): string | The label of the form.
getVisible(): boolean | Whether the form is listed in the form selector.
navigate() | Opens this form; the user is asked to save unsaved changes.
setVisible(visible: boolean) | Shows or hides the form in the form selector.
`);

T('FormNavigation', 'formcontext-ui-navigation', '', 'The navigation items of the form.', `
items: Collection<NavigationItem> | The navigation items of the form.
`);

T('NavigationItem', 'formcontext-ui-navigation', undefined, 'A navigation item of the form.', `
getId(): string | The name of the item.
getLabel(): string | The label of the item.
getVisible(): boolean | Whether the item is visible.
setFocus() | Moves the focus to the item.
setLabel(label: string) | Changes the label of the item.
setVisible(visible: boolean) | Shows or hides the item.
`);

T('UiProcess', 'formcontext-ui-process', undefined, 'The business process flow control of the form.', `
getDisplayState(): string | "expanded" or "collapsed".
getVisible(): boolean | Whether the business process flow control is visible.
reflow(updateUI: boolean, parentStage: string, nextStage: string) | Draws the business process flow control again. | updateUI: true to update the user interface of the control. | parentStage: The ID of the parent stage. | nextStage: The ID of the next stage.
setDisplayState(state: string) | Expands or collapses the control. | state: "expanded", "collapsed" or "floating".
setVisible(visible: boolean) | Shows or hides the business process flow control.
`);

T('HeaderSection', 'formcontext-ui-headersection', undefined, 'The header of the form.', `
getBodyVisible(): boolean | Whether the body of the header is visible.
getCommandBarVisible(): boolean | Whether the command bar is visible.
getTabNavigatorVisible(): boolean | Whether the tab navigator is visible.
setBodyVisible(visible: boolean) | Shows or hides the body of the header.
setCommandBarVisible(visible: boolean) | Shows or hides the command bar.
setTabNavigatorVisible(visible: boolean) | Shows or hides the tab navigator.
`);

T('Tab', 'formcontext-ui-tabs', undefined, 'A tab of the form.', `
sections: Collection<Section> | The sections of the tab. | @formcontext-ui-tab-sections
addTabStateChange(handler: function) | Adds a function called when the tab is expanded or collapsed.
getContentType(): string | "cardSections" (the default) or "singleComponent".
getDisplayState(): string | "expanded" or "collapsed".
getLabel(): string | The label of the tab.
getName(): string | The name of the tab.
getParent(): FormUi | The formContext.ui object.
getVisible(): boolean | Whether the tab is visible.
removeTabStateChange(handler: function) | Removes a function added with addTabStateChange.
setContentType(contentType: string) | Lays out the tab: "cardSections", or "singleComponent" for one full-size component like a grid.
setDisplayState(state: string) | Expands or collapses the tab.
setFocus() | Moves the focus to the tab.
setLabel(label: string) | Changes the label of the tab.
setVisible(visible: boolean) | Shows or hides the tab.
`);

T('Section', 'formcontext-ui-tab-sections', undefined, 'A section of a tab.', `
controls: Collection<Control> | The controls of the section. | @controls
getLabel(): string | The label of the section.
getName(): string | The name of the section.
getParent(): Tab | The tab of the section.
getVisible(): boolean | Whether the section is visible.
setLabel(label: string) | Changes the label of the section.
setVisible(visible: boolean) | Shows or hides the section.
`);

T('QuickForm', 'formcontext-ui-quickforms', undefined, 'A quick view control: a form of a related record.', `
getControl(name: string): Control ; (): Control[] ; (index: number): Control ; (delegate: function): Control[] | A control of the quick view form, or all of them. | name: The name of the control.
getControlType(): string | "quickform".
getDisabled(): boolean | Whether the control is disabled.
getLabel(): string | The label of the quick view control.
getName(): string | The name of the quick view control.
getParent(): Section | The section that contains the control.
getVisible(): boolean | Whether the control is visible.
isLoaded(): boolean | Whether the data of the quick view form has loaded.
refresh() | Loads the data of the quick view form again.
setDisabled(disabled: boolean) | Enables or disables the control.
setFocus() | Moves the focus to the control.
setLabel(label: string) | Changes the label of the quick view control.
setVisible(visible: boolean) | Shows or hides the control.
`);

// ------------------------------------------------------------------ columns and controls

T('Attribute', 'attributes', undefined, 'A column of the record on the form. Some methods are only for some column types.', `
controls: Collection<Control> | The controls bound to the column. | @attributes/controls-collection
addOnChange(handler: function) | Adds a function called when the value changes.
fireOnChange() | Runs the OnChange handlers of the column.
getAttributeType(): string | "boolean", "datetime", "decimal", "double", "integer", "lookup", "memo", "money", "multiselectoptionset", "optionset" or "string".
getFormat(): string | The format, like "date", "datetime", "email", "phone", "url", "duration", "timezone"...
getInitialValue(): boolean|number | Boolean, choice: the value when the form opened.
getIsDirty(): boolean | Whether the value has changed since the form opened or was last saved.
getIsPartyList(): boolean | Lookup: whether it takes several records (a party list, like the recipients of an email).
getMax(): number | Number: the largest allowed value.
getMaxLength(): number | Text: the largest allowed length.
getMin(): number | Number: the smallest allowed value.
getName(): string | The logical name of the column.
getOption(value: number|string): Option | Choice: the option with this value or label: { text, value }.
getOptions(): Option[] | Choice: the valid options: { text, value }.
getParent(): Entity | The formContext.data.entity object.
getPrecision(): number | Number: the number of digits after the decimal point.
getRequiredLevel(): string | "none", "required" or "recommended".
getSelectedOption(): Option | Choice: the selected option, { text, value }; an array for choices.
getSubmitMode(): string | When the value is sent on save: "always", "never" or "dirty".
getText(): string | Choice: the label of the selected option; an array for choices.
getUserPrivilege(): Privilege | The user's column security privileges: { canRead, canUpdate, canCreate }.
getValue(): any | The value; for a lookup an array of { id, name, entityType }, for choices an array of numbers; null when empty.
isValid(): boolean | Whether the value is valid.
removeOnChange(handler: function) | Removes a function added with addOnChange.
setIsValid(valid: boolean, message?: string) | Marks the value as valid or not. | valid: false to mark it as not valid. | message: The message shown when it is not valid.
setPrecision(value: number) | Number: sets the number of digits after the decimal point.
setRequiredLevel(requirementLevel: string) | Sets whether a value is required before saving.
setSubmitMode(mode: string) | Sets when the value is sent on save.
setValue(value: any) | Sets the value (null clears it); a lookup takes an array of { id, name, entityType }. OnChange doesn't run: call fireOnChange().
`);

T('Control', 'controls', undefined, 'A control of the form. Some methods are only for some control types.', `
addCustomFilter(filter: string, entityLogicalName?: table) | Lookup, in a PreSearch handler: adds a FetchXML filter element to the results, combined with AND. | filter: A FetchXML filter element with its conditions. | entityLogicalName: The table the filter applies to (all of them when not given).
addCustomView(viewId: string, entityName: table, viewDisplayName: string, fetchXml: string, layoutXml: string, isDefault: boolean) | Lookup: adds a view to the lookup dialog. | viewId: A new GUID for the view. | layoutXml: The grid layout of the view. | isDefault: true to make it the default view.
addNotification(notification: object): boolean | Shows an error or a recommendation, with actions, on the control. | notification: { messages: [text], notificationLevel: "ERROR" or "RECOMMENDATION", uniqueId, actions?: [{ message, actions: [functions] }] }
addOnKeyPress(handler: function) | Adds a function called at each key press in the control. | !Use addOnChange, or a code component (PCF). | @controls
addOnLoad(handler: function) | Subgrid: adds a function called each time the subgrid loads (refresh, sort...). | @grids/gridcontrol/*
addOnLookupTagClick(handler: function) | Lookup: adds a function called when a selected record (a tag) is clicked.
addOnOutputChange(handler: function) | Code component (PCF): adds a function called when an output of the component changes.
addOnPostSearch(handler: function) | Knowledge base search: adds a function called after a search.
addOnResultOpened(handler: function) | Knowledge base search: adds a function called when an article is opened.
addOnSelection(handler: function) | Knowledge base search: adds a function called when a result is selected.
addOption(option: Option, index?: number) | Choice: adds one of the column's options, { text, value }, to the control. | index: Where to add it (at the end when not given).
addPreSearch(handler: function) | Lookup: adds a function called before the lookup searches; add filters there with addCustomFilter.
clearNotification(uniqueId?: string): boolean | Removes a notification of the control (the one shown when no ID is given).
clearOptions() | Choice: removes all the options of the control.
fireOnKeyPress() | Runs the key press handlers of the control. | !Use a code component (PCF). | @controls
getAttribute(): Attribute | The column the control is bound to.
getContentWindow(): Promise<Window> | IFRAME, web resource: the window of the page in the control.
getControlType(): string | "standard", "lookup", "optionset", "iframe", "webresource", "subgrid", "quickform", "kbsearch", "timercontrol", "timelinewall", "customcontrol: name"...
getDefaultView(): string | Lookup: the ID of the default view.
getDisabled(): boolean | Whether the control is disabled.
getEntityName(): string | Subgrid: the logical name of the table it shows. | @grids/gridcontrol/*
getEntityTypes(): string[] | Lookup: the tables the lookup allows.
getFetchXml(): string | Subgrid: the FetchXML query of the data shown, with its filters and sorting. | @grids/gridcontrol/*
getGrid(): Grid | Subgrid: the grid, with its rows and selected rows. | @grids/gridcontrol/*
getGridType(): number | Subgrid: 1 home page grid, 2 subgrid. | @grids/gridcontrol/*
getInitialUrl(): string | IFRAME: the URL set in the form designer.
getLabel(): string | The label of the control.
getName(): string | The name of the control.
getObject(): any | IFRAME, web resource: the IFRAME element. | !Use getContentWindow().
getOptions(): Option[] | Choice: the options of the control, without the removed ones.
getOutputs(): object | Code component (PCF): the output properties of the component, by name.
getParent(): Section | The section that contains the control.
getRelationship(): object | Subgrid: the relationship that filters it: { name, attributeName, navigationPropertyName, relationshipType, roleType }. | @grids/gridcontrol/*
getSearchQuery(): string | Knowledge base search: the search text.
getSelectedResults(): object | Knowledge base search: the selected result.
getShowTime(): boolean | Date and time: whether the time is shown.
getSrc(): string | IFRAME, web resource: the URL shown.
getState(): number | Timer: 1 not set, 2 in progress, 3 warning, 4 violated, 5 success, 6 expired, 7 canceled, 8 paused.
getTotalResultCount(): number | Knowledge base search: the number of results.
getUrl(client?: number): string | Subgrid: the URL of the grid. | client: 0 browser, 1 mobile application. | @grids/gridcontrol/*
getViewSelector(): ViewSelector | Subgrid: the view selector, when it is shown. | @grids/gridcontrol/*
getVisible(): boolean | Whether the control is visible.
hideAutoComplete() | Hides the auto-complete list. | !Use a code component (PCF). | @controls
openRelatedGrid() | Subgrid: opens the related (associated) grid. | @grids/gridcontrol/*
openSearchResult(resultNumber: number, mode?: string): boolean | Knowledge base search: opens a result. | mode: "Inline" or "Popout".
refresh() | Subgrid, quick view, timeline, timer: loads the data shown again.
refreshRibbon() | Subgrid: evaluates the rules of the grid's command bar again. | @grids/gridcontrol/*
removeOnKeyPress(handler: function) | Removes a key press handler. | !Use a code component (PCF). | @controls
removeOnLoad(handler: function) | Subgrid: removes a function added with addOnLoad. | @grids/gridcontrol/*
removeOnLookupTagClick(handler: function) | Lookup: removes a function added with addOnLookupTagClick.
removeOnOutputChange(handler: function) | Code component (PCF): removes a function added with addOnOutputChange.
removeOnPostSearch(handler: function) | Knowledge base search: removes a function added with addOnPostSearch.
removeOnResultOpened(handler: function) | Knowledge base search: removes a function added with addOnResultOpened.
removeOnSelection(handler: function) | Knowledge base search: removes a function added with addOnSelection.
removeOption(value: number) | Choice: removes the option with this value from the control.
removePreSearch(handler: function) | Lookup: removes a function added with addPreSearch.
setDefaultView(viewGuid: string) | Lookup: sets the default view of the lookup dialog.
setDisabled(disabled: boolean) | Enables or disables the control.
setEntityTypes(entityLogicalNames: table[]) | Lookup: sets the tables the lookup allows.
setFocus() | Moves the focus to the control.
setLabel(label: string) | Changes the label of the control.
setNotification(message: string, uniqueId?: string): boolean | Shows an error message on the control (clearNotification removes it).
setSearchQuery(query: string) | Knowledge base search: sets the search text.
setShowTime(showTime: boolean) | Date and time: shows or hides the time.
setSrc(src: string) | IFRAME, web resource: shows another URL.
setVisible(visible: boolean) | Shows or hides the control.
showAutoComplete(resultSet: object) | Shows an auto-complete list. | !Use a code component (PCF). | @controls
`);

// ------------------------------------------------------------------ grids

T('Grid', 'grids/grid', undefined, 'The data of a grid or subgrid.', `
getRows(): Collection<GridRow> | The rows of the grid (the page shown).
getSelectedRows(): Collection<GridRow> | The selected rows.
getTotalRecordCount(): number | The number of records that match the view, not only those shown.
`);

T('GridRow', 'grids/gridrow', undefined, 'A row of a grid.', `
data: GridRowData | The data of the row. | @grids/gridrowdata
getData(): GridRowData | The data of the row. | !Use the data property.
`);

T('GridRowData', 'grids/gridrowdata', undefined, 'The data of a row of a grid.', `
entity: GridEntity | The record of the row. | @grids/gridentity
getEntity(): GridEntity | The record of the row. | !Use the entity property.
`);

T('GridEntity', 'grids/gridentity', undefined, 'The record of a row of a grid.', `
attributes: Collection<GridAttribute> | The columns of the row (editable grid). | @grids/gridattribute
getEntityName(): string | The logical name of the table.
getEntityReference(): Lookup | The record as a lookup value: { entityType, id, name }.
getId(): string | The ID of the record.
getPrimaryAttributeValue(): string | The value of the primary column (read-only grid).
`);

T('GridAttribute', 'grids/gridattribute', 'attributes/*', 'A column of a row of an editable grid.', `
controls: Collection<GridCell> | The cells of the column in the selected row. | @grids/gridcell
getName(): string | The logical name of the column.
getRequiredLevel(): string | "none", "required" or "recommended".
getValue(): any | The value of the cell.
setRequiredLevel(requirementLevel: string) | Sets whether a value is required.
setValue(value: any) | Sets the value of the cell.
`);

T('GridCell', 'grids/gridcell', 'controls/*', 'A cell of the selected row of an editable grid.', `
clearNotification(uniqueId?: string): boolean | Removes the notification of the cell.
getDisabled(): boolean | Whether the cell is read-only.
getLabel(): string | The label of the column of the cell.
setDisabled(disabled: boolean) | Makes the cell read-only or editable.
setNotification(message: string, uniqueId?: string): boolean | Shows an error message on the cell.
`);

T('ViewSelector', 'grids/viewselector', undefined, 'The view selector of a subgrid.', `
getCurrentView(): Lookup | The current view: { entityType: 1039 (system view) or 4230 (personal view), id, name }.
isVisible(): boolean | Whether the view selector is visible.
setCurrentView(viewSelectorItem: Lookup) | Shows another view. | viewSelectorItem: { entityType: 1039 (system view) or 4230 (personal view), id, name }.
`);

// ------------------------------------------------------------------ values

// T is the type of the items: Collection<Attribute>, Collection<Tab>...
T('Collection', 'collections', undefined, 'A collection of the form (read-only).', `
forEach(delegate: function) | Calls a function for each item. | delegate: function (item, index).
get(name: string): T ; (): T[] ; (index: number): T ; (delegate: function): T[] | One item by name or position, all the items, or those a function selects. | name: The name of the item.
getLength(): number | The number of items.
`);

T('Lookup', 'attributes/getvalue', '', 'A reference to a record: { id, name, entityType }.', `
entityType: string | The logical name of the table of the record.
id: string | The ID of the record.
name: string | The primary name of the record.
`);

T('LookupTag', 'events/onlookuptagclick', '', 'The record clicked in a lookup.', `
fieldName: string | The lookup column of the tag.
`, 'Lookup');

T('Option', 'attributes/getoptions', '', 'An option of a choice column.', `
text: string | The label of the option.
value: number | The value of the option.
`);

T('Privilege', 'attributes/getuserprivilege', '', "The user's column security privileges.", `
canCreate: boolean | Whether the user can set the value of a new record.
canRead: boolean | Whether the user can read the value.
canUpdate: boolean | Whether the user can change the value.
`);

// ------------------------------------------------------------------ lookups

const instances = new Map<string, XrmType>();

/** A type of the model by id, including the instances of Collection<T>. */
export function typeInfo(id: string): XrmType | undefined {
  const t = TYPES[id];
  if (t) return t;
  const g = /^Collection<(\w+)>$/.exec(id);
  if (!g || !TYPES[g[1]]) return undefined;
  let c = instances.get(id);
  if (!c) instances.set(id, (c = collectionOf(g[1])));
  return c;
}

function collectionOf(item: string): XrmType {
  const gen = TYPES.Collection;
  // Inside get("...") of the columns and controls collections, the editor offers their names.
  const names: NameKind | undefined = item === 'Attribute' ? 'attribute' : item === 'Control' ? 'control' : undefined;
  const swap = (s: string) => s.replace(/\bT\b/g, item);
  return {
    ...gen,
    id: `Collection<${item}>`,
    name: `Collection<${item}>`,
    members: gen.members.map((m) => ({
      ...m,
      sigs: m.sigs?.map((s) => ({ returns: swap(s.returns), params: s.params.map((p) => (p.name === 'name' && names ? { ...p, names } : p)) })),
    })),
  };
}

/** The members of a type, its own first, then those of its base types. */
export function members(id: string): Member[] {
  const out: Member[] = [];
  const seen = new Set<string>();
  for (let t = typeInfo(id); t; t = t.base ? typeInfo(t.base) : undefined)
    for (const m of t.members)
      if (!seen.has(m.name)) {
        seen.add(m.name);
        out.push(m);
      }
  return out;
}

/** One member of a type (or of its base types). */
export function member(id: string, name: string): Member | undefined {
  for (let t = typeInfo(id); t; t = t.base ? typeInfo(t.base) : undefined) {
    const m = t.members.find((x) => x.name === name);
    if (m) return m;
  }
  return undefined;
}
