#import <UIKit/UIKit.h>

typedef void (^MilagreReturnHandler)(void);

/** Return on a hardware keyboard calls `handler` instead of adding a line; Shift+Return and composing text keep UIKit's. */
BOOL MilagreAttachReturn(UIView *view, MilagreReturnHandler handler);
void MilagreDetachReturn(UIView *view);

/** Key commands every window offers, whatever has focus. Each one posts MilagreShortcutNotification with its id. */
void MilagreSetShortcuts(NSArray<UIKeyCommand *> *commands);
FOUNDATION_EXPORT NSNotificationName const MilagreShortcutNotification;
