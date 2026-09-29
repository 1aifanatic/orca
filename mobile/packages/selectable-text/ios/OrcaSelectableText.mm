#import "OrcaSelectableText.h"
#import "OrcaSelectableTextShadowNode.h"
#import "OrcaSelectableTextComponentDescriptor.h"
#import "OrcaSelectableTextRun.h"
#import "OrcaSelectableTextAttributedString.h"
#import "OrcaSelectableTextLayoutManager.h"
#import <React/RCTConversions.h>

#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>
#import <react/renderer/components/OrcaSelectableTextSpec/EventEmitters.h>
#import <react/renderer/components/OrcaSelectableTextSpec/Props.h>
#import <react/renderer/components/OrcaSelectableTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"

using namespace facebook::react;

@interface OrcaSelectableText () <RCTOrcaSelectableTextViewProtocol, UIGestureRecognizerDelegate, UITextViewDelegate>

@end

@implementation OrcaSelectableText{
  UIView * _view;
  UITextView * _textView;
  // Layout managers hold their storage weakly; the view owns the TextKit stack.
  NSTextStorage * _textStorage;
  OrcaSelectableTextShadowNode::ConcreteState::Shared _state;
  UITapGestureRecognizer * _outsideTapRecognizer;
  BOOL _suppressSelectionChange;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<OrcaSelectableTextComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const OrcaSelectableTextProps>();
    _props = defaultProps;

    _view = [[UIView alloc] init];
    self.contentView = _view;
    self.clipsToBounds = true;

    _textStorage = [[NSTextStorage alloc] init];
    OrcaSelectableTextLayoutManager *layoutManager = [[OrcaSelectableTextLayoutManager alloc] init];
    [_textStorage addLayoutManager:layoutManager];
    NSTextContainer *textContainer = [[NSTextContainer alloc] initWithSize:CGSizeMake(0, CGFLOAT_MAX)];
    textContainer.widthTracksTextView = YES;
    [layoutManager addTextContainer:textContainer];
    _textView = [[UITextView alloc] initWithFrame:CGRectZero textContainer:textContainer];
    _textView.scrollEnabled = false;
    _textView.editable = false;
    _textView.textContainerInset = UIEdgeInsetsZero;
    _textView.textContainer.lineFragmentPadding = 0;
    _textView.delegate = self;
    // Must match the shadow node, which measures with usesFontLeading = NO.
    _textView.layoutManager.usesFontLeading = NO;
    [self addSubview:_textView];

    const auto longPressGestureRecognizer = [[UILongPressGestureRecognizer alloc] initWithTarget:self
                                                                                          action:@selector(handleLongPressIfNecessary:)];
    longPressGestureRecognizer.delegate = self;

    const auto pressGestureRecognizer = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                                                action:@selector(handlePressIfNecessary:)];
    pressGestureRecognizer.delegate = self;
    [pressGestureRecognizer requireGestureRecognizerToFail:longPressGestureRecognizer];

    [_textView addGestureRecognizer:pressGestureRecognizer];
    [_textView addGestureRecognizer:longPressGestureRecognizer];

    _outsideTapRecognizer = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                                    action:@selector(handleOutsideTap:)];
    _outsideTapRecognizer.cancelsTouchesInView = NO;
    _outsideTapRecognizer.delegate = self;
  }

  return self;
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  [self syncOutsideTapRecognizer];
}

- (void)dealloc
{
  [_outsideTapRecognizer.view removeGestureRecognizer:_outsideTapRecognizer];
}

// See RCTParagraphComponentView
- (void)prepareForRecycle
{
  [super prepareForRecycle];
  _state.reset();

  // Reset the frame to zero so that when it properly lays out on the next use
  _textView.frame = CGRectZero;
  _textView.attributedText = nil;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  // _textView's frame is assigned inside drawRect, which only fires when
  // state changes. Trigger a redraw whenever the host frame moves out from
  // under it (rotation, parent relayout) so the text view resizes and
  // onTextLayout re-fires with the new line wrapping.
  if (!CGRectEqualToRect(_textView.frame, _view.frame)) {
    [self setNeedsDisplay];
  }
}

