import { Pressable, StyleSheet } from 'react-native'
import { ChevronDown, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'

/** A prompt card's header action: Cancel where the lane can cancel, else a Hide that writes nothing. */
export function MobileNativeChatCardHeaderAction<Prompt>({
  prompt,
  onCancel,
  onHide,
  disabled
}: {
  prompt?: Prompt
  onCancel?: (prompt?: Prompt) => Promise<boolean>
  onHide?: () => void
  disabled?: boolean
}): React.JSX.Element | null {
  if (!onCancel && !onHide) {
    return null
  }
  const Icon = onCancel ? X : ChevronDown
  return (
    <Pressable
      accessibilityLabel={onCancel ? 'Cancel' : 'Hide'}
      hitSlop={8}
      style={styles.action}
      onPress={() => (onCancel ? void onCancel(prompt) : onHide?.())}
      disabled={disabled}
    >
      <Icon size={16} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  action: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }
})
