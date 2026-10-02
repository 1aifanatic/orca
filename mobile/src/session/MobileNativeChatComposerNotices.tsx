import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

/** The lines above the composer: why the host keeps this chat read-only, said before any send,
 *  and the latest send failure. */
export function MobileNativeChatComposerNotices({
  readOnlyNotice,
  sendErrorMessage
}: {
  readOnlyNotice: string | null
  sendErrorMessage: string | null | undefined
}): React.JSX.Element {
  return (
    <>
      {readOnlyNotice ? (
        <View style={styles.notice} accessibilityRole="text" accessibilityLiveRegion="polite">
          <Text style={styles.readOnlyText}>{readOnlyNotice}</Text>
        </View>
      ) : null}
      {sendErrorMessage ? (
        // This banner is the only channel for a send failure — announce it.
        <View style={styles.notice} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text style={styles.sendErrorText}>{sendErrorMessage}</Text>
        </View>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  notice: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  readOnlyText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center'
  },
  sendErrorText: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
})
