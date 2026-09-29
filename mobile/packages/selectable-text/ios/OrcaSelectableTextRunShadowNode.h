#pragma once

#include <react/renderer/components/OrcaSelectableTextSpec/EventEmitters.h>
#include <react/renderer/components/OrcaSelectableTextSpec/Props.h>
#include <react/renderer/components/OrcaSelectableTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char OrcaSelectableTextRunComponentName[];

using OrcaSelectableTextRunShadowNode = ConcreteViewShadowNode<
    OrcaSelectableTextRunComponentName,
    OrcaSelectableTextRunProps,
    OrcaSelectableTextRunEventEmitter,
    OrcaSelectableTextRunState>;
}
