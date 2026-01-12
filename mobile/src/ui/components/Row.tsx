import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/colors';

export function Row(props: { title: string; subtitle?: string | null; right?: ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.title} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.right ? <View style={styles.right}>{props.right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  left: { flex: 1 },
  right: {},
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  subtitle: { marginTop: 6, color: colors.subtext, fontSize: 12 },
});
