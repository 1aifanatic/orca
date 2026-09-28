import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Clock, RotateCcw } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'

export type MobileNativeChatQueuedMessagesProps = {
  cards?: MobileQueuedMessageCard[]
  /** Steer for a waiting card; plain Send for a paused or returned one. */
  onSend?: (messageId: string) => Promise<boolean>
  onDelete?: (messageId: string) => Promise<boolean>
  /** Copy the card's text into the composer, then delete the card. */
  onEdit?: (messageId: string) => Promise<boolean>
}

/** The host-held queued drafts, as editable cards between transcript and
 *  composer — a queued message is never an optimistic transcript bubble. */
export function MobileNativeChatQueuedMessages({
  cards,
  onSend,
  onDelete,
  onEdit
}: MobileNativeChatQueuedMessagesProps): React.JSX.Element | null {
  // One in-flight action per card; a second tap must not double-consume. The ref
  // closes the same-frame double tap the disabled state cannot.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const inFlightRef = useRef(new Set<string>())
  if (!cards || cards.length === 0) {
    return null
  }
  const run = async (messageId: string, action?: (id: string) => Promise<boolean>) => {
    if (inFlightRef.current.has(messageId) || !action) {
      return
    }
    inFlightRef.current.add(messageId)
    setBusyIds(new Set(inFlightRef.current))
    try {
      await action(messageId)
    } finally {
      inFlightRef.current.delete(messageId)
      setBusyIds(new Set(inFlightRef.current))
    }
  }
  return (
    <View style={styles.list}>
      {cards.map((card) => {
        const busy = busyIds.has(card.messageId)
        const returned = card.state === 'returned'
        // "Steer" names jumping the running turn; a paused or returned card waits on none.
        const sendLabel = returned || card.paused ? 'Send' : 'Steer'
        return (
          <View key={card.messageId} style={[styles.card, returned && styles.cardReturned]}>
            <View style={styles.header}>
              {returned ? (
                <RotateCcw size={13} color={colors.statusAmber} strokeWidth={2.2} />
              ) : (
                <Clock size={13} color={colors.textMuted} strokeWidth={2.2} />
              )}
              <Text style={styles.label} numberOfLines={1}>
                {card.label}
              </Text>
            </View>
            <Text style={styles.body} numberOfLines={4}>
              {card.text}
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                accessibilityLabel={
                  returned
                    ? 'Send this message again'
                    : card.paused
                      ? 'Send this message'
                      : 'Send now without waiting for the turn to end'
                }
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                disabled={busy}
                onPress={() => void run(card.messageId, onSend)}
              >
                <Text style={styles.actionLabel}>{sendLabel}</Text>
              </Pressable>
              {/* A returned card most needs Edit: its text is what has to change. */}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                accessibilityLabel="Edit this queued message"
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                disabled={busy}
                onPress={() => void run(card.messageId, onEdit)}
              >
                <Text style={styles.actionLabel}>Edit</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                accessibilityLabel="Delete this queued message"
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                disabled={busy}
                onPress={() => void run(card.messageId, onDelete)}
              >
                <Text style={[styles.actionLabel, styles.deleteLabel]}>Delete</Text>
              </Pressable>
            </View>
          </View>
        )
      })}
    </View>
  )
}

// Actions draw as a 32pt text row but touch as 44pt targets (platform floor); the
// row's negative margins give back the padding, and half-gap insets never overlap.
const MIN_TOUCH_TARGET = 44
const ACTION_ROW_HEIGHT = 32
const ACTION_TARGET_INSET_VERTICAL = (MIN_TOUCH_TARGET - ACTION_ROW_HEIGHT) / 2
const ACTION_TARGET_INSET_HORIZONTAL = spacing.md / 2

const styles = StyleSheet.create({
  list: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    gap: spacing.xs
  },
  card: {
    padding: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  cardReturned: {
    borderColor: colors.statusAmber
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  label: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  body: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    lineHeight: typography.bodySize + 6
  },
  actions: {
    flexDirection: 'row',
    marginTop: 2 - ACTION_TARGET_INSET_VERTICAL,
    marginBottom: -ACTION_TARGET_INSET_VERTICAL,
    marginHorizontal: -ACTION_TARGET_INSET_HORIZONTAL
  },
  action: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: ACTION_TARGET_INSET_HORIZONTAL,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionLabel: {
    color: colors.accentBlue,
    fontSize: typography.bodySize - 1,
    fontWeight: '600'
  },
  deleteLabel: {
    color: colors.textMuted
  },
  pressed: {
    opacity: 0.6
  }
})
