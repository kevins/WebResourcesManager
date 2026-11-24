// The pop-up layers of the workbench, mounted once at its root: notifications, the context menu, the quick input and
// the modal dialog, in that order from bottom to top (as VS Code stacks them). Each reads its service's state.
// Mounting it also writes the codicon glyph rules (codicons.ts), before the first frame is drawn.

import { useLayoutEffect } from 'preact/hooks';
import { installCodiconStyles } from './codicons';
import { DialogLayer } from './dialog';
import { MenuLayer } from './menu';
import { NotificationsLayer } from './notify';
import { QuickInputLayer } from './quickinput';

export function Layers() {
  useLayoutEffect(() => installCodiconStyles(), []);
  return (
    <>
      <NotificationsLayer />
      <MenuLayer />
      <QuickInputLayer />
      <DialogLayer />
    </>
  );
}
