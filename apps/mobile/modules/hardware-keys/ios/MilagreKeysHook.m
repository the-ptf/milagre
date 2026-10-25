#import "MilagreKeysHook.h"
#import <React/RCTUITextView.h>
#import <objc/runtime.h>

NSNotificationName const MilagreShortcutNotification = @"MilagreShortcutNotification";

static char handlerKey;
static NSArray<UIKeyCommand *> *shortcuts;

// Swaps a method on `cls` alone: one only inherited is copied onto `cls` first, so superclasses keep theirs.
static void swizzle(Class cls, SEL original, SEL replacement)
{
  Method originalMethod = class_getInstanceMethod(cls, original);
  Method replacementMethod = class_getInstanceMethod(cls, replacement);
  if (class_addMethod(cls, original, method_getImplementation(replacementMethod), method_getTypeEncoding(replacementMethod))) {
    class_replaceMethod(cls, replacement, method_getImplementation(originalMethod), method_getTypeEncoding(originalMethod));
  } else {
    method_exchangeImplementations(originalMethod, replacementMethod);
  }
}

// Plain Return or keypad Enter on a registered input, outside an input method's composition.
static BOOL isPlainReturn(UITextView *view, NSSet<UIPress *> *presses)
{
  if (!objc_getAssociatedObject(view, &handlerKey) || view.markedTextRange) return NO;
  for (UIPress *press in presses) {
    UIKey *key = press.key;
    if (!key) continue;
    if (key.keyCode != UIKeyboardHIDUsageKeyboardReturnOrEnter && key.keyCode != UIKeyboardHIDUsageKeypadEnter) continue;
    UIKeyModifierFlags modifiers = UIKeyModifierShift | UIKeyModifierAlternate | UIKeyModifierControl | UIKeyModifierCommand;
    return (key.modifierFlags & modifiers) == 0;
  }
  return NO;
}

@interface RCTUITextView (MilagreKeys)
- (void)milagre_pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event;
- (void)milagre_pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event;
@end

@implementation RCTUITextView (MilagreKeys)
- (void)milagre_pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event
{
  if (isPlainReturn(self, presses)) {
    MilagreReturnHandler handler = objc_getAssociatedObject(self, &handlerKey);
    handler();
    return;
  }
  [self milagre_pressesBegan:presses withEvent:event];
}

- (void)milagre_pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event
{
  if (isPlainReturn(self, presses)) return;
  [self milagre_pressesEnded:presses withEvent:event];
}
@end

@interface UIWindow (MilagreKeys)
- (NSArray<UIKeyCommand *> *)milagre_keyCommands;
@end

@implementation UIWindow (MilagreKeys)
- (NSArray<UIKeyCommand *> *)milagre_keyCommands
{
  NSArray<UIKeyCommand *> *own = [self milagre_keyCommands];
  if (!shortcuts.count) return own;
  return own.count ? [own arrayByAddingObjectsFromArray:shortcuts] : shortcuts;
}
@end

// Every responder answers a shortcut, so it works from the focused composer and with nothing focused alike.
@interface UIResponder (MilagreKeys)
- (void)milagre_shortcut:(UIKeyCommand *)command;
@end

@implementation UIResponder (MilagreKeys)
- (void)milagre_shortcut:(UIKeyCommand *)command
{
  if (![command.propertyList isKindOfClass:NSString.class]) return;
  [NSNotificationCenter.defaultCenter postNotificationName:MilagreShortcutNotification object:nil userInfo:@{@"id" : command.propertyList}];
}
@end

static RCTUITextView *findInput(UIView *view)
{
  if ([view isKindOfClass:RCTUITextView.class]) return (RCTUITextView *)view;
  for (UIView *child in view.subviews) {
    RCTUITextView *input = findInput(child);
    if (input) return input;
  }
  return nil;
}

BOOL MilagreAttachReturn(UIView *view, MilagreReturnHandler handler)
{
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    swizzle(RCTUITextView.class, @selector(pressesBegan:withEvent:), @selector(milagre_pressesBegan:withEvent:));
    swizzle(RCTUITextView.class, @selector(pressesEnded:withEvent:), @selector(milagre_pressesEnded:withEvent:));
  });
  RCTUITextView *input = findInput(view);
  if (!input) return NO;
  objc_setAssociatedObject(input, &handlerKey, handler, OBJC_ASSOCIATION_COPY_NONATOMIC);
  return YES;
}

void MilagreDetachReturn(UIView *view)
{
  RCTUITextView *input = findInput(view);
  if (input) objc_setAssociatedObject(input, &handlerKey, nil, OBJC_ASSOCIATION_COPY_NONATOMIC);
}

void MilagreSetShortcuts(NSArray<UIKeyCommand *> *commands)
{
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    swizzle(UIWindow.class, @selector(keyCommands), @selector(milagre_keyCommands));
  });
  shortcuts = [commands copy];
}
