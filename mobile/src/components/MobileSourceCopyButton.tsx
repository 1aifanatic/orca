import { useLayoutEffect, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text } from 'react-native'
import { Check, Copy } from 'lucide-react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function MobileSourceCopyButton({
  text,
  accessibilityLabel,
  partial = false
}: {
  text: string
  accessibilityLabel: string
  partial?: boolean
}): React.JSX.Element {
  const clipboard = useClipboardWriter()
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const latestAttempt = useRef<{ sourceVersion: number } | null>(null)
  const sourceVersion = useRef(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  if (copiedText !== null && copiedText !== text) {
    setCopiedText(null)
  }
  useLayoutEffect(
    () => () => {
      latestAttempt.current = null
    },
    []
  )
  // Streaming invalidates success feedback, while the pending user action still owns failures.
  useLayoutEffect(() => {
    sourceVersion.current++
    return () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current)
        resetTimer.current = null
      }
    }
  }, [text])

  const copy = async () => {
    if (text.length === 0) {
      return
    }
    const attempt = { sourceVersion: sourceVersion.current }
    latestAttempt.current = attempt
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
    setCopiedText(null)
    try {
      await clipboard.writeText(text)
    } catch (error) {
      if (latestAttempt.current !== attempt) {
        return
      }
      Alert.alert(
        'Copy failed',
        error instanceof Error ? error.message : 'The clipboard rejected the text.'
      )
      return
    }
    if (latestAttempt.current !== attempt || sourceVersion.current !== attempt.sourceVersion) {
      return
    }
    setCopiedText(text)
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null
      if (latestAttempt.current === attempt) {
        setCopiedText(null)
      }
    }, 1500)
  }
  const copied = copiedText === text
  const label = copied ? (partial ? 'Copied loaded' : 'Copied') : partial ? 'Copy loaded' : 'Copy'
  const Icon = copied ? Check : Copy
  return (
    <Pressable
      style={({ pressed }) => [styles.button, partial && styles.partial, pressed && styles.pressed]}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: copied ? label : undefined }}
      accessibilityState={{ disabled: text.length === 0 }}
      disabled={text.length === 0}
      onPress={() => void copy()}
    >
      <Icon size={14} color={colors.textSecondary} />
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    width: 84,
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button
  },
  partial: { width: 128 },
  pressed: { backgroundColor: colors.bgRaised },
  label: { color: colors.textSecondary, fontSize: typography.metaSize }
})
