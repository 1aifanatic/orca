import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Clock, RotateCcw } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  mobileQueuePauseLabel,
  type MobileQueuedMessageCard
} from './mobile-structured-queued-message-cards'
import type { MobileQueuePause } from './mobile-structured-queued-message-feed'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'

/** The Resume row's in-flight key beside the cards' message ids, which never contain NUL. */
const RESUME_KEY = '\u0000resume'

export type MobileNativeChatQueuedMessagesProps = {
  cards?: MobileQueuedMessageCard[]
  /** Steer for a waiting card, the paused queue's included; plain Send for a card whose own send
   *  failed, or a returned one. */
  onSend?: (messageId: string) => Promise<boolean>
  onDelete?: (messageId: string) => Promise<boolean>
  /** Copy the card's text into the composer, then delete the card. */
  onEdit?: MobileQueuedMessageEdit
  /** The whole queue's pause: a header row above the cards, with Resume. */
  pause?: MobileQueuePause
  onResume?: () => Promise<boolean>
}

/** The host-held queued drafts, as editable cards between transcript and
 *  composer — a queued message is never an optimistic transcript bubble. */
export function MobileNativeChatQueuedMessages({
  cards,
  onSend,
  onDelete,
  onEdit,
  pause,
  onResume
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
  const resuming = busyIds.has(RESUME_KEY)
  return (
    <View style={styles.list}>
      {pause ? (
        // A polite region, as the app's other notices: React Native has no status role.
        <View testID="queued-pause-row" style={styles.pauseRow} accessibilityLiveRegion="polite">
          <Text style={styles.pauseLabel}>{mobileQueuePauseLabel(pause)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: resuming }}
            accessibilityLabel="Resume sending the queued messages"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            disabled={resuming}
            onPress={() => void run(RESUME_KEY, onResume && (() => onResume()))}
          >
            <Text style={styles.actionLabel}>Resume</Text>
          </Pressable>
        </View>
      ) : null}
      {cards.map((card) => {
        const busy = busyIds.has(card.messageId)
        const returned = card.state === 'returned'
        // "Steer" submits beside the running turn, the paused queue's cards too; a card whose own
        // send failed, or a returned one, is sent again.
        const sendLabel = returned || card.paused ? 'Send' : 'Steer'
        return (
          <View key={card.messageId} style={[styles.card, returned && styles.cardReturned]}>
            <View style={styles.header}>
              {returned ? (
                <RotateCcw size={13} color={colors.statusAmber} strokeWidth={2.2} />
              ) : (
                <Clock size={13} color={colors.textMuted} strokeWidth={2.2} />
              )}
              {/* A returned card's reason only reads whole, often at its end; a hold is one line. */}
              <Text style={styles.label} numberOfLines={returned ? undefined : 1}>
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
                      : 'Submit without interrupting the model'
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
  // No negative margins: the row tops a list with no padding, and Android drops touches outside
  // the parent, so Resume's whole 44pt target has to sit inside the row.
  pauseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  pauseLabel: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
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
