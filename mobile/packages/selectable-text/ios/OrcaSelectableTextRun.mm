#import "OrcaSelectableTextRun.h"
#import "OrcaSelectableText.h"
#import "OrcaSelectableTextRunComponentDescriptor.h"
#import <react/renderer/components/OrcaSelectableTextSpec/EventEmitters.h>
#import <react/renderer/components/OrcaSelectableTextSpec/Props.h>
#import <react/renderer/components/OrcaSelectableTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"

using namespace facebook::react;

@interface OrcaSelectableTextRun () <RCTOrcaSelectableTextRunViewProtocol>

@end

@implementation OrcaSelectableTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<OrcaSelectableTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const OrcaSelectableTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<OrcaSelectableTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<OrcaSelectableTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::OrcaSelectableTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::OrcaSelectableTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::OrcaSelectableTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::OrcaSelectableTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> OrcaSelectableTextRunCls(void)
{
    return OrcaSelectableTextRun.class;
}

@end
