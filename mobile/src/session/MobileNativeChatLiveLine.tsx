import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { nativeChatReasoningDisclosureKey } from '../../../src/shared/native-chat-reasoning-row'
import { deriveNativeChatRowContent } from '../../../src/shared/native-chat-row-content'
import { formatNativeChatActiveTurnLabel } from '../../../src/shared/native-chat-turn-status'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileNativeChatReasoningBody } from './MobileNativeChatReasoningRow'
import { MobileNativeChatTurnActivity } from './MobileNativeChatTurnStatus'
import type { MobileNativeChatLiveLine as LiveLine } from './use-mobile-native-chat-turn-disclosure'

/** The live turn's tail line. While the agent's open reasoning block has text it is also that
 *  block's disclosure, and the block's row draws nothing. Desktop parity: `NativeChatTurnActivityLine`. */
export function MobileNativeChatLiveLine({
  line,
  onToggleReasoning,
  fontScale,
  onOpenFile
}: {
  line: LiveLine
  onToggleReasoning: (key: string) => void
  fontScale: number
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const { reasoning, reasoningExpanded: open } = line
  if (!reasoning) {
    return (
      <MobileNativeChatTurnActivity thinking={line.thinking} activityText={line.activityText} />
    )
  }
  const label = formatNativeChatActiveTurnLabel(line)
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        // The finished row reads this key too, so a block opened here lands open once it ends.
        onPress={() => onToggleReasoning(nativeChatReasoningDisclosureKey(reasoning.id))}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        // Only the line is live: the streaming body below would be re-announced on every frame.
        accessibilityLiveRegion="polite"
      >
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <View style={open ? styles.caretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.body}>
          <MobileNativeChatReasoningBody
            markdown={deriveNativeChatRowContent(reasoning.blocks).markdown}
            fontScale={fontScale}
            onOpenFile={onOpenFile}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  // Matches `MobileNativeChatTurnActivity`'s row, so the line does not move when it turns expandable.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 28,
    paddingHorizontal: spacing.md
  },
  pressed: {
    opacity: 0.6
  },
  label: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  },
  body: {
    paddingHorizontal: spacing.md
  }
})