- (void)drawRect:(CGRect)rect
{
  if (!_state) {
    return;
  }

  const auto &props = *std::static_pointer_cast<OrcaSelectableTextProps const>(_props);

  const auto &stateData = _state->getData();
  const auto convertedAttrString =
      OrcaSelectableTextNSAttributedString(stateData.attributedString, stateData.paragraphStyleRanges);

  // Setting attributedText clears any active text selection, and re-assigning
  // the frame triggers a layout flush that has the same effect. Bail out
  // entirely when nothing actually changed so a JS-side state update made in
  // response to onSelectionChange doesn't deselect what the user is selecting.
  const BOOL textChanged = ![_textView.attributedText isEqualToAttributedString:convertedAttrString];
  const BOOL frameChanged = !CGRectEqualToRect(_textView.frame, _view.frame);
  if (!textChanged && !frameChanged) {
    return;
  }
  if (textChanged) {
    // Reassigning attributedText clears any active selection. Save it and
    // restore after, while suppressing the synthetic textViewDidChangeSelection
    // events the clear-then-restore would otherwise produce — those would
    // round-trip to JS and re-trigger this same path, causing a loop.
    const NSRange savedRange = _textView.selectedRange;
    _suppressSelectionChange = YES;
    _textView.attributedText = convertedAttrString;
    if (savedRange.length > 0 && NSMaxRange(savedRange) <= _textView.attributedText.length) {
      _textView.selectedRange = savedRange;
    }
    _suppressSelectionChange = NO;
  }
  if (frameChanged) {
    _textView.frame = _view.frame;
  }

  __block std::vector<std::string> lines;
  const int maxLines = props.numberOfLines;
  [_textView.layoutManager enumerateLineFragmentsForGlyphRange:NSMakeRange(0, convertedAttrString.string.length) usingBlock:^(CGRect rect,
                                                                                              CGRect usedRect,
                                                                                              NSTextContainer * _Nonnull textContainer,
                                                                                              NSRange glyphRange,
                                                                                              BOOL * _Nonnull stop) {
    const auto charRange = [self->_textView.layoutManager characterRangeForGlyphRange:glyphRange actualGlyphRange:nil];
    const auto line = [self->_textView.text substringWithRange:charRange];
    lines.push_back(line.UTF8String);
    // enumerateLineFragments overshoots maximumNumberOfLines by one on iOS
    // 18, so cap explicitly.
    if (maxLines > 0 && lines.size() >= (size_t)maxLines) {
      *stop = YES;
    }
  }];

  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::OrcaSelectableTextEventEmitter>(_eventEmitter)
    ->onTextLayout(facebook::react::OrcaSelectableTextEventEmitter::OnTextLayout{static_cast<int>(self.tag), lines});
  };
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<OrcaSelectableTextProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<OrcaSelectableTextProps const>(props);

  if (oldViewProps.numberOfLines != newViewProps.numberOfLines) {
    _textView.textContainer.maximumNumberOfLines = newViewProps.numberOfLines;
  }

  if (oldViewProps.selectable != newViewProps.selectable) {
    _textView.selectable = newViewProps.selectable;
  }

  if (oldViewProps.allowFontScaling != newViewProps.allowFontScaling) {
    if (@available(iOS 11.0, *)) {
      _textView.adjustsFontForContentSizeCategory = newViewProps.allowFontScaling;
    }
  }

  if (oldViewProps.ellipsizeMode != newViewProps.ellipsizeMode) {
    if (newViewProps.ellipsizeMode == OrcaSelectableTextEllipsizeMode::Head) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingHead;
    } else if (newViewProps.ellipsizeMode == OrcaSelectableTextEllipsizeMode::Middle) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingMiddle;
    } else if (newViewProps.ellipsizeMode == OrcaSelectableTextEllipsizeMode::Tail) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingTail;
    } else if (newViewProps.ellipsizeMode == OrcaSelectableTextEllipsizeMode::Clip) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByClipping;
    }
  }
  

  // I'm not sure if this is really the right way to handle this style. This means that the entire _view_ the text
  // is in will have this background color applied. To apply it just to a particular part of a string, you'd need
  // to do <Text><Text style={{backgroundColor: 'blue'}}>Hello</Text></Text>.
  // This is how the base <Text> component works though, so we'll go with it for now. Can change later if we want.
  if (oldViewProps.backgroundColor != newViewProps.backgroundColor) {
    _textView.backgroundColor = RCTUIColorFromSharedColor(newViewProps.backgroundColor);
  }

  [super updateProps:props oldProps:oldProps];
}

