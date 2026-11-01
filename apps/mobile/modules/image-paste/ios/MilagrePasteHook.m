#import "MilagrePasteHook.h"
#import <React/RCTUITextView.h>
#import <objc/runtime.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static char handlerKey;

// Only registered RCTUITextViews change behavior. All other inputs use React Native's original methods.
@interface RCTUITextView (MilagrePaste)
- (void)milagre_paste:(id)sender;
- (BOOL)milagre_canPerformAction:(SEL)action withSender:(id)sender;
@end

// An image another app copied (WhatsApp, Files, Photos) is often on the pasteboard as a file or as data its owner hands
// over on request: `hasImages` is true but the synchronous `image` read comes back nil. Those load through the item
// providers, asynchronously, as the system Paste button does. Images that are on the pasteboard as plain data stay on
// the synchronous read. `done` is called once, on the main queue, with nil only when no provider gives an image.
static void loadPastedImage(NSArray<NSItemProvider *> *providers, NSUInteger index, MilagrePasteHandler done)
{
  if (index >= providers.count) {
    done(nil);
    return;
  }
  NSItemProvider *provider = providers[index];
  void (^next)(void) = ^{ loadPastedImage(providers, index + 1, done); };
  if ([provider canLoadObjectOfClass:UIImage.class]) {
    [provider loadObjectOfClass:UIImage.class
              completionHandler:^(id<NSItemProviderReading> object, NSError *error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                  if ([(NSObject *)object isKindOfClass:UIImage.class]) done((UIImage *)object);
                  else next();
                });
              }];
    return;
  }
  if ([provider hasItemConformingToTypeIdentifier:UTTypeImage.identifier]) {
    [provider loadDataRepresentationForTypeIdentifier:UTTypeImage.identifier
                                    completionHandler:^(NSData *data, NSError *error) {
                                      UIImage *image = data ? [UIImage imageWithData:data] : nil;
                                      dispatch_async(dispatch_get_main_queue(), ^{
                                        if (image) done(image);
                                        else next();
                                      });
                                    }];
    return;
  }
  next();
}

@implementation RCTUITextView (MilagrePaste)
- (void)milagre_paste:(id)sender
{
  MilagrePasteHandler handler = objc_getAssociatedObject(self, &handlerKey);
  UIPasteboard *pasteboard = UIPasteboard.generalPasteboard;
  if (handler && self.editable && pasteboard.hasImages) {
    UIImage *image = pasteboard.image;
    if (image) handler(image);
    else loadPastedImage(pasteboard.itemProviders, 0, handler);
    return;
  }
  [self milagre_paste:sender];
}

- (BOOL)milagre_canPerformAction:(SEL)action withSender:(id)sender
{
  if (action == @selector(paste:) && !self.contextMenuHidden && self.editable &&
      objc_getAssociatedObject(self, &handlerKey) && UIPasteboard.generalPasteboard.hasImages) {
    return YES;
  }
  return [self milagre_canPerformAction:action withSender:sender];
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

BOOL MilagreAttachPaste(UIView *view, MilagrePasteHandler handler)
{
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class cls = RCTUITextView.class;
    method_exchangeImplementations(class_getInstanceMethod(cls, @selector(paste:)),
                                   class_getInstanceMethod(cls, @selector(milagre_paste:)));
    method_exchangeImplementations(class_getInstanceMethod(cls, @selector(canPerformAction:withSender:)),
                                   class_getInstanceMethod(cls, @selector(milagre_canPerformAction:withSender:)));
  });
  RCTUITextView *input = findInput(view);
  if (!input) return NO;
  objc_setAssociatedObject(input, &handlerKey, handler, OBJC_ASSOCIATION_COPY_NONATOMIC);
  return YES;
}

void MilagreDetachPaste(UIView *view)
{
  RCTUITextView *input = findInput(view);
  if (input) objc_setAssociatedObject(input, &handlerKey, nil, OBJC_ASSOCIATION_COPY_NONATOMIC);
}