// See RCTParagraphComponentView
- (void)updateState:(const facebook::react::State::Shared &)state oldState:(const facebook::react::State::Shared &)oldState
{
  _state = std::static_pointer_cast<const OrcaSelectableTextShadowNode::ConcreteState>(state);
  [self setNeedsDisplay];
}

// MARK: - UIGestureRecognizerDelegate

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
  return YES;
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch
{
  if (gestureRecognizer == _outsideTapRecognizer) {
    UIWindow *window = touch.window;
    if (!window) {
      return NO;
    }
    UIView *hitView = [window hitTest:[touch locationInView:nil] withEvent:nil];
    return ![hitView isDescendantOfView:self];
  }
  return YES;
}

- (void)handleOutsideTap:(UITapGestureRecognizer *)sender
{
  // Defer past the current event loop turn so any in-flight edit-menu action
  // (Copy / Define / Look Up / …) reads the live selection before we clear it.
  UITextView *textView = _textView;
  dispatch_async(dispatch_get_main_queue(), ^{
    UITextRange *range = textView.selectedTextRange;
    if (range != nil && !range.isEmpty) {
      textView.selectedTextRange = nil;
    }
  });
}

// MARK: - Touch handling

- (CGPoint)getLocationOfPress:(UIGestureRecognizer*)sender
{
  return [sender locationInView:_textView];
}

- (OrcaSelectableTextRun*)getTouchChild:(CGPoint)location
{
  const auto charIndex = [_textView.layoutManager characterIndexForPoint:location
                                                         inTextContainer:_textView.textContainer
                                fractionOfDistanceBetweenInsertionPoints:nil
  ];

  int currIndex = -1;
  for (UIView* child in self.subviews) {
    if (![child isKindOfClass:[OrcaSelectableTextRun class]]) {
      continue;
    }

    OrcaSelectableTextRun* textChild = (OrcaSelectableTextRun*)child;

    // This is UTF16 code units!!
    currIndex += textChild.text.length;

    if (charIndex <= currIndex) {
      return textChild;
    }
  }

  return nil;
}

- (void)handlePressIfNecessary:(UITapGestureRecognizer*)sender
{
  const auto location = [self getLocationOfPress:sender];
  const auto child = [self getTouchChild:location];

  if (child) {
    [child onPress];
  }
}

- (void)handleLongPressIfNecessary:(UILongPressGestureRecognizer*)sender
{
  const auto location = [self getLocationOfPress:sender];
  const auto child = [self getTouchChild:location];

  if (child) {
    [child onLongPress];
  }
}

// Only a view holding a selection needs outside taps; one window recognizer per
// mounted view makes every touch pay for every view.
- (void)syncOutsideTapRecognizer
{
  UIWindow *window = self.window;
  const NSRange range = _textView.selectedRange;
  const BOOL wants = window != nil && range.location != NSNotFound && range.length > 0;
  if (wants && _outsideTapRecognizer.view != window) {
    [_outsideTapRecognizer.view removeGestureRecognizer:_outsideTapRecognizer];
    [window addGestureRecognizer:_outsideTapRecognizer];
  } else if (!wants && _outsideTapRecognizer.view != nil) {
    [_outsideTapRecognizer.view removeGestureRecognizer:_outsideTapRecognizer];
  }
}

// MARK: - UITextViewDelegate

- (void)textViewDidChangeSelection:(UITextView *)textView
{
  [self syncOutsideTapRecognizer];
  if (_suppressSelectionChange) {
    return;
  }
  if (_eventEmitter == nullptr) {
    return;
  }

  const NSRange selectedRange = textView.selectedRange;
  if (selectedRange.location == NSNotFound) {
    return;
  }

  // Fires on programmatic selection changes too (e.g. the outside-tap clear
  // in handleOutsideTap:), so JS will see a synthetic empty-range event then.
  std::dynamic_pointer_cast<const facebook::react::OrcaSelectableTextEventEmitter>(_eventEmitter)
    ->onSelectionChange(facebook::react::OrcaSelectableTextEventEmitter::OnSelectionChange{
      static_cast<int>(self.tag),
      static_cast<int>(selectedRange.location),
      static_cast<int>(selectedRange.location + selectedRange.length),
    });
}

Class<RCTComponentViewProtocol> OrcaSelectableTextCls(void)
{
  return OrcaSelectableText.class;
}

@end
